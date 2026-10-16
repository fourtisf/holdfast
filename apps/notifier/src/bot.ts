/**
 * getUpdates long-poll loop. The offset is stored in tg_state after each update, and every update
 * we act on is claimed in tg_sent (`update:<id>`) first, so an update Telegram delivers again after
 * a restart is neither executed nor answered twice.
 */
import { getTelegramOffset, markSent, moveTelegramChat, setTelegramOffset, type Queryable } from "@holdfast/db";

import { follow, handleText, isAdmin, parseCommand, runCommand, type CommandContext } from "./commands.js";
import { MENU, type BotReply } from "./messages.js";
import { sleep, TelegramError, type TelegramApi, type TgCallbackQuery, type TgChatMemberUpdated, type TgUpdate } from "./telegram.js";

interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Menu buttons ("m:<name>") may only run these commands; anything else is just answered. */
const MENU_COMMANDS: ReadonlySet<string> = new Set(["launch", "trending", "burns", "help"]);
const CHANNEL_TOAST = "Buttons don't work in channels. Open me in a private chat to use them.";
const FOLLOW_ADMINS_TOAST = "Only group admins can turn on alerts here. Open me in a private chat to follow it yourself.";

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
  metrics?: BotMetrics;
  log?: Logger;
}

export class Bot {
  constructor(private readonly deps: BotDeps) {}

  /** One getUpdates call and its updates. Returns how many updates were processed. */
  async pollOnce(signal?: AbortSignal): Promise<number> {
    const { db, tg } = this.deps;
    const offset = await getTelegramOffset(db);
    const updates = await tg.getUpdates({ offset, timeoutSec: this.deps.pollTimeoutSec, signal });
    for (const u of updates) {
      try {
        await this.handleUpdate(u);
      } catch (err) {
        this.deps.metrics?.error("update");
        this.deps.log?.error({ updateId: u.update_id, err: err instanceof Error ? err.message : String(err) }, "update failed");
      }
      await setTelegramOffset(db, u.update_id + 1);
    }
    await this.deps.metrics?.pollDone();
    return updates.length;
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
    const isCommand = body !== "" && parseCommand(body, this.deps.botUsername) !== null;
    // Group chats see other people's messages: only commands are worth a claim.
    if (!isPrivate && !isCommand) return;
    if (!msg.text && !isPrivate) return;
    if (!(await markSent(this.deps.db, chat.id, `update:${u.update_id}`))) return;
    const { launch } = this.deps.commands;
    // In a private chat, anything that is not a command answers the launch question being asked.
    if (isPrivate && !isCommand && launch && (await launch.active(chat.id))) {
      const reply = await launch.onMessage(chat.id, msg);
      if (reply) {
        this.deps.metrics?.command("launch_step");
        return this.reply(chat.id, reply);
      }
    }
    if (!msg.text && !isCommand) {
      if (isPrivate) await this.reply(chat.id, { html: "Hi! What do you want to do? Send /help to see every command.", buttons: MENU });
      return;
    }
    const result = await handleText(this.deps.commands, { chat, from: msg.from }, body, this.deps.botUsername);
    if (!result) return;
    this.deps.metrics?.command(result.command);
    await this.reply(chat.id, result.reply);
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
    const src = { chat, from: q.from };
    if (data.startsWith("f:") && chat.type !== "private" && !(await isAdmin(ctx, src))) return answer(FOLLOW_ADMINS_TOAST);
    await answer();
    if (!(await markSent(this.deps.db, chat.id, `update:${updateId}`))) return;
    let reply: BotReply | null = null;
    if (data.startsWith("l:")) {
      if (chat.type !== "private" || !ctx.launch) return;
      reply = await ctx.launch.onButton(chat.id, q.from.id, data);
      this.deps.metrics?.command("launch_step");
    } else if (data.startsWith("m:")) {
      const name = data.slice(2);
      if (!MENU_COMMANDS.has(name)) return;
      reply = await runCommand(ctx, src, { name, args: [] });
      this.deps.metrics?.command(name);
    } else if (data.startsWith("f:")) {
      reply = { html: await follow(ctx, chat.id, data.slice(2)) };
      this.deps.metrics?.command("follow");
    }
    if (reply) await this.reply(chat.id, reply);
  }

  /** Added to a group: say what the bot does there. */
  private async handleMembership(updateId: number, m: TgChatMemberUpdated): Promise<void> {
    const joined = ["member", "administrator"].includes(m.new_chat_member.status) && ["left", "kicked"].includes(m.old_chat_member.status);
    if (!joined || m.chat.type === "private" || m.chat.type === "channel") return;
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

  private async reply(chatId: number, r: BotReply, followMigration = true): Promise<void> {
    try {
      await this.deps.tg.sendMessage(chatId, r.html, { buttons: r.buttons, preview: r.preview });
    } catch (err) {
      if (err instanceof TelegramError && err.chatUnavailable) return;
      // Answered in a group that just became a supergroup: move it, then answer once at the new id.
      if (err instanceof TelegramError && err.migrateToChatId !== undefined && followMigration) {
        await this.migrated(chatId, err.migrateToChatId);
        return this.reply(err.migrateToChatId, r, false);
      }
      throw err;
    }
  }

  /** Polls until `signal` aborts, backing off (1 s doubling to 60 s) while Telegram is unreachable. */
  async run(signal: AbortSignal): Promise<void> {
    let backoffMs = 1_000;
    while (!signal.aborted) {
      try {
        await this.pollOnce(signal);
        backoffMs = 1_000;
      } catch (err) {
        if (signal.aborted) break;
        await this.deps.metrics?.pollFailed(err);
        await sleep(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  }
}

/** Runs tasks one at a time, in order (events, milestone sweeps): sends stay ordered and PGlite stays happy. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private readonly onError: (err: unknown) => void) {}

  push(task: () => Promise<unknown>): void {
    this.pending++;
    this.tail = this.tail
      .then(task)
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

  /** Resolves once everything pushed so far has run. */
  idle(): Promise<void> {
    return this.tail;
  }
}
