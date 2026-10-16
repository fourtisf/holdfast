import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LaunchRequest, LaunchResponse } from "@holdfast/core";
import {
  getDraft,
  insertHoldBurn,
  insertLaunch,
  insertTrade,
  setBuybot,
  updateLaunchStatus,
  upsertVaultState,
  type Db,
  type NewCoin,
} from "@holdfast/db";

import { ApiError, type MoatpadApi } from "../src/api.js";
import { Bot } from "../src/bot.js";
import { BuyThrottle, Notifier } from "../src/events.js";
import { applyText, parseLinks } from "../src/launch.js";
import { LaunchFlow } from "../src/launch.js";
import { buyDots } from "../src/messages.js";
import { Outbox } from "../src/outbox.js";
import { addr, buttonData, buttonUpdate, FakeTelegram, freshDb, LINKS, MIN, NOW, photoUpdate, resetDb, seedCoin, textUpdate, TOK } from "./helpers.js";

let db: Db;
let tg: FakeTelegram;
let api: RecordingApi;
let now: number;

class RecordingApi implements MoatpadApi {
  launches: LaunchRequest[] = [];
  uploads: { bytes: number; filename: string }[] = [];
  fail: ApiError | null = null;
  async quote(devBuySol: number) {
    const required = Math.round((0.015 + devBuySol * 1.01) * 1e4) / 1e4;
    return { launchFeeSol: 0.015, devBuySol, devBuyExtraSol: 0, requiredSol: required, requiredLamports: String(required * 1e9), specFeeSol: 0.015, exceedsSpecFee: false };
  }
  async createLaunch(req: LaunchRequest): Promise<LaunchResponse> {
    if (this.fail) throw this.fail;
    this.launches.push(req);
    return {
      launchId: "11111111-2222-3333-4444-555555555555",
      depositAddress: addr("deposit"),
      requiredLamports: "520000000",
      requiredSol: 0.52,
      solanaPayUrl: "solana:x",
      expiresAt: now + 30 * MIN,
    };
  }
  async uploadImage(bytes: Uint8Array, filename: string) {
    this.uploads.push({ bytes: bytes.length, filename });
    return "https://api.example/metadata/abc.png";
  }
  async coin() {
    return null;
  }
  async trending() {
    return [];
  }
  async burns() {
    return { burns: 0, solSpent: 0, tokensBurned: 0, lastAt: null, recent: [] };
  }
}

function makeBot(): Bot {
  const launch = new LaunchFlow({ db, api, tg, links: LINKS, now: () => now });
  return new Bot({ db, tg, commands: { db, links: LINKS, now: () => now, api, launch, tg }, botUsername: "HoldfastBot", pollTimeoutSec: 30 });
}

beforeAll(async () => {
  db = await freshDb();
});
beforeEach(async () => {
  await resetDb(db);
  tg = new FakeTelegram();
  api = new RecordingApi();
  now = NOW;
});
afterAll(async () => {
  await db.close();
});

const DM = { id: 42, type: "private" as const };
const GROUP = { id: -100777, type: "supergroup" as const };

