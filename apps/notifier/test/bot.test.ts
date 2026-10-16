import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addSubscription, countChatSubscriptions, getBuybot, getTelegramOffset, setBuybot, setTelegramOffset, type Db } from "@holdfast/db";

import { ApiError, type MoatpadApi } from "../src/api.js";
import { Bot, drainForShutdown, GROUP_REPLIES_PER_MINUTE, PRIVATE_BURST_WINDOW_MS, PRIVATE_REPLIES_PER_MINUTE, PRIVATE_REPLY_BURST, SerialQueue } from "../src/bot.js";
import { NOT_REACHABLE } from "../src/messages.js";
import { NotifierMonitor, POLL_RECOVERY_MS } from "../src/monitor.js";
import { TelegramClient, TelegramError, type FetchLike, type TgUpdate } from "../src/telegram.js";
import { addr, buttonUpdate, FakeTelegram, freshDb, LINKS, MIN, NOW, resetDb, textUpdate } from "./helpers.js";

let db: Db;
let tg: FakeTelegram;
let monitor: NotifierMonitor;
const silent = { warn() {}, error() {}, info() {}, debug() {} };

function makeBot(): Bot {
  return new Bot({ db, tg, commands: { db, links: LINKS, now: () => NOW }, botUsername: "HoldfastBot", pollTimeoutSec: 30, metrics: monitor, log: silent });
}

beforeAll(async () => {
  db = await freshDb();
});
beforeEach(async () => {
  await resetDb(db);
  tg = new FakeTelegram();
  monitor = new NotifierMonitor(silent, { maxPollAgeMs: 90_000 }, {});
});
afterAll(async () => {
  await db.close();
});

const DM = { id: 42, type: "private" as const };
const GROUP = { id: -100777, type: "supergroup" as const };

describe("Bot.pollOnce", () => {
  it("handles commands, replies and stores the next offset", async () => {
    const wallet = addr("alice");
    tg.batches.push([textUpdate(10, DM, `/watch ${wallet}`), textUpdate(11, DM, "/list"), textUpdate(12, GROUP, "gm everyone"), textUpdate(13, GROUP, "/watch@OtherBot x")]);
    expect(await makeBot().pollOnce()).toBe(4);
    expect(tg.offsets).toEqual([0]);
    expect(await getTelegramOffset(db)).toBe(14);
    expect(tg.to(DM.id)).toHaveLength(2);
    expect(tg.to(DM.id)[0]).toContain("Watching wallet");
    expect(tg.to(DM.id)[1]).toContain(`<code>${wallet}</code>`);
    expect(tg.to(GROUP.id)).toEqual([]);
    expect(monitor.counter("commands", { command: "watch" })).toBe(1);
    expect(monitor.counter("commands", { command: "list" })).toBe(1);

    // The next poll asks for updates after the last one.
    await makeBot().pollOnce();
    expect(tg.offsets).toEqual([0, 14]);
  });

  it("never runs or answers an update twice, even when Telegram redelivers it after a restart", async () => {
    const wallet = addr("alice");
    const updates = [textUpdate(20, DM, `/watch ${wallet}`), textUpdate(21, DM, "/stop")];
    tg.batches.push(updates);
    await makeBot().pollOnce();
    expect(tg.to(DM.id)).toHaveLength(2);
    expect(await countChatSubscriptions(db, DM.id)).toBe(0);

    // Crash before the offset was stored: the same updates come back to a new process.
    await setTelegramOffset(db, 20);
    tg.batches.push(updates);
    await makeBot().pollOnce();
    expect(tg.to(DM.id)).toHaveLength(2);
    expect(await countChatSubscriptions(db, DM.id)).toBe(0);
    expect(await getTelegramOffset(db)).toBe(22);
  });

  it("keeps going when a reply fails, and ignores chats that blocked the bot", async () => {
    tg.fail.set(DM.id, new TelegramError("sendMessage", 403, "Forbidden: bot was blocked by the user"));
    tg.fail.set(7, new TelegramError("sendMessage", 400, "Bad Request: message is too long"));
    tg.batches.push([textUpdate(30, DM, "/help"), textUpdate(31, { id: 7, type: "private" }, "/help"), textUpdate(32, { id: 8, type: "private" }, "/help")]);
    await makeBot().pollOnce();
    expect(await getTelegramOffset(db)).toBe(33);
    expect(tg.to(8)).toHaveLength(1);
    expect(monitor.counter("errors", { source: "update" })).toBe(1);
  });
});

