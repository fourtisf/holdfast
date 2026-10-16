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