describe("/launch wizard", () => {
  it("walks through every step with text, a photo and buttons, then creates the deposit launch", async () => {
    const bot = makeBot();
    let id = 1;
    const send = async (u: ReturnType<typeof textUpdate>) => bot.handleUpdate({ ...u, update_id: id++ });

    await send(textUpdate(0, DM, "/launch"));
    expect(tg.last(DM.id)!.text).toContain("Step 1 of 8");
    expect(tg.last(DM.id)!.text).toContain("name");

    await send(textUpdate(0, DM, "Moat Dog"));
    expect(tg.last(DM.id)!.text).toContain("ticker");
    await send(textUpdate(0, DM, "moat dog!"));
    expect(tg.last(DM.id)!.text).toContain("⚠️ A ticker is 1 to 10 letters or numbers");
    await send(textUpdate(0, DM, "$mdog"));
    expect(tg.last(DM.id)!.text).toContain("image");
    expect(buttonData(tg.last(DM.id))).toContain("l:skip");

    tg.files.set("PHOTO1", new Uint8Array(1234));
    await send(photoUpdate(0, DM, "PHOTO1"));
    expect(api.uploads).toEqual([{ bytes: 1234, filename: "PHOTO1.jpg" }]);
    expect(tg.last(DM.id)!.text).toContain("description");

    await send(buttonUpdate(0, DM, "l:skip"));
    expect(tg.last(DM.id)!.text).toContain("links");
    await send(textUpdate(0, DM, "x.com/moatdog t.me/moatdog moatdog.com"));
    expect(tg.last(DM.id)!.text).toContain("floor");
    expect(buttonData(tg.last(DM.id))).toEqual(["l:floor:1500", "l:floor:2500", "l:floor:3500", "l:cancel"]);

    await send(buttonUpdate(0, DM, "l:floor:3500"));
    expect(tg.last(DM.id)!.text).toContain("dev buy");
    await send(textUpdate(0, DM, "0.5 SOL"));
    expect(tg.last(DM.id)!.text).toContain("creator fees");
    await send(buttonUpdate(0, DM, "l:payer"));

    const summary = tg.last(DM.id)!;
    expect(summary.text).toContain("<b>Moat Dog</b> ($MDOG)");
    expect(summary.text).toContain("Floor: 35% below the all-time high");
    expect(summary.text).toContain("Dev buy: 0.5 SOL");
    expect(summary.text).toContain("Links: X, Telegram, Website");
    expect(summary.text).toContain("Total to pay: 0.52 SOL");
    expect(buttonData(summary)).toEqual(["l:go", "l:restart", "l:cancel"]);

    await send(buttonUpdate(0, DM, "l:go"));
    expect(api.launches).toEqual([
      {
        name: "Moat Dog",
        ticker: "MDOG",
        imageUrl: "https://api.example/metadata/abc.png",
        description: undefined,
        socials: { x: "https://x.com/moatdog", telegram: "https://t.me/moatdog", website: "https://moatdog.com/" },
        triggerBps: 3500,
        devBuySol: 0.5,
        creatorWallet: undefined,
      },
    ]);
    const pay = tg.last(DM.id)!;
    expect(pay.text).toContain("Send exactly <b>0.52 SOL</b> to this address:");
    expect(pay.text).toContain(`<code>${addr("deposit")}</code>`);
    expect(pay.text).toContain("expires in 30 minutes");
    expect(buttonData(pay)).toEqual([`${LINKS.webUrl}/pay/11111111-2222-3333-4444-555555555555`]);
    expect(await getDraft(db, DM.id)).toBeNull();
    expect(tg.answered).toHaveLength(4);
  });

  it("keeps the draft when the API refuses, and /cancel ends it", async () => {
    const bot = makeBot();
    let id = 100;
    const send = async (u: ReturnType<typeof textUpdate>) => bot.handleUpdate({ ...u, update_id: id++ });
    await send(textUpdate(0, DM, "/launch"));
    for (const answer of ["Dog", "DOG"]) await send(textUpdate(0, DM, answer));
    for (const b of ["l:skip", "l:skip", "l:skip", "l:floor:2500", "l:dev:0", "l:payer"]) await send(buttonUpdate(0, DM, b));
    api.fail = new ApiError(503, "Launches are not open yet");
    await send(buttonUpdate(0, DM, "l:go"));
    expect(tg.last(DM.id)!.text).toBe("⚠️ Launches are paused right now. Please try again a bit later.");
    expect((await getDraft(db, DM.id))?.step).toBe("confirm");
    await send(textUpdate(0, DM, "/cancel"));
    expect(tg.last(DM.id)!.text).toContain("Launch cancelled");
    expect(await getDraft(db, DM.id)).toBeNull();
    // Without a launch in progress, plain text gets the menu.
    await send(textUpdate(0, DM, "hello"));
    expect(buttonData(tg.last(DM.id))).toContain("m:launch");
  });

  it("validates answers", () => {
    expect(applyText("name", {}, "x".repeat(33))).toMatchObject({ ok: false });
    expect(applyText("devbuy", {}, "11")).toMatchObject({ ok: false });
    expect(applyText("devbuy", {}, "0,25")).toEqual({ ok: true, data: { devBuySol: 0.25 } });
    expect(applyText("creator", {}, "nope")).toMatchObject({ ok: false });
    expect(applyText("creator", {}, addr("me"))).toEqual({ ok: true, data: { creatorWallet: addr("me") } });
    expect(parseLinks("@foo")).toBeNull();
    expect(parseLinks("https://twitter.com/foo, www.foo.io")).toEqual({ x: "https://twitter.com/foo", website: "https://www.foo.io/" });
  });
});