describe("one chat never holds up the others", () => {
  it("ends a batch at the next update once shutdown is asked; the rest is neither claimed nor acknowledged", async () => {
    const abort = new AbortController();
    class StoppingTelegram extends FakeTelegram {
      override async sendMessage(...args: Parameters<FakeTelegram["sendMessage"]>): Promise<void> {
        await super.sendMessage(...args);
        abort.abort(); // SIGTERM while the first update is handled
      }
    }
    tg = new StoppingTelegram();
    const updates = [textUpdate(50, DM, "/help"), textUpdate(51, DM, "/alerts"), textUpdate(52, DM, "/help")];
    tg.batches.push(updates);
    expect(await makeBot().pollOnce(abort.signal)).toBe(1);
    expect(await getTelegramOffset(db)).toBe(51);
    expect(tg.sent).toHaveLength(1);
    // After the restart Telegram delivers the rest again, and it is answered.
    tg.batches.push(updates);
    await makeBot().pollOnce();
    expect(tg.sent).toHaveLength(3);
    expect(await getTelegramOffset(db)).toBe(53);
  });

  it(`answers at most ${GROUP_REPLIES_PER_MINUTE} commands a minute in a group, and in a private chat ${PRIVATE_REPLY_BURST} at once and ${PRIVATE_REPLIES_PER_MINUTE} a minute`, async () => {
    let now = NOW;
    const bot = new Bot({ db, tg, commands: { db, links: LINKS, now: () => now }, botUsername: "HoldfastBot", pollTimeoutSec: 30, metrics: monitor, log: silent });
    let id = 100;
    // Anyone in a group can send /help or press the menu buttons: past the budget the bot stays quiet there.
    for (let i = 0; i < GROUP_REPLIES_PER_MINUTE + 3; i++) await bot.handleUpdate(textUpdate(id++, GROUP, "/help", 1000 + i));
    expect(tg.to(GROUP.id)).toHaveLength(GROUP_REPLIES_PER_MINUTE);
    await bot.handleUpdate(buttonUpdate(id++, GROUP, "m:trending", 5));
    expect(tg.toasts.get(`cb${id - 1}`)).toBe("That is a lot at once. Please wait a moment and try again.");
    expect(tg.to(GROUP.id)).toHaveLength(GROUP_REPLIES_PER_MINUTE);
    // A private chat sending a lot at once (forwarding a pile of messages) gets the first few answered.
    for (let i = 0; i < PRIVATE_REPLY_BURST + 2; i++) await bot.handleUpdate(textUpdate(id++, DM, "hello"));
    expect(tg.to(DM.id)).toHaveLength(PRIVATE_REPLY_BURST);
    // Once the burst window is over, one a second is answered, up to the minute's budget.
    now += PRIVATE_BURST_WINDOW_MS;
    for (let i = 0; i <= PRIVATE_REPLIES_PER_MINUTE - PRIVATE_REPLY_BURST; i++, now += 1_000) await bot.handleUpdate(textUpdate(id++, DM, "hello"));
    expect(tg.to(DM.id)).toHaveLength(PRIVATE_REPLIES_PER_MINUTE);
    // Other chats are answered as usual, and a minute later the busy ones are too.
    await bot.handleUpdate(textUpdate(id++, { id: 43, type: "private" }, "/help"));
    expect(tg.to(43)).toHaveLength(1);
    now += MIN;
    await bot.handleUpdate(textUpdate(id++, GROUP, "/help"));
    await bot.handleUpdate(textUpdate(id++, DM, "/help"));
    expect(tg.to(GROUP.id)).toHaveLength(GROUP_REPLIES_PER_MINUTE + 1);
    expect(tg.to(DM.id)).toHaveLength(PRIVATE_REPLIES_PER_MINUTE + 1);
    expect(monitor.counter("commands", { command: "over_limit" })).toBe(3 + 1 + 2 + 1);
  });

  it("never waits out a flood wait in the update loop: a chat flooding the bot does not delay another chat's reply (real client)", async () => {
    let clock = NOW;
    let slept = 0;
    const lastSend = new Map<number, number>();
    const requests: { method: string; chatId?: number }[] = [];
    const delivered: { chatId: number; at: number }[] = [];
    const batches: TgUpdate[][] = [];
    const BUSY = { id: -100900, type: "supergroup" as const };
    const tooMany = (sec: number) => ({ ok: false, error_code: 429, description: `Too Many Requests: retry after ${sec}`, parameters: { retry_after: sec } });
    // Telegram's per-chat limit: a second message to a chat within a second is refused (429 retry_after 1). The busy
    // group's buy alerts already fill its minute, and a button answer is refused once too: short flood waits all.
    let callbackRefused = false;
    const fetch: FetchLike = async (url, init) => {
      const method = url.slice(url.lastIndexOf("/") + 1);
      const params = JSON.parse(init.body ?? "{}") as { chat_id?: number };
      requests.push({ method, chatId: params.chat_id });
      const answer = (body: unknown) => ({ status: 200, json: async () => body });
      if (method === "getUpdates") return answer({ ok: true, result: batches.shift() ?? [] });
      if (method === "answerCallbackQuery" && !callbackRefused) return (callbackRefused = true), answer(tooMany(1));
      if (method !== "sendMessage") return answer({ ok: true, result: true });
      const chatId = params.chat_id!;
      if (chatId === BUSY.id) return answer(tooMany(3));
      const last = lastSend.get(chatId);
      if (last !== undefined && clock - last < 1_000) return answer(tooMany(1));
      lastSend.set(chatId, clock);
      delivered.push({ chatId, at: clock });
      return answer({ ok: true, result: { message_id: delivered.length } });
    };
    const sleep = async (ms: number) => {
      slept += ms;
      clock += ms;
    };
    const client = new TelegramClient("123:secret", { fetch, sleep, now: () => clock });
    const bot = new Bot({ db, tg: client, commands: { db, links: LINKS, now: () => clock }, botUsername: "HoldfastBot", pollTimeoutSec: 30, metrics: monitor, log: silent });
    const victim = { id: 43, type: "private" as const };
    const presser = { id: 44, type: "private" as const };
    // One private chat forwards 100 messages at once; behind them a busy group's /help, a button press and another user's /help.
    const flood = Array.from({ length: 100 }, (_, i) => textUpdate(400 + i, DM, `spam ${i}`));
    batches.push([...flood, textUpdate(500, BUSY, "/help"), buttonUpdate(501, presser, "m:help"), textUpdate(502, victim, "/help")]);
    expect(await bot.pollOnce()).toBe(103);
    expect(slept).toBe(0);
    expect(delivered.filter((d) => d.chatId === victim.id)).toEqual([{ chatId: victim.id, at: NOW }]);
    expect(delivered.filter((d) => d.chatId === presser.id)).toEqual([{ chatId: presser.id, at: NOW }]);
    // The flooding chat: one reply, one refused, then nothing even asked of Telegram until its flood wait is over.
    expect(delivered.filter((d) => d.chatId === DM.id)).toHaveLength(1);
    expect(requests.filter((r) => r.method === "sendMessage" && r.chatId === DM.id)).toHaveLength(2);
    expect(requests.filter((r) => r.method === "sendMessage" && r.chatId === BUSY.id)).toHaveLength(1);
    expect(monitor.counter("errors", { source: "update" })).toBe(0);
  });

  it("other bots' commands in a group (/price) neither get an answer nor use up the group's reply budget", async () => {
    const bot = makeBot();
    let id = 300;
    // A bot that posted last in the group, or is an admin there, receives every command under privacy mode.
    for (let i = 0; i < GROUP_REPLIES_PER_MINUTE + 5; i++) await bot.handleUpdate(textUpdate(id++, GROUP, i % 2 ? "/price" : "/chart@HoldfastBot", 1000 + i));
    expect(tg.to(GROUP.id)).toEqual([]);
    expect(monitor.counter("commands", { command: "over_limit" })).toBe(0);
    await bot.handleUpdate(textUpdate(id++, GROUP, "/help"));
    expect(tg.to(GROUP.id)).toHaveLength(1);
    expect(tg.to(GROUP.id)[0]).toContain("<b>Moatpad Bot</b>");
    // In a private chat an unknown command is still answered (and counted).
    await bot.handleUpdate(textUpdate(id++, DM, "/price"));
    expect(tg.to(DM.id)).toEqual(["Unknown command /price. Send /help for the list."]);
  });

  it("drops a reply in a topic that was closed meanwhile, or in a group that lets nobody post for now, without an error", async () => {
    const LOCKED = { id: -100654, type: "supergroup" as const };
    tg.fail.set(GROUP.id, new TelegramError("sendMessage", 400, "Bad Request: TOPIC_CLOSED"));
    tg.fail.set(LOCKED.id, new TelegramError("sendMessage", 400, "Bad Request: not enough rights to send text messages to the chat"));
    tg.batches.push([textUpdate(65, GROUP, "/help"), textUpdate(66, LOCKED, "/help"), textUpdate(67, DM, "/help")]);
    await makeBot().pollOnce();
    expect(tg.to(DM.id)).toHaveLength(1);
    expect(monitor.counter("errors", { source: "update" })).toBe(0);
  });

  it("drops a reply Telegram refuses with a flood wait, without an error or a wait", async () => {
    tg.fail.set(DM.id, new TelegramError("sendMessage", 429, "Too Many Requests: retry after 40", 40));
    tg.batches.push([textUpdate(60, DM, "/help"), textUpdate(61, { id: 43, type: "private" }, "/help")]);
    await makeBot().pollOnce();
    expect(await getTelegramOffset(db)).toBe(62);
    expect(tg.to(43)).toHaveLength(1);
    expect(monitor.counter("errors", { source: "update" })).toBe(0);
  });

  it("says Moatpad is not reachable when the API is down, instead of nothing", async () => {
    const down: MoatpadApi = {
      quote: async () => Promise.reject(new TypeError("fetch failed")),
      createLaunch: async () => Promise.reject(new TypeError("fetch failed")),
      uploadImage: async () => Promise.reject(new TypeError("fetch failed")),
      coin: async () => Promise.reject(new ApiError(502, "HTTP 502")),
      trending: async () => Promise.reject(new TypeError("fetch failed")),
      burns: async () => Promise.reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })),
    };
    const bot = new Bot({ db, tg, commands: { db, links: LINKS, now: () => NOW, api: down }, botUsername: "HoldfastBot", pollTimeoutSec: 30, metrics: monitor, log: silent });
    tg.batches.push([textUpdate(70, DM, "/trending"), textUpdate(71, DM, `/coin ${addr("mint")}`), textUpdate(72, GROUP, "/burns"), buttonUpdate(73, DM, "m:trending")]);
    await bot.pollOnce();
    expect(tg.to(DM.id)).toEqual([NOT_REACHABLE, NOT_REACHABLE, NOT_REACHABLE]);
    expect(tg.to(GROUP.id)).toEqual([NOT_REACHABLE]);
    expect(tg.answered).toEqual(["cb73"]);
    expect(monitor.counter("errors", { source: "update" })).toBe(4);
  });

  it("replies in the forum topic the command or the pressed button was in", async () => {
    const inTopic = (u: TgUpdate): TgUpdate => {
      const m = u.message ?? u.callback_query!.message!;
      Object.assign(m, { message_thread_id: 77, is_topic_message: true });
      return u;
    };
    const bot = makeBot();
    await bot.handleUpdate(inTopic(textUpdate(80, GROUP, "/help")));
    await bot.handleUpdate(inTopic(buttonUpdate(81, GROUP, "m:help")));
    await bot.handleUpdate(textUpdate(82, GROUP, "/help"));
    expect(tg.sent.map((m) => m.threadId)).toEqual([77, 77, undefined]);
  });

  it("drops the alerts and the buy bot of a chat that banned or muted the bot", async () => {
    const bot = makeBot();
    const member = (status: string, extra: Record<string, unknown> = {}) => ({ status, user: { id: 1, is_bot: true, first_name: "Bot" }, ...extra });
    const change = (id: number, chat: typeof GROUP, status: ReturnType<typeof member>): TgUpdate => ({
      update_id: id,
      my_chat_member: { chat, from: { id: 9, is_bot: false, first_name: "Ann" }, old_chat_member: member("member"), new_chat_member: status },
    });
    for (const chat of [GROUP.id, -100778, -100779]) {
      await setBuybot(db, { chatId: chat, mint: addr("m"), minLamports: 0n, createdBy: 9, atMs: NOW });
      await addSubscription(db, { chatId: chat, kind: "coin", target: addr("m"), atMs: NOW });
    }
    await bot.handleUpdate(change(90, GROUP, member("restricted", { can_send_messages: false })));
    await bot.handleUpdate(change(91, { id: -100778, type: "supergroup" }, member("kicked")));
    await bot.handleUpdate(change(92, { id: -100779, type: "supergroup" }, member("restricted", { can_send_messages: true })));
    expect(await getBuybot(db, GROUP.id)).toBeNull();
    expect(await countChatSubscriptions(db, GROUP.id)).toBe(0);
    expect(await getBuybot(db, -100778)).toBeNull();
    expect(await getBuybot(db, -100779)).not.toBeNull();
    expect(await countChatSubscriptions(db, -100779)).toBe(1);
    expect(tg.sent).toEqual([]);
  });
});

