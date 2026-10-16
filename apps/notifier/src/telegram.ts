/**
 * Minimal Telegram Bot API client on `fetch`: getMe, getUpdates (long poll), sendMessage (HTML, inline
 * buttons), callback answers, file downloads, chat member lookups and the "/" command menu.
 * The token only ever appears in request URLs; errors name the method, never the URL (a request that
 * gets no answer at all becomes a TelegramError with code 0 too, and `maybeSent` when it may have reached Telegram).
 *
 * Flood limits (429): a short retry_after is waited out (unless shutdown has begun, or the caller asked not to
 * wait); a longer one is thrown at once, and until it has passed, sends to that chat fail at once without a
 * request. The bot's update loop and its event queue each handle one thing at a time, so one flooded chat must
 * never make them wait long: the update loop never waits at all (its sends pass `noWait`; button answers, member
 * lookups and file downloads, which only it makes, never wait).
 */

export interface FetchResponse {
  status: number;
  json(): Promise<unknown>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<FetchResponse>;

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  /** Forum (topics) supergroups: the topic of the message; with is_topic_message, replies belong there. */
  message_thread_id?: number;
  is_topic_message?: boolean;
  text?: string;
  caption?: string;
  /** Sizes of one photo, smallest first. */
  photo?: TgPhotoSize[];
  document?: TgDocument;
  /** Service message in a basic group that became a supergroup: the group's new chat id. */
  migrate_to_chat_id?: number;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

/** The bot's own membership changed (added to or removed from a group). */
export interface TgChatMemberUpdated {
  chat: TgChat;
  from: TgUser;
  old_chat_member: { status: string; user: TgUser };
  /** `can_send_messages` is set for "restricted" (a muted bot). */
  new_chat_member: { status: string; user: TgUser; can_send_messages?: boolean };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  /** Channels where the bot is an admin deliver their posts here. */
  channel_post?: TgMessage;
  callback_query?: TgCallbackQuery;
  my_chat_member?: TgChatMemberUpdated;
}

/** An inline button: opens `url`, or sends `callback_data` (at most 64 bytes) back to the bot. */
export interface InlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

/** Rows of inline buttons under a message. */
export type Keyboard = InlineButton[][];

export interface SendOptions {
  buttons?: Keyboard;
  /** Show the link preview of the first link (off by default). */
  preview?: boolean;
  /** Forum topic to post in (message_thread_id); unset: the General topic, or a chat without topics. */
  threadId?: number;
  /** Shutdown: a flood wait is not waited out any more (the 429 is thrown). A request already made is never cut off. */
  signal?: AbortSignal;
  /**
   * Never wait out a flood wait, however short: the 429 is thrown at once (and the chat's flood wait recorded).
   * For the bot's update loop, where a wait for one chat holds up every other chat.
   */
  noWait?: boolean;
}

export interface BotCommandSpec {
  command: string;
  description: string;
}

/** The part of the client the bot and the outbox use (tests pass a fake). */
export interface TelegramApi {
  getMe(): Promise<TgUser>;
  getUpdates(opts: { offset: number; timeoutSec: number; signal?: AbortSignal }): Promise<TgUpdate[]>;
  sendMessage(chatId: number, html: string, opts?: SendOptions): Promise<void>;
  /** Stops the spinner on a pressed button (optionally with a short toast). Never waits out a flood wait (only the update loop answers buttons). */
  answerCallback(callbackId: string, text?: string): Promise<void>;
  /** Downloads a file a user sent (photo, document). Never waits out a flood wait (only the update loop downloads). */
  downloadFile(fileId: string): Promise<{ bytes: Uint8Array; path: string }>;
  /** "creator", "administrator", "member", "restricted", "left" or "kicked". Never waits out a flood wait (the update loop asks). */
  getChatMemberStatus(chatId: number, userId: number): Promise<string>;
  /** How long sends to `chatId` still fail at once (a flood wait Telegram asked for); 0 when they may go. */
  floodWaitMs?(chatId: number): number;
  /** The "/" menu Telegram shows; `scope` "default" (private chats) or "groups". */
  setMyCommands(commands: readonly BotCommandSpec[], scope: "default" | "groups"): Promise<void>;
}

interface TgResponse {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

/** Telegram refused the request. */
export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfterSec?: number,
    /** The group became a supergroup with this chat id (400 "group chat was upgraded to a supergroup chat"). */
    readonly migrateToChatId?: number,
    /**
     * No answer came, but the request went out (a timeout, a connection cut after it was sent, a 504 from a gateway):
     * Telegram may have carried it out. Sending it again could post the message twice.
     */
    readonly maybeSent = false,
  ) {
    super(`telegram ${method} failed: ${code} ${description}`);
    this.name = "TelegramError";
  }