describe("menu buttons and groups", () => {
  it("menu buttons run the command; joining a group posts the setup steps", async () => {
    const bot = makeBot();
    await bot.handleUpdate(buttonUpdate(1, DM, "m:trending"));
    expect(tg.last(DM.id)!.text).toContain("No coins yet");
    await bot.handleUpdate(buttonUpdate(2, DM, "m:launch"));
    expect(tg.last(DM.id)!.text).toContain("Step 1 of 8");
    await bot.handleUpdate({
      update_id: 3,
      my_chat_member: {
        chat: GROUP,
        from: { id: 9, is_bot: false, first_name: "Ann" },
        old_chat_member: { status: "left", user: { id: 1, is_bot: true, first_name: "Bot" } },
        new_chat_member: { status: "member", user: { id: 1, is_bot: true, first_name: "Bot" } },
      },
    });
    expect(tg.last(GROUP.id)!.text).toContain("<code>/buybot &lt;coin address&gt;</code>");
    // Plain group chatter is ignored.
    await bot.handleUpdate(textUpdate(4, GROUP, "gm"));
    expect(tg.to(GROUP.id)).toHaveLength(1);
  });
});

describe("events for the launchpad bot", () => {
  let coin: NewCoin;
  const GROUP_A = -100111;
  const GROUP_B = -100222;

  function makeNotifier(burnChatId: number | null = null): Notifier {
    return new Notifier({ db, outbox: new Outbox(db, tg), links: LINKS, burnChatId, now: () => now });
  }

  beforeEach(async () => {
    coin = await seedCoin(db, "hound");
  });

  it("posts buys to buy bot groups above their minimum, once, with buy and launch buttons", async () => {
    await setBuybot(db, { chatId: GROUP_A, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - 60 * MIN });
    await setBuybot(db, { chatId: GROUP_B, mint: coin.mint, minLamports: 1_000_000_000n, createdBy: 9, atMs: NOW - 60 * MIN });
    await upsertVaultState(db, {
      mint: coin.mint, floorSol: 4_500_000_000n, holderSol: 0n, burnSol: 0n, holderTokens: 0n, ath: 0n, floor: 0n, defendCount: 0n, lastDefendTs: null,
      roundId: 0n, totalFees: 0n, totalDefended: 0n, totalPaidSol: 0n, totalPaidTokens: 0n, totalBurnedSol: 0n, creatorSol: 0n, totalCreatorClaimed: 0n, platformSol: 0n, totalPlatformSwept: 0n, slot: 1,
    });
    const buyer = addr("buyer");
    await insertTrade(db, { sig: "Buy1", ixIndex: 0, mint: coin.mint, wallet: buyer, side: "buy", sol: 250_000_000n, tokens: 1_234_567n * TOK, price: 5e-8, ts: NOW - MIN, slot: 11, source: "curve" });
    await insertTrade(db, { sig: "Sell1", ixIndex: 0, mint: coin.mint, wallet: buyer, side: "sell", sol: 250_000_000n, tokens: 100n * TOK, price: 5e-8, ts: NOW - MIN, slot: 12, source: "curve" });

    const n = makeNotifier();
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "Buy1" })).toBe(1);
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "Buy1" })).toBe(0);
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "Sell1" })).toBe(0);
    expect(tg.to(GROUP_B)).toEqual([]);
    const alert = tg.last(GROUP_A)!;
    expect(alert.text).toContain("<b>$HOUND Buy!</b>\n🟢🟢🟢");
    expect(alert.text).toContain("💰 Spent: <b>0.25 SOL</b>");
    expect(alert.text).toContain("🪙 Got: 1,234,567 HOUND");
    expect(alert.text).toContain("📊 Market cap: 50 SOL");
    expect(alert.text).toContain("🛡 Floor vault: 4.5 SOL");
    expect(buttonData(alert)).toEqual([`${LINKS.webUrl}/coin/${coin.mint}`, "https://t.me/HoldfastBot?start=launch"]);
  });

  it("throttles each group under Telegram's limit and counts what it skipped", () => {
    const t = new BuyThrottle(2);
    expect([t.take(1, 0), t.take(1, 1), t.take(1, 2), t.take(1, 3), t.take(2, 3)]).toEqual([0, 0, null, null, 0]);
    expect(t.take(1, 60_001)).toBe(2);
    expect(buyDots(0.05)).toBe("🟢");
    expect(buyDots(1)).toBe("🟢".repeat(10));
    expect(buyDots(99)).toBe("🟢".repeat(25));
  });

  it("tells the chat that started a launch about its progress", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    await insertLaunch(db, { id, form: { name: "Dog", ticker: "DOG", triggerBps: 2500 }, depositAddress: addr("dep"), depositIndex: 1n, requiredLamports: 15_000_000n, devBuyLamports: 0n, expiresAt: NOW + 30 * MIN });
    const { addTgLaunch } = await import("@holdfast/db");
    await addTgLaunch(db, id, DM.id);
    const n = makeNotifier();
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(0); // awaiting deposit: nothing to say
    await updateLaunchStatus(db, id, "deposit_received", { receivedLamports: 15_000_000n, sender: addr("s") });
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(1);
    expect(tg.last(DM.id)!.text).toContain("Payment received</b> (0.015 SOL)");
    await updateLaunchStatus(db, id, "live", { mint: coin.mint });
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(1);
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(0);
    const live = tg.last(DM.id)!;
    expect(live.text).toContain("$DOG is LIVE!");
    expect(live.text).toContain(`CA: <code>${coin.mint}</code>`);
    expect(buttonData(live)[0]).toBe(`${LINKS.webUrl}/coin/${coin.mint}`);
    expect(buttonData(live)[1]).toBe(`https://t.me/HoldfastBot?startgroup=buybot_${coin.mint}`);
    expect(buttonData(live)[2]).toMatch(/^https:\/\/x\.com\/intent\/tweet\?text=/);
    // Launches not started from Telegram are ignored.
    expect(await n.handle({ kind: "launch", launchId: "99999999-2222-3333-4444-555555555555" })).toBe(0);
  });

  it("posts every $MOATPAD burn to the burn channel", async () => {
    const CHANNEL = -1009999;
    await insertHoldBurn(db, { sig: "BurnSig", mint: coin.mint, solSpent: 100_000_000n, holdBurned: 2_500_000_000_000n, ts: NOW - MIN });
    expect(await makeNotifier(null).handle({ kind: "burn", mint: coin.mint, sig: "BurnSig" })).toBe(0);
    const n = makeNotifier(CHANNEL);
    expect(await n.handle({ kind: "burn", mint: coin.mint, sig: "BurnSig" })).toBe(1);
    expect(await n.handle({ kind: "burn", mint: coin.mint, sig: "BurnSig" })).toBe(0);
    expect(tg.last(CHANNEL)!.text).toContain("The $HOUND vault bought and burned <b>2.5M $MOATPAD</b> (0.1 SOL).");
  });
});
