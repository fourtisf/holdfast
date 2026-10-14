/**
 * getUpdates long-poll loop. The offset is stored in tg_state after each update, and every update
 * we act on is claimed in tg_sent (`update:<id>`) first, so an update Telegram delivers again after
 * a restart is neither executed nor answered twice.
 */
import { getTelegramOffset, markSent, setTelegramOffset, type Queryable } from "@holdfast/db";

import { handleText, parseCommand, type CommandContext } from "./commands.js";
import { sleep, TelegramError, type TelegramApi, type TgUpdate } from "./telegram.js";

interface Logger {
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
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
    const msg = u.message ?? u.channel_post;
    if (!msg?.text) return;
    const { chat } = msg;
    // Group chats see other people's messages: only commands are worth a claim.
    if (chat.type !== "private" && !parseCommand(msg.text, this.deps.botUsername)) return;
    if (!(await markSent(this.deps.db, chat.id, `update:${u.update_id}`))) return;
    const result = await handleText(this.deps.commands, chat, msg.text, this.deps.botUsername);
    if (!result) return;
    this.deps.metrics?.command(result.command);
    try {
      await this.deps.tg.sendMessage(chat.id, result.reply);
    } catch (err) {
      if (err instanceof TelegramError && err.chatUnavailable) return;
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