  /**
   * The bot can no longer post in this chat: blocked by the user, kicked from the group, the chat is gone, or
   * the channel did not make it an admin. A closed topic is not this (see `topicClosed`), nor a group that lets
   * no member post for now (see `noRights`).
   */
  get chatUnavailable(): boolean {
    return this.code === 403 || (this.code === 400 && CHAT_UNAVAILABLE.test(this.description));
  }

  /**
   * The group lets the bot post nothing right now ("not enough rights to send ..."). Groups do this for every
   * member for a while (a night-mode lock that makes the group admins-only), so it says nothing lasting about
   * the chat: a bot muted for good gets a my_chat_member update instead ("restricted", can_send_messages false).
   */
  get noRights(): boolean {
    return this.code === 400 && /not enough rights to send|have no rights to send/i.test(this.description);
  }

  /**
   * The forum topic of the send is closed (the General topic when none was given). Groups close topics for a
   * while (overnight, say), and the bot's other topics in that group still work: the chat is not unavailable.
   */
  get topicClosed(): boolean {
    return this.code === 400 && /TOPIC_CLOSED/i.test(this.description);
  }

  /** The forum topic of the send no longer exists (deleted), or the group has no topics any more. */
  get threadNotFound(): boolean {
    return this.code === 400 && /message thread not found|TOPIC_DELETED/i.test(this.description);
  }

  /** Telegram's flood limit (429): nothing reached the chat; retryAfterSec says for how long. */
  get flooded(): boolean {
    return this.code === 429;
  }

  /**
   * A later attempt may get through, and nothing reached Telegram this time: no connection at all (code 0), a flood
   * wait, or an error on Telegram's side (5xx). Never `maybeSent`. Any other refusal (400 "message is too long", ...)
   * fails again the same way.
   */
  get transient(): boolean {
    return (this.code === 0 || this.code === 429 || this.code >= 500) && !this.maybeSent;
  }
}

const CHAT_UNAVAILABLE = /chat not found|CHAT_WRITE_FORBIDDEN|need administrator rights/i;

/** Network failures that leave no doubt the request never went out (no connection was made). Any other may come after it did. */
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

/** Why a request got no answer, without the URL (it carries the token): "ECONNREFUSED", "TimeoutError", ... */
function networkReason(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  if (cause && typeof cause.code === "string") return cause.code;
  return err instanceof Error ? err.name : "network error";
}

