import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { countChatSubscriptions, getTelegramOffset, setTelegramOffset, type Db } from "@holdfast/db";

import { Bot, SerialQueue } from "../src/bot.js";
import { NotifierMonitor } from "../src/monitor.js";
import { TelegramError, type TgUpdate } from "../src/telegram.js";
import { addr, FakeTelegram, freshDb, LINKS, NOW, resetDb, textUpdate } from "./helpers.js";

let db: Db;
let tg: FakeTelegram;
let monitor: NotifierMonitor;
const silent = { warn() {}, error() {}, info() {} };

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
