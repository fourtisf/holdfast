/**
 * getUpdates long-poll loop. The offset is stored in tg_state after each update, and every update
 * we act on is claimed in tg_sent (`update:<id>`) first, so an update Telegram delivers again after
 * a restart is neither executed nor answered twice.
 *
 * Updates are handled one at a time, so nothing in here may wait for one chat: each chat gets a reply
 * budget (under Telegram's own per-chat limits), a reply Telegram refuses with a flood wait is dropped at
 * once rather than waited out, and a stop request ends the batch at the next update.
 */
import { getTelegramOffset, markSent, moveTelegramChat, removeBuybot, removeChatSubscriptions, setTelegramOffset, type Queryable } from "@holdfast/db";

import { COMMAND_NAMES, follow, handleText, isAdmin, parseCommand, runCommand, type CommandContext, type CommandSource } from "./commands.js";
import { SlidingWindowLimit } from "./launch.js";
import { MENU, NOT_REACHABLE, type BotReply } from "./messages.js";
import { sleep, TelegramError, type TelegramApi, type TgCallbackQuery, type TgChat, type TgChatMemberUpdated, type TgMessage, type TgUpdate } from "./telegram.js";

interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Menu buttons ("m:<name>") may only run these commands; anything else is just answered. */
const MENU_COMMANDS: ReadonlySet<string> = new Set(["launch", "trending", "burns", "help"]);
const CHANNEL_TOAST = "Buttons don't work in channels. Open me in a private chat to use them.";
const FOLLOW_ADMINS_TOAST = "Only group admins can turn on alerts here. Open me in a private chat to follow it yourself.";
const SLOW_DOWN_TOAST = "That is a lot at once. Please wait a moment and try again.";

/**
 * Replies per chat, under Telegram's limits for a bot: about 20 messages a minute in a group and about
 * one a second in a private chat. A private chat gets well under that: at most PRIVATE_REPLY_BURST replies
 * in any PRIVATE_BURST_WINDOW_MS and PRIVATE_REPLIES_PER_MINUTE a minute, since a reply Telegram refuses
 * with a flood wait is lost, and the chat's alerts have to wait too. Over the budget an update is not
 * answered at all. Only updates the bot answers count: in a group, other bots' commands are ignored before the budget.
 */
export const GROUP_REPLIES_PER_MINUTE = 20;
export const PRIVATE_REPLIES_PER_MINUTE = 20;
export const PRIVATE_REPLY_BURST = 3;
export const PRIVATE_BURST_WINDOW_MS = 3_000;

/** The forum topic a message was sent in, for the reply. */
function threadOf(msg: TgMessage | undefined): number | undefined {
  return msg?.is_topic_message && msg.message_thread_id !== undefined ? msg.message_thread_id : undefined;
}

export interface BotMetrics {
  pollDone(): Promise<void>;
  pollFailed(err: unknown): Promise<void>;
  command(name: string): void;
  error(source: string): void;
}

export interface BotDeps {
  db: Queryable;
  tg: TelegramApi;
  commands: CommandContext;
  /** From getMe: commands addressed to another bot (`/watch@OtherBot`) are ignored. */
  botUsername?: string | null;
  pollTimeoutSec: number;
  /** Reply budget of a private chat (NOTIFIER_PRIVATE_REPLIES_PER_MINUTE / _BURST); default the constants above. */
  privateReplies?: { perMinute: number; burst: number };
  metrics?: BotMetrics;
  log?: Logger;
}

export class Bot {
  private readonly groupReplies = new SlidingWindowLimit(GROUP_REPLIES_PER_MINUTE, 60_000);
  private readonly privateReplies: SlidingWindowLimit;
  private readonly privateBurst: SlidingWindowLimit;

  constructor(private readonly deps: BotDeps) {
    const limits = deps.privateReplies ?? { perMinute: PRIVATE_REPLIES_PER_MINUTE, burst: PRIVATE_REPLY_BURST };
    this.privateReplies = new SlidingWindowLimit(limits.perMinute, 60_000);
    this.privateBurst = new SlidingWindowLimit(limits.burst, PRIVATE_BURST_WINDOW_MS);
  }

