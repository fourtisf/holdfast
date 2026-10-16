import { describe, expect, it } from "vitest";

import { TelegramClient, TelegramError, type FetchLike } from "../src/telegram.js";

const TOKEN = "123456:SECRET-token_value";

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(responses: { status: number; body: unknown }[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return { status: next.status, json: async () => next.body, arrayBuffer: async () => new TextEncoder().encode(String(next.body)).buffer as ArrayBuffer };
  };
  return { fetch, calls };
}

describe("TelegramClient", () => {
  it("sends HTML messages without link previews", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { ok: true, result: { message_id: 1 } } }]);
    const tg = new TelegramClient(TOKEN, { fetch, apiUrl: "http://bot.local/" });
    await tg.sendMessage(-1001234567890, "<b>hi</b>");
    expect(calls).toEqual([
      {
        url: `http://bot.local/bot${TOKEN}/sendMessage`,
        body: { chat_id: -1001234567890, text: "<b>hi</b>", parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      },
    ]);
  });

  it("sends inline buttons, answers callbacks, sets the command menu and downloads files", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { ok: true, result: { message_id: 2 } } },
      { status: 200, body: { ok: true, result: true } },
      { status: 200, body: { ok: true, result: true } },
      { status: 200, body: { ok: true, result: { status: "administrator" } } },
      { status: 200, body: { ok: true, result: { file_path: "photos/file_1.jpg", file_size: 3 } } },
      { status: 200, body: "abc" },
    ]);
    const tg = new TelegramClient(TOKEN, { fetch, apiUrl: "http://bot.local" });
    await tg.sendMessage(5, "pick", { buttons: [[{ text: "A", callback_data: "a" }]], preview: true });
    expect(calls[0]!.body).toEqual({ chat_id: 5, text: "pick", parse_mode: "HTML", link_preview_options: { is_disabled: false }, reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "a" }]] } });
    await tg.answerCallback("cb1");
    expect(calls[1]!.body).toEqual({ callback_query_id: "cb1" });
    await tg.setMyCommands([{ command: "launch", description: "Launch a new coin" }], "groups");
    expect(calls[2]!.body).toEqual({ commands: [{ command: "launch", description: "Launch a new coin" }], scope: { type: "all_group_chats" } });
    expect(await tg.getChatMemberStatus(-100, 7)).toBe("administrator");
    const file = await tg.downloadFile("F1");
    expect(calls[4]!.body).toEqual({ file_id: "F1" });
    expect(calls[5]!.url).toBe(`http://bot.local/file/bot${TOKEN}/photos/file_1.jpg`);
    expect(new TextDecoder().decode(file.bytes)).toBe("abc");
    expect(file.path).toBe("photos/file_1.jpg");
  });

  it("long-polls getUpdates with the offset and timeout", async () => {
    const updates = [{ update_id: 5, message: { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: "/start" } }];
    const { fetch, calls } = fakeFetch([{ status: 200, body: { ok: true, result: updates } }]);
    const tg = new TelegramClient(TOKEN, { fetch });
    expect(await tg.getUpdates({ offset: 5, timeoutSec: 30 })).toEqual(updates);
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(calls[0]!.body).toEqual({ offset: 5, timeout: 30, allowed_updates: ["message", "channel_post", "callback_query", "my_chat_member"] });
  });

  it("waits out 429 retry_after, then succeeds", async () => {
    const waits: number[] = [];
    const { fetch, calls } = fakeFetch([
      { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } } },
      { status: 200, body: { ok: true, result: {} } },
    ]);
    const tg = new TelegramClient(TOKEN, { fetch, sleep: async (ms) => void waits.push(ms) });
    await tg.sendMessage(1, "x");
    expect(waits).toEqual([3000]);
    expect(calls).toHaveLength(2);
  });

  it("with noWait (the update loop) throws even a 1 s 429 at once and records the chat's flood wait; button answers, member lookups and downloads never wait", async () => {
    const waits: number[] = [];
    let now = 1_000_000;
    const tooMany = { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } } };
    const { fetch, calls } = fakeFetch([tooMany, tooMany, tooMany, tooMany, { status: 200, body: { ok: true, result: {} } }]);
    const tg = new TelegramClient(TOKEN, { fetch, sleep: async (ms) => void waits.push(ms), now: () => now });
    expect(await tg.sendMessage(7, "x", { noWait: true }).catch((e: unknown) => e)).toMatchObject({ code: 429, retryAfterSec: 1, flooded: true });
    expect(tg.floodWaitMs(7)).toBe(1_000);
    // A reply to the same chat right after fails at once, without a request.
    expect(await tg.sendMessage(7, "y", { noWait: true }).catch((e: unknown) => e)).toMatchObject({ code: 429, flooded: true });
    expect(await tg.answerCallback("cb1").catch((e: unknown) => e)).toMatchObject({ code: 429 });
    expect(await tg.getChatMemberStatus(-100, 5).catch((e: unknown) => e)).toMatchObject({ method: "getChatMember", code: 429 });
    expect(await tg.downloadFile("file1").catch((e: unknown) => e)).toMatchObject({ method: "getFile", code: 429 });
    expect(waits).toEqual([]);
    now += 1_000;
    await tg.sendMessage(7, "z", { noWait: true });
    expect(calls.map((c) => c.body.text ?? c.body.callback_query_id ?? c.body.user_id ?? c.body.file_id)).toEqual(["x", "cb1", 5, "file1", "z"]);
  });

  it("never waits out a long 429: it throws at once and fails fast for that chat until retry_after has passed", async () => {
    const waits: number[] = [];
    let now = 1_000_000;
    const { fetch, calls } = fakeFetch([
      { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 40", parameters: { retry_after: 40 } } },
      { status: 200, body: { ok: true, result: {} } },
      { status: 200, body: { ok: true, result: {} } },
    ]);
    const tg = new TelegramClient(TOKEN, { fetch, sleep: async (ms) => void waits.push(ms), now: () => now });
    const flooded = await tg.sendMessage(-100, "x").catch((e: unknown) => e);
    expect(flooded).toMatchObject({ code: 429, retryAfterSec: 40, flooded: true });
    expect(waits).toEqual([]);
    // The same chat fails at once, without a request; other chats are not held up.
    now += 10_000;
    const again = (await tg.sendMessage(-100, "y").catch((e: unknown) => e)) as TelegramError;
    expect(again).toMatchObject({ code: 429, retryAfterSec: 30, flooded: true });
    expect(tg.floodWaitMs(-100)).toBe(30_000);
    await tg.sendMessage(-200, "z");
    expect(calls.map((c) => c.body.chat_id)).toEqual([-100, -200]);
    // Once retry_after has passed, the chat gets messages again.
    now += 30_000;
    expect(tg.floodWaitMs(-100)).toBe(0);
    await tg.sendMessage(-100, "w");
    expect(calls.map((c) => c.body.chat_id)).toEqual([-100, -200, -100]);
    expect(waits).toEqual([]);
  });

  it("waits out a 429 only up to maxRetryAfterSec", async () => {
    const waits: number[] = [];
    const tooMany = (sec: number) => ({ status: 429, body: { ok: false, error_code: 429, description: `Too Many Requests: retry after ${sec}`, parameters: { retry_after: sec } } });
    const { fetch, calls } = fakeFetch([tooMany(5), tooMany(6)]);
    const tg = new TelegramClient(TOKEN, { fetch, sleep: async (ms) => void waits.push(ms) });
    const err = await tg.getMe().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 429, retryAfterSec: 6 });
    expect(waits).toEqual([5000]);
    expect(calls).toHaveLength(2);
  });

  it("reports a request that got no answer as TelegramError 0, never with the URL and its token", async () => {
    // Node's fetch error for an unparsable URL repeats the whole URL, bot token included.
    const fetch: FetchLike = async (url) => {
      throw new TypeError(`Failed to parse URL from ${url}`);
    };
    const err = (await new TelegramClient(TOKEN, { fetch }).getMe().catch((e: unknown) => e)) as TelegramError;
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.code).toBe(0);
    expect(err.message).toBe("telegram getMe failed: 0 no answer (TypeError)");
    expect(err.message).not.toContain("SECRET");
    const refused: FetchLike = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const down = (await new TelegramClient(TOKEN, { fetch: refused }).sendMessage(1, "x").catch((e: unknown) => e)) as TelegramError;
    expect(down.message).toBe("telegram sendMessage failed: 0 no answer (ECONNREFUSED)");
  });

  it("posts in a forum topic; a group that lets nobody post for now is not a chat the bot cannot reach", async () => {
    const refusal = (description: string) => ({ status: 400, body: { ok: false, error_code: 400, description } });
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { ok: true, result: { message_id: 3 } } },
      refusal("Bad Request: not enough rights to send text messages to the chat"),
      refusal("Bad Request: have no rights to send a message"),
      refusal("Bad Request: CHAT_WRITE_FORBIDDEN"),
      refusal("Bad Request: need administrator rights in the channel chat"),
    ]);
    const tg = new TelegramClient(TOKEN, { fetch });
    await tg.sendMessage(-100, "in a topic", { threadId: 77 });
    expect(calls[0]!.body).toMatchObject({ chat_id: -100, message_thread_id: 77 });
    const send = async () => (await tg.sendMessage(-100, "x").catch((e: unknown) => e)) as TelegramError;
    // A night-mode lock makes the group admins-only for a while: no sign that the bot is gone.
    for (let i = 0; i < 2; i++) expect(await send()).toMatchObject({ noRights: true, chatUnavailable: false, transient: false });
    for (let i = 0; i < 2; i++) expect(await send()).toMatchObject({ chatUnavailable: true, noRights: false });
  });

  it("a closed or deleted topic is that topic's problem, not the chat's; only some refusals are worth a retry", async () => {
    const refusal = (code: number, description: string) => ({ status: code, body: { ok: false, error_code: code, description } });
    const { fetch } = fakeFetch([
      refusal(400, "Bad Request: TOPIC_CLOSED"),
      refusal(400, "Bad Request: message thread not found"),
      refusal(400, "Bad Request: TOPIC_DELETED"),
      refusal(400, "Bad Request: message is too long"),
      refusal(500, "Internal Server Error"),
    ]);
    const tg = new TelegramClient(TOKEN, { fetch });
    const send = async () => (await tg.sendMessage(-100, "x", { threadId: 77 }).catch((e: unknown) => e)) as TelegramError;
    expect(await send()).toMatchObject({ topicClosed: true, chatUnavailable: false, threadNotFound: false, transient: false });
    expect(await send()).toMatchObject({ threadNotFound: true, chatUnavailable: false, topicClosed: false, transient: false });
    expect(await send()).toMatchObject({ threadNotFound: true, chatUnavailable: false });
    expect(await send()).toMatchObject({ transient: false, chatUnavailable: false, topicClosed: false, threadNotFound: false });
    expect(await send()).toMatchObject({ transient: true, maybeSent: false });
    expect(new TelegramError("sendMessage", 0, "no answer (ECONNREFUSED)").transient).toBe(true);
    expect(new TelegramError("sendMessage", 429, "Too Many Requests", 40).transient).toBe(true);
  });

  it("only a request that never went out is worth a retry: one that got no answer after it was sent may have been posted", async () => {
    const failing = (err: unknown): FetchLike => async () => {
      throw err;
    };
    const send = async (fetch: FetchLike) => (await new TelegramClient(TOKEN, { fetch }).sendMessage(1, "x").catch((e: unknown) => e)) as TelegramError;
    const network = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]) {
      expect(await send(failing(network(code)))).toMatchObject({ code: 0, transient: true, maybeSent: false });
    }
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    for (const err of [network("ECONNRESET"), network("UND_ERR_SOCKET"), timeout]) {
      expect(await send(failing(err))).toMatchObject({ code: 0, transient: false, maybeSent: true });
    }
    // A gateway that timed out waiting for Telegram, or a 2xx whose body broke off: the same.
    const { fetch } = fakeFetch([{ status: 504, body: { ok: false, error_code: 504, description: "Gateway Timeout" } }]);
    expect(await send(fetch)).toMatchObject({ code: 504, transient: false, maybeSent: true });
    const cut: FetchLike = async () => ({ status: 200, json: async () => Promise.reject(new TypeError("terminated")) });
    expect(await send(cut)).toMatchObject({ code: 200, transient: false, maybeSent: true });
    const html: FetchLike = async () => ({ status: 502, json: async () => Promise.reject(new SyntaxError("Unexpected token <")) });
    expect(await send(html)).toMatchObject({ code: 502, transient: true, maybeSent: false });
  });

  it("stops waiting out a flood wait once the shutdown signal aborts, without cutting off a request", async () => {
    const abort = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const tooMany = { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } } };
    const { fetch, calls } = fakeFetch([tooMany, tooMany]);
    const sleep = async (_ms: number, signal?: AbortSignal) => {
      signals.push(signal);
      abort.abort(); // SIGTERM during the wait
    };
    const tg = new TelegramClient(TOKEN, { fetch, sleep });
    const err = await tg.sendMessage(-100, "x", { signal: abort.signal }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 429, flooded: true });
    expect(calls).toHaveLength(1);
    expect(signals).toEqual([abort.signal]);
    // Already stopping: a flood wait is not even started.
    const { fetch: fetch2, calls: calls2 } = fakeFetch([tooMany]);
    const err2 = await new TelegramClient(TOKEN, { fetch: fetch2, sleep }).sendMessage(-200, "y", { signal: abort.signal }).catch((e: unknown) => e);
    expect(err2).toMatchObject({ code: 429 });
    expect(calls2).toHaveLength(1);
    expect(signals).toHaveLength(1);
  });

  it("gives up after maxRetries 429s", async () => {
    const tooMany = { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } } };
    const { fetch, calls } = fakeFetch([tooMany, tooMany, tooMany]);
    const tg = new TelegramClient(TOKEN, { fetch, maxRetries: 2, sleep: async () => {} });
    const err = await tg.sendMessage(1, "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect(err).toMatchObject({ code: 429, retryAfterSec: 1 });
    expect(calls).toHaveLength(3);
  });

  it("reports refusals as TelegramError without leaking the token", async () => {
    const { fetch } = fakeFetch([
      { status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } },
      { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: chat not found" } },
      { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities" } },
      { status: 502, body: "<html>bad gateway</html>" },
    ]);
    const tg = new TelegramClient(TOKEN, { fetch });
    const blocked = (await tg.sendMessage(1, "x").catch((e: unknown) => e)) as TelegramError;
    expect(blocked.chatUnavailable).toBe(true);
    expect(blocked.message).toBe("telegram sendMessage failed: 403 Forbidden: bot was blocked by the user");
    expect(blocked.message).not.toContain("SECRET");
    expect(((await tg.sendMessage(1, "x").catch((e: unknown) => e)) as TelegramError).chatUnavailable).toBe(true);
    expect(((await tg.sendMessage(1, "x").catch((e: unknown) => e)) as TelegramError).chatUnavailable).toBe(false);
    const gateway = (await tg.getMe().catch((e: unknown) => e)) as TelegramError;
    expect(gateway).toBeInstanceOf(TelegramError);
    expect(gateway.code).toBe(502);
  });

  it("keeps the new chat id of a group that became a supergroup", async () => {
    const { fetch } = fakeFetch([
      { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -1001234567890 } } },
    ]);
    const tg = new TelegramClient(TOKEN, { fetch });
    const err = await tg.sendMessage(-4001, "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect(err).toMatchObject({ code: 400, migrateToChatId: -1001234567890, chatUnavailable: false });
  });
});