export interface TelegramClientOptions {
  fetch?: FetchLike;
  /** Bot API base URL (a self-hosted Bot API server, or a stub in tests). */
  apiUrl?: string;
  /** How many times a short 429 is waited out (retry_after) before giving up (never for a call with `noWait`). */
  maxRetries?: number;
  /** A 429 asking to wait longer than this many seconds is not waited out: it is thrown at once. */
  maxRetryAfterSec?: number;
  /** Timeout of every request except the long poll, which gets its own timeout + 10 s. */
  requestTimeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** Short flood waits are waited out in place; longer ones would hold up every other chat. */
export const MAX_RETRY_AFTER_SEC = 5;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class TelegramClient implements TelegramApi {
  private readonly fetchFn: FetchLike;
  private readonly apiUrl: string;
  private readonly maxRetries: number;
  private readonly maxRetryAfterSec: number;
  private readonly requestTimeoutMs: number;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  /** Chats in a flood wait: chat id → when sending there is allowed again (ms). */
  private readonly floodUntil = new Map<number, number>();

  constructor(
    private readonly token: string,
    opts: TelegramClientOptions = {},
  ) {
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.apiUrl = (opts.apiUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxRetryAfterSec = opts.maxRetryAfterSec ?? MAX_RETRY_AFTER_SEC;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.sleepFn = opts.sleep ?? sleep;
    this.now = opts.now ?? Date.now;
  }

  private async fetchOrThrow(method: string, url: string, init: Parameters<FetchLike>[1]): Promise<FetchResponse> {
    try {
      return await this.fetchFn(url, init);
    } catch (err) {
      // Node's fetch puts the whole URL (with the token) in some of its messages: never pass them on.
      const reason = networkReason(err);
      throw new TelegramError(method, 0, `no answer (${reason})`, undefined, undefined, !NOT_SENT.has(reason));
    }
  }

  /**
   * `signal` aborts the request itself and any flood wait; `stopWaiting` only the flood wait (a message that
   * may have reached Telegram is never cut off, so its claim stays right). `noWait`: a 429 is thrown at once.
   */
  private async call<T>(
    method: string,
    params: Record<string, unknown>,
    opts: { timeoutMs?: number; signal?: AbortSignal; stopWaiting?: AbortSignal; chatId?: number; noWait?: boolean } = {},
  ): Promise<T> {
    const stop = opts.signal ?? opts.stopWaiting;
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.requestTimeoutMs);
      const res = await this.fetchOrThrow(method, `${this.apiUrl}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      });
      let body: TgResponse;
      try {
        body = (await res.json()) as TgResponse;
      } catch {
        // A 2xx whose body broke off was carried out; a gateway's 504 may have been.
        throw new TelegramError(method, res.status, `HTTP ${res.status} with a non-JSON body`, undefined, undefined, res.status < 300 || res.status === 504);
      }
      if (body.ok) return body.result as T;
      const code = body.error_code ?? res.status;
      const retryAfter = body.parameters?.retry_after;
      if (code === 429) {
        const waitSec = Math.max(1, retryAfter ?? 1);
        if (opts.chatId !== undefined) this.startFloodWait(opts.chatId, waitSec);
        if (!opts.noWait && attempt < this.maxRetries && waitSec <= this.maxRetryAfterSec && !stop?.aborted) {
          await this.sleepFn(waitSec * 1000, stop);
          if (!stop?.aborted) continue;
        }
      }
      throw new TelegramError(method, code, body.description ?? `HTTP ${res.status}`, retryAfter, body.parameters?.migrate_to_chat_id, code === 504);
    }
  }

  private startFloodWait(chatId: number, seconds: number): void {
    const now = this.now();
    this.floodUntil.set(chatId, Math.max(this.floodUntil.get(chatId) ?? 0, now + seconds * 1000));
    if (this.floodUntil.size > 1_000) for (const [id, until] of this.floodUntil) if (until <= now) this.floodUntil.delete(id);
  }

  /** How long sends to `chatId` still fail at once (a flood wait Telegram asked for); 0 when they may go. */
  floodWaitMs(chatId: number): number {
    const until = this.floodUntil.get(chatId);
    if (until === undefined) return 0;
    const left = until - this.now();
    if (left <= 0) this.floodUntil.delete(chatId);
    return Math.max(0, left);
  }

  getMe(): Promise<TgUser> {
    return this.call<TgUser>("getMe", {});
  }

  /** Long poll: returns as soon as updates arrive, or empty after `timeoutSec`. */
  getUpdates(opts: { offset: number; timeoutSec: number; signal?: AbortSignal }): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      "getUpdates",
      { offset: opts.offset, timeout: opts.timeoutSec, allowed_updates: ["message", "channel_post", "callback_query", "my_chat_member"] },
      { timeoutMs: (opts.timeoutSec + 10) * 1000, signal: opts.signal },
    );
  }

  async sendMessage(chatId: number, html: string, opts: SendOptions = {}): Promise<void> {
    const wait = this.floodWaitMs(chatId);
    if (wait > 0) {
      const sec = Math.ceil(wait / 1000);
      throw new TelegramError("sendMessage", 429, `Too Many Requests: not sent, this chat is in a flood wait for ${sec} more s`, sec);
    }
    await this.call(
      "sendMessage",
      {
        chat_id: chatId,
        ...(opts.threadId !== undefined ? { message_thread_id: opts.threadId } : {}),
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: !opts.preview },
        ...(opts.buttons?.length ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
      },
      { chatId, stopWaiting: opts.signal, noWait: opts.noWait },
    );
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) }, { noWait: true });
  }

  async downloadFile(fileId: string): Promise<{ bytes: Uint8Array; path: string }> {
    const file = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId }, { noWait: true });
    if (!file.file_path) throw new TelegramError("getFile", 400, "file has no path (too big to download)");
    const res = await this.fetchOrThrow("downloadFile", `${this.apiUrl}/file/bot${this.token}/${file.file_path}`, { method: "GET", headers: {}, signal: AbortSignal.timeout(30_000) });
    if (res.status !== 200 || !res.arrayBuffer) throw new TelegramError("downloadFile", res.status, `HTTP ${res.status}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), path: file.file_path };
  }

  async getChatMemberStatus(chatId: number, userId: number): Promise<string> {
    const member = await this.call<{ status: string }>("getChatMember", { chat_id: chatId, user_id: userId }, { noWait: true });
    return member.status;
  }

  async setMyCommands(commands: readonly BotCommandSpec[], scope: "default" | "groups"): Promise<void> {
    await this.call("setMyCommands", { commands, scope: { type: scope === "groups" ? "all_group_chats" : "default" } });
  }
}

/** Escape text for Telegram's HTML parse mode (text and attribute values). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
