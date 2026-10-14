/**
 * Minimal Telegram Bot API client on `fetch`: getMe, getUpdates (long poll) and sendMessage (HTML).
 * The token only ever appears in request URLs; errors name the method, never the URL.
 */

export interface FetchResponse {
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<FetchResponse>;

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

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  /** Channels where the bot is an admin deliver their posts here. */
  channel_post?: TgMessage;
}

/** The part of the client the bot and the outbox use (tests pass a fake). */
export interface TelegramApi {
  getMe(): Promise<TgUser>;
  getUpdates(opts: { offset: number; timeoutSec: number; signal?: AbortSignal }): Promise<TgUpdate[]>;
  sendMessage(chatId: number, html: string): Promise<void>;
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
      { offset: opts.offset, timeout: opts.timeoutSec, allowed_updates: ["message", "channel_post"] },
      { timeoutMs: (opts.timeoutSec + 10) * 1000, signal: opts.signal },
    );
  }

  async sendMessage(chatId: number, html: string): Promise<void> {
    await this.call("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true });
  }
}

/** Escape text for Telegram's HTML parse mode (text and attribute values). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
