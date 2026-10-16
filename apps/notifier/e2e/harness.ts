/** Shared pieces of the end-to-end run: the context, chats that talk to the bot, assertions. */
import type { Db } from "@holdfast/db";

import type { InlineButton, TgChat, TgUser } from "../src/telegram.js";
import { insertBotLaunch, transition, type E2eCoin } from "./chain-events.js";
import { parseTelegramHtml, type FakeTelegram, type RecordedCall, type SentMessage } from "./fake-telegram.js";
import type { Service } from "./processes.js";

export interface Ctx {
  db: Db;
  tg: FakeTelegram;
  apiUrl: string;
  webUrl: string;
  botUsername: string;
  /** The bot's own user (getMe), as Telegram shows it in membership updates. */
  botUser: TgUser;
  burnChatId: number;
  moatCa: string;
  notifier: Service;
  api: Service;
  metadataDir: string;
  opsUrl: string;
  pngBytes: Uint8Array;
  /** Starts the notifier and waits until it polls Telegram. */
  startNotifier(): Promise<void>;
  /** Callback query ids the run pressed (each must be answered once). */
  pressed: string[];
  coins: { buy: E2eCoin; alert: E2eCoin; seeded: string[] };
  /** Bot API refusals the run provoked on purpose (migrations, a blocked bot, a flood limit). */
  expectedRefusals: ((c: RecordedCall) => boolean)[];
  /** Service error logs the run provoked on purpose (cut database connections). */
  expectedLogErrors: RegExp[];
}

export class AssertionError extends Error {}

export function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new AssertionError(message);
}

/** JSON with object keys sorted (bigints as strings), so equal values print equal. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (typeof x === "bigint") return x.toString();
    if (x && typeof x === "object" && !Array.isArray(x)) return Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    return x;
  });
}

export function equal<T>(actual: T, expected: T, what: string): void {
  const a = canonical(actual);
  const e = canonical(expected);
  if (a !== e) throw new AssertionError(`${what}: expected ${e}, got ${a}`);
}

/** The message as the user reads it (HTML entities decoded, tags gone). */
export function plain(m: SentMessage | undefined): string {
  return m ? parseTelegramHtml(m.text) : "";
}

export function contains(m: SentMessage | undefined, ...parts: string[]): void {
  const text = plain(m);
  for (const p of parts) if (!text.includes(p)) throw new AssertionError(`expected the message to contain ${JSON.stringify(p)}, got:\n${indent(text)}`);
}

export function lacks(m: SentMessage | undefined, ...parts: string[]): void {
  const text = plain(m);
  for (const p of parts) if (text.includes(p)) throw new AssertionError(`expected the message not to contain ${JSON.stringify(p)}, got:\n${indent(text)}`);
}

export function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `      | ${l}`)
    .join("\n");
}

export function buttons(m: SentMessage | undefined): InlineButton[] {
  return (m?.buttons ?? []).flat();
}

export function button(m: SentMessage | undefined, match: (b: InlineButton) => boolean, what: string): InlineButton {
  const b = buttons(m).find(match);
  if (!b) throw new AssertionError(`no ${what} button; buttons: ${JSON.stringify(buttons(m).map((x) => x.text))}`);
  return b;
}

export function callbackData(m: SentMessage | undefined): string[] {
  return buttons(m).flatMap((b) => (b.callback_data ? [b.callback_data] : []));
}

export function urls(m: SentMessage | undefined): string[] {
  return buttons(m).flatMap((b) => (b.url ? [b.url] : []));
}

let messageId = 0;
const SENTINEL: TgUser = { id: 1999, is_bot: false, first_name: "Sentinel" };
const EVENTS_CHAT = 1998;
let barriers = 0;

/** A Telegram chat a user talks to the bot in. */
export class Chat {
  /** The latest bot message in this chat. */
  last: SentMessage | undefined;

  constructor(
    private readonly ctx: Ctx,
    readonly chat: Pick<TgChat, "id" | "type"> & { title?: string },
    readonly user: TgUser,
  ) {}

  get id(): number {
    return this.chat.id;
  }

  /** A message update from `from`; in a channel a channel_post, which has no sender (it is signed by the channel). */
  private update(extra: Record<string, unknown>, from: TgUser) {
    const base = { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: this.chat, ...extra };
    return this.chat.type === "channel" ? { channel_post: { ...base, sender_chat: this.chat } } : { message: { ...base, from } };
  }

  /** Sends a text message and waits for the bot's next message in this chat. */
  async say(text: string, from: TgUser = this.user, timeoutMs = 15_000): Promise<SentMessage> {
    return this.send({ text }, from, `the reply to ${JSON.stringify(text)} in chat ${this.id}`, timeoutMs);
  }

  /** Sends any message (a document, ...) and waits for the reply. */
  async send(extra: Record<string, unknown>, from: TgUser = this.user, what = `the reply in chat ${this.id}`, timeoutMs = 15_000): Promise<SentMessage> {
    const since = this.ctx.tg.cursor;
    this.ctx.tg.push(this.update(extra, from) as never);
    return this.reply(since, what, timeoutMs);
  }