  /**
   * One getUpdates call and its updates. Returns how many updates were processed. Once `signal` aborts,
   * the rest of the batch is left alone: neither claimed nor acknowledged, Telegram delivers it again.
   */
  async pollOnce(signal?: AbortSignal): Promise<number> {
    const { db, tg } = this.deps;
    const offset = await getTelegramOffset(db);
    const updates = await tg.getUpdates({ offset, timeoutSec: this.deps.pollTimeoutSec, signal });
    let handled = 0;
    for (const u of updates) {
      if (signal?.aborted) break;
      try {
        await this.handleUpdate(u);
      } catch (err) {
        this.deps.metrics?.error("update");
        this.deps.log?.error({ updateId: u.update_id, err: err instanceof Error ? err.message : String(err) }, "update failed");
      }
      await setTelegramOffset(db, u.update_id + 1);
      handled++;
    }
    await this.deps.metrics?.pollDone();
    return handled;
  }

  /** Takes one reply from the chat's budget; false when the chat is over it (the update is not answered). */
  private withinBudget(chat: Pick<TgChat, "id" | "type">): boolean {
    const now = this.deps.commands.now();
    if (chat.type === "private" ? this.takePrivateReply(chat.id, now) : this.groupReplies.take(chat.id, now)) return true;
    this.deps.metrics?.command("over_limit");
    this.deps.log?.debug({ chatId: chat.id }, "chat over its reply budget; update not answered");
    return false;
  }

  /** Both private budgets (the burst and the minute) or neither. */
  private takePrivateReply(chatId: number, now: number): boolean {
    if (!this.privateBurst.take(chatId, now)) return false;
    if (this.privateReplies.take(chatId, now)) return true;
    this.privateBurst.release(chatId);
    return false;
  }

  async handleUpdate(u: TgUpdate): Promise<void> {
    if (u.callback_query) return this.handleCallback(u.update_id, u.callback_query);
    if (u.my_chat_member) return this.handleMembership(u.update_id, u.my_chat_member);
    const msg = u.message ?? u.channel_post;
    if (!msg) return;
    const { chat } = msg;
    // A basic group became a supergroup (service message in the old group): its buy bot and alerts move to the new id.
    if (msg.migrate_to_chat_id !== undefined && chat.type === "group") return this.migrated(chat.id, msg.migrate_to_chat_id);
    const isPrivate = chat.type === "private";
    const body = msg.text ?? msg.caption ?? "";
    const cmd = body === "" ? null : parseCommand(body, this.deps.botUsername);
    const isCommand = cmd !== null;
    // Group chats see other people's messages and other bots' commands (/price): only this bot's commands are worth a claim.
    if (!isPrivate && (!cmd || !COMMAND_NAMES.has(cmd.name))) return;
    if (!msg.text && !isPrivate) return;
    if (!this.withinBudget(chat)) return;
    if (!(await markSent(this.deps.db, chat.id, `update:${u.update_id}`))) return;
    const threadId = threadOf(msg);
    await this.respond(chat.id, threadId, async () => {
      const { launch } = this.deps.commands;
      // In a private chat, anything that is not a command answers the launch question being asked.
      if (isPrivate && !isCommand && launch && (await launch.active(chat.id))) {
        const reply = await launch.onMessage(chat.id, msg);
        if (reply) {
          this.deps.metrics?.command("launch_step");
          return reply;
        }
      }
      if (!msg.text && !isCommand) return isPrivate ? { html: "Hi! What do you want to do? Send /help to see every command.", buttons: MENU } : null;
      const result = await handleText(this.deps.commands, { chat, from: msg.from, threadId }, body, this.deps.botUsername);
      if (!result) return null;
      this.deps.metrics?.command(result.command);
      return result.reply;
    });
  }

