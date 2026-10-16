/**
 * A fake Telegram Bot API server for the end-to-end run: the methods the notifier calls (getMe,
 * getUpdates long poll, sendMessage, answerCallbackQuery, getFile + file downloads, getChatMember,
 * setMyCommands), with Telegram's own checks on what the bot sends (HTML parse mode, message length,
 * button data and URLs, UTF-8). Every call is recorded; tests push updates and read what the bot sent.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { InlineButton, TgUpdate, TgUser } from "../src/telegram.js";

export interface RecordedCall {
  seq: number;
  method: string;
  params: Record<string, unknown>;
  /** Telegram's answer: ok, or the error code and description it returned. */
  ok: boolean;
  errorCode?: number;
  description?: string;
}

export interface SentMessage {
  seq: number;
  chatId: number;
  messageId: number;
  text: string;
  buttons: InlineButton[][];
  previewDisabled: boolean;
  /** Forum topic it was posted in (message_thread_id); undefined: the General topic, or a chat without topics. */
  threadId?: number;
  /** When the bot sent it (Date.now()). */
  at: number;
}

/** Update fields without update_id (the fake numbers them). */
export type NewUpdate = Omit<TgUpdate, "update_id">;

interface Waiter {
  offset: number;
  resolve: (updates: TgUpdate[]) => void;
}

/** Tags Telegram's HTML parse mode accepts. */
const TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a", "code", "pre", "span", "tg-spoiler", "blockquote", "tg-emoji"]);
const ENTITIES = new Set(["lt", "gt", "amp", "quot"]);

/** A wait for a bot message / call that never came (reported without a stack). */
export class WaitTimeout extends Error {}

class BadRequest extends Error {
  constructor(
    readonly code: number,
    description: string,
    readonly parameters?: Record<string, unknown>,
  ) {
    super(description);
  }
}