describe("NotifierMonitor", () => {
  it("checks at startup that the bot may post in the burn chat, and says so loudly when it may not", async () => {
    const errors: string[] = [];
    const m = new NotifierMonitor({ ...silent, error: (_o: object, msg?: string) => void errors.push(msg ?? "") }, { maxPollAgeMs: 90_000 }, {});
    const fire = vi.spyOn(m.alerter, "fire");
    tg.members.set("-1001:1", "administrator");
    expect(await m.checkBurnChat(tg, -1001, 1)).toBe(true);
    tg.members.set("-1002:1", "left"); // not in the chat (or a wrong id)
    expect(await m.checkBurnChat(tg, -1002, 1)).toBe(false);
    const missing = { getChatMemberStatus: async () => Promise.reject(new TelegramError("getChatMember", 400, "Bad Request: chat not found")) };
    expect(await m.checkBurnChat(missing, 1234567890, 1)).toBe(false);
    expect(errors).toHaveLength(2);
    expect(fire).toHaveBeenCalledTimes(2);
    expect(fire.mock.calls[1]![3]).toMatchObject({ burnChatId: 1234567890, status: "unknown (telegram getChatMember failed: 400 Bad Request: chat not found)" });
  });

  it("resolves the polling alert only once polling stayed clean for a while (two pollers on one token alternate)", async () => {
    let now = NOW;
    const m = new NotifierMonitor(silent, { maxPollAgeMs: 90_000 }, {}, () => now);
    const resolve = vi.spyOn(m.alerter, "resolve");
    const fire = vi.spyOn(m.alerter, "fire");
    const conflict = new TelegramError("getUpdates", 409, "Conflict: terminated by other getUpdates request");
    await m.pollFailed(conflict);
    now += 30_000;
    await m.pollDone();
    now += 1_000;
    await m.pollFailed(conflict);
    now += 30_000;
    await m.pollDone();
    expect(resolve).not.toHaveBeenCalled();
    expect(fire).toHaveBeenCalledTimes(2);
    now += POLL_RECOVERY_MS;
    await m.pollDone();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("telegram_poll", "telegram polling recovered");
    now += 60_000;
    await m.pollDone();
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

describe("Bot.run", () => {
  it("backs off after a failed poll and stops on abort", async () => {
    const abort = new AbortController();
    class FlakyTelegram extends FakeTelegram {
      calls = 0;
      override async getUpdates(): Promise<TgUpdate[]> {
        if (++this.calls === 1) throw new TelegramError("getUpdates", 502, "Bad Gateway");
        abort.abort();
        return [];
      }
    }
    const flaky = new FlakyTelegram();
    const bot = new Bot({ db, tg: flaky, commands: { db, links: LINKS, now: () => NOW }, pollTimeoutSec: 1, metrics: monitor, log: silent });
    const started = Date.now();
    await bot.run(abort.signal);
    expect(flaky.calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(monitor.counter("errors", { source: "poll" })).toBe(1);
  });
});

describe("shutdown", () => {
  it("drops queued tasks not started yet and gives up on the running one at the deadline", async () => {
    const ran: string[] = [];
    const q = new SerialQueue(() => {});
    let finish!: () => void;
    q.push(async () => {
      ran.push("long");
      await new Promise<void>((r) => (finish = r)); // a large fan-out, a slow send
    });
    for (let i = 0; i < 3; i++) q.push(async () => void ran.push(`queued${i}`));
    await vi.waitFor(() => expect(ran).toEqual(["long"]));
    const started = Date.now();
    expect(await drainForShutdown(Promise.resolve(), q, 100)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    // The running task ends later: what was queued behind it never starts, nor does anything pushed now.
    q.push(async () => void ran.push("late"));
    finish();
    await q.idle();
    expect(ran).toEqual(["long"]);
    expect(q.size).toBe(0);
  });

  it("returns as soon as the poll and the running task are done", async () => {
    const q = new SerialQueue(() => {});
    q.push(() => new Promise((r) => setTimeout(r, 20)));
    const polling = new Promise<void>((r) => setTimeout(r, 30));
    const started = Date.now();
    expect(await drainForShutdown(polling, q, 5_000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("SerialQueue", () => {
  it("runs tasks in order and survives failures", async () => {
    const order: number[] = [];
    const errors: unknown[] = [];
    const q = new SerialQueue((err) => errors.push(err));
    q.push(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });
    q.push(async () => {
      throw new Error("boom");
    });
    q.push(async () => void order.push(3));
    expect(q.size).toBe(3);
    await q.idle();
    expect(order).toEqual([1, 3]);
    expect(errors).toHaveLength(1);
    expect(q.size).toBe(0);
  });
});