  /**
   * Runs one claimed update and sends its reply. When the work itself fails (the API is down, a database
   * error), the user still gets an answer; the error is passed on to be logged.
   */
  private async respond(chatId: number, threadId: number | undefined, work: () => Promise<BotReply | null>): Promise<void> {
    let reply: BotReply | null;
    try {
      reply = await work();
    } catch (err) {
      await this.reply(chatId, { html: NOT_REACHABLE }, { threadId }).catch(() => {});
      throw err;
    }
    if (reply) await this.reply(chatId, reply, { threadId });
  }

  /**
   * A pressed inline button: "l:..." launch steps (private chat), "m:<name>" menu items (MENU_COMMANDS
   * only), "f:<mint>" alerts for a coin (group admins only in a group). Every subscriber of a channel can
   * press the buttons of its posts, so in a channel a button only gets a toast.
   */
  private async handleCallback(updateId: number, q: TgCallbackQuery): Promise<void> {
    const chat = q.message?.chat;
    const data = q.data ?? "";
    const answer = (toast?: string) => this.deps.tg.answerCallback(q.id, toast).catch(() => {});
    if (!chat) return answer();
    if (chat.type === "channel") return answer(CHANNEL_TOAST);
    const ctx = this.deps.commands;
    const threadId = threadOf(q.message);
    const src: CommandSource = { chat, from: q.from, threadId };
    if (data.startsWith("f:") && chat.type !== "private" && !(await isAdmin(ctx, src))) return answer(FOLLOW_ADMINS_TOAST);
    if (!this.withinBudget(chat)) return answer(SLOW_DOWN_TOAST);
    await answer();
    if (!(await markSent(this.deps.db, chat.id, `update:${updateId}`))) return;
    await this.respond(chat.id, threadId, async () => {
      if (data.startsWith("l:")) {
        if (chat.type !== "private" || !ctx.launch) return null;
        this.deps.metrics?.command("launch_step");
        return ctx.launch.onButton(chat.id, q.from.id, data);
      }
      if (data.startsWith("m:")) {
        const name = data.slice(2);
        if (!MENU_COMMANDS.has(name)) return null;
        this.deps.metrics?.command(name);
        return runCommand(ctx, src, { name, args: [] });
      }
      if (data.startsWith("f:")) {
        this.deps.metrics?.command("follow");
        return { html: await follow(ctx, chat.id, data.slice(2), threadId) };
      }
      return null;
    });
  }

  /**
   * Added to a group: say what the bot does there. Banned, blocked or muted (no right to send messages):
   * the chat's alerts and buy bot go, since nothing could be delivered there any more. ("left" is not
   * acted on: a group's alerts must survive its upgrade to a supergroup; a later send finds out anyway.)
   */
  private async handleMembership(updateId: number, m: TgChatMemberUpdated): Promise<void> {
    const member = m.new_chat_member;
    const gone = member.status === "kicked" || (member.status === "restricted" && member.can_send_messages === false);
    if (gone) {
      const removed = await removeChatSubscriptions(this.deps.db, m.chat.id);
      const buybot = await removeBuybot(this.deps.db, m.chat.id);
      if (removed > 0 || buybot) this.deps.log?.info({ chatId: m.chat.id, status: member.status, removed, buybot }, "bot banned or muted in a chat; its alerts were removed");
      return;
    }
    const joined = ["member", "administrator"].includes(member.status) && ["left", "kicked"].includes(m.old_chat_member.status);
    if (!joined || m.chat.type === "private" || m.chat.type === "channel") return;
    if (!this.withinBudget(m.chat)) return;
    if (!(await markSent(this.deps.db, m.chat.id, `update:${updateId}`))) return;
    await this.reply(m.chat.id, {
      html: [
        "👋 <b>Thanks for adding Moatpad Bot!</b>",
        "",
        "To post every buy of your coin here, an admin sends:",
        "<code>/buybot &lt;coin address&gt;</code>",
        "",
        "Send /help to see everything I can do.",
      ].join("\n"),
    });
  }