/** Telegram HTML → plain text, or throws like Telegram does ("can't parse entities"). */
export function parseTelegramHtml(html: string): string {
  const stack: string[] = [];
  let out = "";
  let i = 0;
  const fail = (what: string) => {
    throw new BadRequest(400, `Bad Request: can't parse entities: ${what} at byte offset ${Buffer.byteLength(html.slice(0, i))}`);
  };
  while (i < html.length) {
    const ch = html[i]!;
    if (ch === "<") {
      const end = html.indexOf(">", i);
      if (end < 0) fail("Unclosed start tag");
      const raw = html.slice(i + 1, end);
      const closing = raw.startsWith("/");
      const name = (closing ? raw.slice(1) : raw).trim().split(/\s+/)[0]!.toLowerCase();
      if (!TAGS.has(name)) fail(`Unsupported start tag "${name}"`);
      if (closing) {
        if (stack.pop() !== name) fail(`Unmatched end tag "${name}"`);
      } else {
        if (name === "a" && !/\shref\s*=\s*"[^"]*"/.test(` ${raw.slice(1)}`)) fail("Tag \"a\" must have an href");
        stack.push(name);
      }
      i = end + 1;
      continue;
    }
    if (ch === "&") {
      const m = /^&(#\d+|#x[0-9a-f]+|[a-z]+);/i.exec(html.slice(i));
      if (m && (m[1]!.startsWith("#") || ENTITIES.has(m[1]!.toLowerCase()))) {
        const e = m[1]!.toLowerCase();
        out += e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : String.fromCodePoint(Number(e.startsWith("#x") ? `0x${e.slice(2)}` : e.slice(1)));
        i += m[0].length;
        continue;
      }
      if (m) fail(`Unsupported HTML entity "${m[0]}"`);
    }
    out += ch;
    i++;
  }
  if (stack.length > 0) fail(`Can't find end tag corresponding to start tag "${stack[stack.length - 1]}"`);
  return out;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function checkButtons(markup: unknown): InlineButton[][] {
  if (markup === undefined) return [];
  const rows = (markup as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(rows)) throw new BadRequest(400, "Bad Request: can't parse reply keyboard markup JSON object");
  for (const row of rows) {
    if (!Array.isArray(row) || row.length === 0) throw new BadRequest(400, "Bad Request: inline keyboard row is empty");
    for (const b of row as InlineButton[]) {
      if (typeof b.text !== "string" || b.text === "") throw new BadRequest(400, "Bad Request: text buttons are unallowed in the inline keyboard");
      const kinds = [b.url, b.callback_data].filter((v) => v !== undefined).length;
      if (kinds !== 1) throw new BadRequest(400, "Bad Request: inline keyboard button must have exactly one action");
      if (b.callback_data !== undefined) {
        const bytes = Buffer.byteLength(b.callback_data);
        if (bytes < 1 || bytes > 64) throw new BadRequest(400, "Bad Request: BUTTON_DATA_INVALID");
      }
      if (b.url !== undefined) {
        let ok = false;
        try {
          ok = ["http:", "https:", "tg:"].includes(new URL(b.url).protocol);
        } catch {
          ok = false;
        }
        if (!ok) throw new BadRequest(400, "Bad Request: BUTTON_URL_INVALID");
      }
    }
  }
  return rows as InlineButton[][];
}

export interface FakeTelegramOptions {
  token: string;
  bot: TgUser;
  /** Bytes served for every file (a real PNG in the e2e run). */
  fileBytes: Uint8Array;
}

export class FakeTelegram {
  readonly calls: RecordedCall[] = [];
  readonly messages: SentMessage[] = [];
  /** getChatMember answers by `${chatId}:${userId}` (default "member"). */
  readonly members = new Map<string, string>();
  /** Basic groups that became supergroups: sending to the old id answers 400 with migrate_to_chat_id. */
  readonly migrated = new Map<number, number>();
  /** Chats that blocked the bot (or kicked it): sending answers 403. */
  readonly blocked = new Set<number>();
  /** The next send to these chats answers 429 with this retry_after (seconds), once. */
  readonly floodOnce = new Map<number, number>();
  /** Closed forum topics, `${chatId}:${threadId}` (`${chatId}:general` for the General topic): sending there answers 400 TOPIC_CLOSED. */
  readonly closedTopics = new Set<string>();
  /** Deleted forum topics, `${chatId}:${threadId}`: sending there answers 400 "message thread not found". */
  readonly deletedTopics = new Set<string>();
  /** File downloads served (paths). */
  readonly downloads: string[] = [];
  private readonly updates: TgUpdate[] = [];
  private nextUpdateId = 1000;
  private seq = 0;
  private messageId = 0;
  private waiters: Waiter[] = [];
  private listeners: (() => void)[] = [];
  private server: Server | null = null;
  private readonly files = new Map<string, string>();

  constructor(private readonly opts: FakeTelegramOptions) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.route(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const w of this.waiters) w.resolve([]);
    this.waiters = [];
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Queue an update (answers a pending long poll at once); returns its update_id. */
  push(update: NewUpdate): number {
    const u = { update_id: this.nextUpdateId++, ...update } as TgUpdate;
    this.updates.push(u);
    const ready = this.waiters.filter((w) => this.pending(w.offset).length > 0);
    this.waiters = this.waiters.filter((w) => !ready.includes(w));
    for (const w of ready) w.resolve(this.pending(w.offset));
    return u.update_id;
  }

  /** Highest sequence number so far: pass it to `messagesSince` / `waitForMessage` to only see what comes next. */
  get cursor(): number {
    return this.seq;
  }

  messagesSince(seq: number, chatId?: number): SentMessage[] {
    return this.messages.filter((m) => m.seq > seq && (chatId === undefined || m.chatId === chatId));
  }

  callsSince(seq: number, method?: string): RecordedCall[] {
    return this.calls.filter((c) => c.seq > seq && (method === undefined || c.method === method));
  }

  /** Resolves with the first message after `since` that matches, or rejects after `timeoutMs`. */
  waitForMessage(since: number, match: (m: SentMessage) => boolean, timeoutMs = 10_000, what = "a bot message"): Promise<SentMessage> {
    return this.waitFor(() => this.messagesSince(since).find(match), timeoutMs, what);
  }

  waitForCall(since: number, match: (c: RecordedCall) => boolean, timeoutMs = 10_000, what = "a Bot API call"): Promise<RecordedCall> {
    return this.waitFor(() => this.callsSince(since).find(match), timeoutMs, what);
  }

  private waitFor<T>(find: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
    const found = find();
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const check = () => {
        const v = find();
        if (v === undefined) return;
        done();
        resolve(v);
      };
      const timer = setTimeout(() => {
        done();
        reject(new WaitTimeout(`timed out after ${timeoutMs} ms waiting for ${what}`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        this.listeners = this.listeners.filter((l) => l !== check);
      };
      this.listeners.push(check);
    });
  }

  private pending(offset: number): TgUpdate[] {
    return this.updates.filter((u) => u.update_id >= offset).slice(0, 100);
  }

  private record(method: string, params: Record<string, unknown>, ok: boolean, err?: BadRequest): number {
    const seq = ++this.seq;
    this.calls.push({ seq, method, params, ok, errorCode: err?.code, description: err?.message });
    return seq;
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const send = (status: number, body: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const file = /^\/file\/bot([^/]+)\/(.+)$/.exec(url.pathname);
    if (file) {
      if (file[1] !== this.opts.token || !this.files.has(decodeURIComponent(file[2]!))) {
        res.writeHead(404).end();
        return;
      }
      this.downloads.push(decodeURIComponent(file[2]!));
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from(this.opts.fileBytes));
      return;
    }
    const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
    if (!m) return send(404, { ok: false, error_code: 404, description: "Not Found" });
    if (m[1] !== this.opts.token) return send(401, { ok: false, error_code: 401, description: "Unauthorized" });
    const method = m[2]!;
    let params: Record<string, unknown> = {};
    try {
      const raw = await readBody(req);
      params = raw ? (JSON.parse(raw) as Record<string, unknown>) : Object.fromEntries(url.searchParams);
    } catch {
      return send(400, { ok: false, error_code: 400, description: "Bad Request: invalid JSON" });
    }
    if (method === "getUpdates") return this.getUpdates(params, req, send);
    try {
      const result = this.handle(method, params);
      this.record(method, params, true);
      send(200, { ok: true, result });
    } catch (err) {
      const e = err instanceof BadRequest ? err : new BadRequest(500, `Internal Server Error: ${(err as Error).message}`);
      this.record(method, params, false, e);
      send(e.code, { ok: false, error_code: e.code, description: e.message, ...(e.parameters ? { parameters: e.parameters } : {}) });
    }
    this.notify();
  }

  private getUpdates(params: Record<string, unknown>, req: IncomingMessage, send: (status: number, body: unknown) => void): void {
    const offset = Number(params.offset ?? 0);
    const timeoutSec = Number(params.timeout ?? 0);
    // Updates below the offset are confirmed: Telegram never sends them again.
    const confirmed = this.updates.filter((u) => u.update_id < offset).length;
    if (confirmed > 0) this.updates.splice(0, confirmed);
    this.record("getUpdates", params, true);
    this.notify();
    const ready = this.pending(offset);
    if (ready.length > 0 || timeoutSec <= 0) return send(200, { ok: true, result: ready });
    const waiter: Waiter = {
      offset,
      resolve: (updates) => {
        clearTimeout(timer);
        send(200, { ok: true, result: updates });
      },
    };
    const timer = setTimeout(() => {
      this.waiters = this.waiters.filter((w) => w !== waiter);
      send(200, { ok: true, result: [] });
    }, timeoutSec * 1000);
    req.on("close", () => {
      clearTimeout(timer);
      this.waiters = this.waiters.filter((w) => w !== waiter);
    });
    this.waiters.push(waiter);
  }

  private handle(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case "getMe":
        return this.opts.bot;
      case "setMyCommands": {
        const commands = p.commands;
        if (!Array.isArray(commands) || commands.length > 100) throw new BadRequest(400, "Bad Request: commands must be an array");
        for (const c of commands as { command?: unknown; description?: unknown }[]) {
          if (typeof c.command !== "string" || !/^[a-z0-9_]{1,32}$/.test(c.command)) throw new BadRequest(400, "Bad Request: BOT_COMMAND_INVALID");
          if (typeof c.description !== "string" || c.description.length < 1 || c.description.length > 256) throw new BadRequest(400, "Bad Request: BOT_COMMAND_DESCRIPTION_INVALID");
        }
        return true;
      }
      case "sendMessage":
        return this.sendMessage(p);
      case "answerCallbackQuery":
        if (typeof p.callback_query_id !== "string") throw new BadRequest(400, "Bad Request: query ID is invalid");
        if (typeof p.text === "string" && p.text.length > 200) throw new BadRequest(400, "Bad Request: MESSAGE_TOO_LONG");
        return true;
      case "getFile": {
        const id = String(p.file_id ?? "");
        if (!id) throw new BadRequest(400, "Bad Request: invalid file_id");
        const path = `photos/${id}.png`;
        this.files.set(path, id);
        return { file_id: id, file_unique_id: `u-${id}`, file_size: this.opts.fileBytes.length, file_path: path };
      }
      case "getChatMember": {
        const chatId = Number(p.chat_id);
        const userId = Number(p.user_id);
        if (this.migrated.has(chatId)) throw new BadRequest(400, "Bad Request: group chat was upgraded to a supergroup chat", { migrate_to_chat_id: this.migrated.get(chatId) });
        return { status: this.members.get(`${chatId}:${userId}`) ?? "member", user: { id: userId, is_bot: false, first_name: "User" } };
      }
      default:
        throw new BadRequest(404, "Not Found: method not found");
    }
  }

  private sendMessage(p: Record<string, unknown>): unknown {
    const chatId = Number(p.chat_id);
    if (!Number.isSafeInteger(chatId) || chatId === 0) throw new BadRequest(400, "Bad Request: chat not found");
    const to = this.migrated.get(chatId);
    if (to !== undefined) throw new BadRequest(400, "Bad Request: group chat was upgraded to a supergroup chat", { migrate_to_chat_id: to });
    if (this.blocked.has(chatId)) throw new BadRequest(403, chatId > 0 ? "Forbidden: bot was blocked by the user" : "Forbidden: bot was kicked from the supergroup chat");
    const flood = this.floodOnce.get(chatId);
    if (flood !== undefined) {
      this.floodOnce.delete(chatId);
      throw new BadRequest(429, `Too Many Requests: retry after ${flood}`, { retry_after: flood });
    }
    const threadId = p.message_thread_id === undefined ? undefined : Number(p.message_thread_id);
    if (threadId !== undefined && this.deletedTopics.has(`${chatId}:${threadId}`)) throw new BadRequest(400, "Bad Request: message thread not found");
    if (this.closedTopics.has(`${chatId}:${threadId ?? "general"}`)) throw new BadRequest(400, "Bad Request: TOPIC_CLOSED");
    const text = typeof p.text === "string" ? p.text : "";
    if (LONE_SURROGATE.test(text)) throw new BadRequest(400, "Bad Request: strings must be encoded in UTF-8");
    if (p.parse_mode !== undefined && p.parse_mode !== "HTML") throw new BadRequest(400, `Bad Request: unsupported parse_mode ${String(p.parse_mode)}`);
    const plain = p.parse_mode === "HTML" ? parseTelegramHtml(text) : text;
    if (plain.trim() === "") throw new BadRequest(400, "Bad Request: message text is empty");
    if (plain.length > 4096) throw new BadRequest(400, "Bad Request: message is too long");
    const buttons = checkButtons(p.reply_markup);
    const messageId = ++this.messageId;
    const previewDisabled = Boolean((p.link_preview_options as { is_disabled?: boolean } | undefined)?.is_disabled);
    // Recorded with the sequence number the call itself gets next.
    this.messages.push({ seq: this.seq + 1, chatId, messageId, text, buttons, previewDisabled, ...(threadId !== undefined ? { threadId } : {}), at: Date.now() });
    return { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: chatId > 0 ? "private" : "supergroup" }, text: plain };
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