  /** Sends a text message the bot must not answer (checked after every earlier update was handled). */
  async sayNothing(text: string, from: TgUser = this.user): Promise<void> {
    const since = this.ctx.tg.cursor;
    this.ctx.tg.push(this.update({ text }, from) as never);
    await updatesSettled(this.ctx);
    const got = this.ctx.tg.messagesSince(since, this.id);
    check(got.length === 0, `expected no reply to ${JSON.stringify(text)}, got:\n${got.map((m) => indent(plain(m))).join("\n")}`);
  }

  /** Sends a photo (sizes smallest first, like Telegram) and waits for the reply. */
  async photo(fileId: string, from: TgUser = this.user): Promise<SentMessage> {
    const photo = [
      { file_id: `${fileId}-thumb`, width: 90, height: 90, file_size: 1_200 },
      { file_id: fileId, width: 512, height: 512, file_size: this.ctx.pngBytes.length },
    ];
    return this.send({ photo }, from, `the reply to a photo in chat ${this.id}`);
  }

  /** Pushes an update as is (service messages, my_chat_member) and waits for a reply. */
  async raw(update: Record<string, unknown>, expectReply = true): Promise<SentMessage | undefined> {
    const since = this.ctx.tg.cursor;
    this.ctx.tg.push(update as never);
    if (!expectReply) {
      await updatesSettled(this.ctx);
      return undefined;
    }
    return this.reply(since, `a message in chat ${this.id}`);
  }

  /**
   * Presses the button with exactly this callback_data on `on` (default: the latest bot message here),
   * like a Telegram client does: a callback_query carrying that message. Waits for the bot's reply,
   * unless `expectReply` is false.
   */
  async press(data: string, opts: { on?: SentMessage; from?: TgUser; expectReply?: boolean } = {}): Promise<SentMessage | undefined> {
    const on = opts.on ?? this.last;
    check(on, `no bot message in chat ${this.id} to press ${data} on`);
    check(callbackData(on).includes(data), `the message has no ${data} button; its buttons: ${JSON.stringify(callbackData(on))}`);
    const since = this.ctx.tg.cursor;
    const id = `cb-${this.id}-${++messageId}`;
    this.ctx.pressed.push(id);
    this.ctx.tg.push({
      callback_query: {
        id,
        from: opts.from ?? this.user,
        chat_instance: `ci-${this.id}`,
        data,
        message: { message_id: on.messageId, date: Math.floor(Date.now() / 1000), chat: this.chat, from: this.ctx.botUser, text: plain(on) },
      },
    } as never);
    await this.ctx.tg.waitForCall(since, (c) => c.method === "answerCallbackQuery" && c.params.callback_query_id === id, 10_000, `the answer to button ${data}`);
    if (opts.expectReply === false) {
      await updatesSettled(this.ctx);
      const got = this.ctx.tg.messagesSince(since, this.id);
      check(got.length === 0, `expected no message after pressing ${data}, got:\n${got.map((m) => indent(plain(m))).join("\n")}`);
      return undefined;
    }
    return this.reply(since, `the reply to button ${data} in chat ${this.id}`);
  }

  private async reply(since: number, what: string, timeoutMs = 15_000): Promise<SentMessage> {
    const m = await this.ctx.tg.waitForMessage(since, (x) => x.chatId === this.id, timeoutMs, what);
    this.last = m;
    return m;
  }
}

/** Every update pushed so far has been handled (the bot handles updates one at a time, in order). */
export async function updatesSettled(ctx: Ctx): Promise<void> {
  const since = ctx.tg.cursor;
  ctx.tg.push({ message: { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: { id: SENTINEL.id, type: "private" }, from: SENTINEL, text: "/help" } } as never);
  await ctx.tg.waitForMessage(since, (m) => m.chatId === SENTINEL.id, 15_000, "the update barrier");
}

/**
 * Every notification sent so far has been handled: the notifier handles them one at a time in
 * arrival order, so once a launch status change sent after them reaches its chat, they are done.
 */
export async function eventsSettled(ctx: Ctx): Promise<void> {
  const ticker = `BAR${++barriers}`;
  const id = await insertBotLaunch(ctx.db, EVENTS_CHAT, ticker);
  const since = ctx.tg.cursor;
  await transition(ctx.db, id, "expired", {}, ["awaiting_deposit"]);
  await ctx.tg.waitForMessage(since, (m) => m.chatId === EVENTS_CHAT && plain(m).includes(`$${ticker} `), 15_000, "the event barrier");
}

export const SYSTEM_CHATS = new Set([SENTINEL.id, EVENTS_CHAT]);

export async function getJson<T>(ctx: Ctx, path: string): Promise<T> {
  const res = await fetch(`${ctx.apiUrl}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new AssertionError(`GET ${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
