/**
 * Minimal Telegram Bot API client on `fetch`: getMe, getUpdates (long poll), sendMessage (HTML, inline
 * buttons), callback answers, file downloads, chat member lookups and the "/" command menu.
 * The token only ever appears in request URLs; errors name the method, never the URL.
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
  text?: string;
  caption?: string;
  /** Sizes of one photo, smallest first. */
  photo?: TgPhotoSize[];
  document?: TgDocument;
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
  new_chat_member: { status: string; user: TgUser };
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
  /** Stops the spinner on a pressed button (optionally with a short toast). */
  answerCallback(callbackId: string, text?: string): Promise<void>;
  /** Downloads a file a user sent (photo, document). */
  downloadFile(fileId: string): Promise<{ bytes: Uint8Array; path: string }>;
  /** "creator", "administrator", "member", "restricted", "left" or "kicked". */
  getChatMemberStatus(chatId: number, userId: number): Promise<string>;
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
  ) {
    super(`telegram ${method} failed: ${code} ${description}`);
    this.name = "TelegramError";
  }

  /** The bot was blocked by the user, kicked from the group, or the chat is gone. */
  get chatUnavailable(): boolean {
    return this.code === 403 || (this.code === 400 && /chat not found/i.test(this.description));
  }
}

export interface TelegramClientOptions {
  fetch?: FetchLike;
  /** Bot API base URL (a self-hosted Bot API server, or a stub in tests). */
  apiUrl?: string;
  /** How many times a 429 is waited out (retry_after) before giving up. */
  maxRetries?: number;
  /** Timeout of every request except the long poll, which gets its own timeout + 10 s. */
  requestTimeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

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
  private readonly requestTimeoutMs: number;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly token: string,
    opts: TelegramClientOptions = {},
  ) {
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.apiUrl = (opts.apiUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.maxRetries = opts.maxRetries ?? 3;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.sleepFn = opts.sleep ?? sleep;
  }

  private async call<T>(method: string, params: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.requestTimeoutMs);
      const res = await this.fetchFn(`${this.apiUrl}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      });
      let body: TgResponse;
      try {
        body = (await res.json()) as TgResponse;
      } catch {
        throw new TelegramError(method, res.status, `HTTP ${res.status} with a non-JSON body`);
      }
      if (body.ok) return body.result as T;
      const code = body.error_code ?? res.status;
      const retryAfter = body.parameters?.retry_after;
      if (code === 429 && attempt < this.maxRetries && !opts.signal?.aborted) {
        await this.sleepFn(Math.max(1, retryAfter ?? 1) * 1000, opts.signal);
        continue;
      }
      throw new TelegramError(method, code, body.description ?? `HTTP ${res.status}`, retryAfter);
    }
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
    await this.call("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: !opts.preview },
      ...(opts.buttons?.length ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
    });
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
  }

  async downloadFile(fileId: string): Promise<{ bytes: Uint8Array; path: string }> {
    const file = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new TelegramError("getFile", 400, "file has no path (too big to download)");
    const res = await this.fetchFn(`${this.apiUrl}/file/bot${this.token}/${file.file_path}`, { method: "GET", headers: {}, signal: AbortSignal.timeout(30_000) });
    if (res.status !== 200 || !res.arrayBuffer) throw new TelegramError("downloadFile", res.status, `HTTP ${res.status}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), path: file.file_path };
  }

  async getChatMemberStatus(chatId: number, userId: number): Promise<string> {
    const member = await this.call<{ status: string }>("getChatMember", { chat_id: chatId, user_id: userId });
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