  /** The group `from` is now the supergroup `to`: everything the bot keeps for it follows. */
  private async migrated(from: number, to: number): Promise<void> {
    await moveTelegramChat(this.deps.db, from, to);
    this.deps.log?.info({ from, to }, "group became a supergroup; its buy bot and alerts moved");
  }

  private async reply(chatId: number, r: BotReply, opts: { threadId?: number; followMigration?: boolean } = {}): Promise<void> {
    try {
      // Never waits out a flood wait, however short: every other chat's update would wait behind it.
      await this.deps.tg.sendMessage(chatId, r.html, { buttons: r.buttons, preview: r.preview, threadId: opts.threadId, noWait: true });
    } catch (err) {
      // Blocked, removed or muted, the group locked for now, or the topic of the command was closed meanwhile: nobody to answer.
      if (err instanceof TelegramError && (err.chatUnavailable || err.noRights || err.topicClosed)) return;
      // Flood wait (thrown at once with noWait): the reply is dropped rather than waited for.
      if (err instanceof TelegramError && err.flooded) {
        this.deps.log?.debug({ chatId, retryAfterSec: err.retryAfterSec }, "reply dropped: the chat is in a Telegram flood wait");
        return;
      }
      // Answered in a group that just became a supergroup: move it, then answer once at the new id (a basic group has no topics).
      if (err instanceof TelegramError && err.migrateToChatId !== undefined && opts.followMigration !== false) {
        await this.migrated(chatId, err.migrateToChatId);
        return this.reply(err.migrateToChatId, r, { followMigration: false });
      }
      throw err;
    }
  }

  /**
   * Polls until `signal` aborts, backing off (1 s doubling to 60 s, or as long as a flood wait asks)
   * while Telegram is unreachable.
   */
  async run(signal: AbortSignal): Promise<void> {
    let backoffMs = 1_000;
    while (!signal.aborted) {
      try {
        await this.pollOnce(signal);
        backoffMs = 1_000;
      } catch (err) {
        if (signal.aborted) break;
        await this.deps.metrics?.pollFailed(err);
        const floodMs = err instanceof TelegramError && err.flooded ? (err.retryAfterSec ?? 0) * 1000 : 0;
        await sleep(Math.max(backoffMs, floodMs), signal);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  }
}

/** Runs tasks one at a time, in order (events, milestone sweeps): sends stay ordered and PGlite stays happy. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private stopped = false;

  constructor(private readonly onError: (err: unknown) => void) {}

  push(task: () => Promise<unknown>): void {
    this.pending++;
    this.tail = this.tail
      .then(() => (this.stopped ? undefined : task()))
      .then(
        () => undefined,
        (err: unknown) => this.onError(err),
      )
      .finally(() => {
        this.pending--;
      });
  }

  get size(): number {
    return this.pending;
  }

  /** Resolves once everything pushed so far has run (or was dropped by `stop`). */
  idle(): Promise<void> {
    return this.tail;
  }

  /** Shutdown: the task running now finishes, tasks not started yet are dropped, and so is anything pushed later. */
  stop(): void {
    this.stopped = true;
  }
}

/**
 * Shutdown deadline: the container is killed 30 s after SIGTERM (docker's stop_grace_period), and what is
 * left after this long is given up so the database and the ops server still close cleanly.
 */
export const SHUTDOWN_DEADLINE_MS = 20_000;

/**
 * Shutdown, once the stop signal has aborted: the queue starts no new task, then the poll in progress and the
 * task running now get until `deadlineMs` to finish. False when the deadline passed first (logged by the caller).
 */
export function drainForShutdown(polling: Promise<void>, queue: SerialQueue, deadlineMs = SHUTDOWN_DEADLINE_MS): Promise<boolean> {
  queue.stop();
  return settlesWithin(Promise.all([polling, queue.idle()]), deadlineMs);
}

/** Whether `work` settles within `ms` (it is not cancelled either way). */
async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    const settled = work.then(
      () => true,
      () => true,
    );
    return await Promise.race([settled, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
