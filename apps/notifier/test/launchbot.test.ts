import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { LaunchRequest, LaunchResponse } from "@holdfast/core";
import {
  addSubscription,
  addTgLaunch,
  chatForLaunch,
  getBuybot,
  getDraft,
  insertHoldBurn,
  insertLaunch,
  insertTrade,
  listChatSubscriptions,
  setBuybot,
  updateLastPrice,
  updateLaunchStatus,
  upsertVaultState,
  type Db,
  type NewCoin,
} from "@holdfast/db";

import { ApiError, type MoatpadApi, type QuoteRequest } from "../src/api.js";
import { Bot } from "../src/bot.js";
import { BuyThrottle, Notifier } from "../src/events.js";
import { applyButton, applyText, ask, MAX_LINK_LENGTH, parseLinks, summary, type Step } from "../src/launch.js";
import { LaunchFlow } from "../src/launch.js";
import { buyDots } from "../src/messages.js";
import { Outbox } from "../src/outbox.js";
import { TelegramError, type TgUpdate } from "../src/telegram.js";
import { addr, buttonData, buttonUpdate, FakeTelegram, freshDb, LINKS, MIN, NOW, photoUpdate, resetDb, seedCoin, textUpdate, TOK, wellFormed } from "./helpers.js";

let db: Db;
let tg: FakeTelegram;
let api: RecordingApi;
let now: number;

class RecordingApi implements MoatpadApi {
  launches: LaunchRequest[] = [];
  uploads: { bytes: number; filename: string }[] = [];
  /** The Telegram user of every createLaunch / uploadImage call, refused ones included. */
  launchUsers: (number | undefined)[] = [];
  uploadUsers: (number | undefined)[] = [];
  fail: ApiError | null = null;
  quotes: QuoteRequest[] = [];
  async quote(req: QuoteRequest) {
    this.quotes.push(req);
    const devBuySol = req.devBuySol;
    const required = Math.round((0.015 + devBuySol * 1.01) * 1e4) / 1e4;
    return { launchFeeSol: 0.015, devBuySol, devBuyExtraSol: 0, requiredSol: required, requiredLamports: String(required * 1e9), specFeeSol: 0.015, exceedsSpecFee: false };
  }
  async createLaunch(req: LaunchRequest, userId?: number): Promise<LaunchResponse> {
    this.launchUsers.push(userId);
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
  async uploadImage(bytes: Uint8Array, filename: string, userId?: number) {
    this.uploadUsers.push(userId);
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
const CHANNEL = { id: -100888, type: "channel" as const };
/** From the image step to the summary: skip image, description and links, 25% floor, no dev buy, the payer is the creator. */
const SKIP_TO_CONFIRM = ["l:skip:image", "l:skip:description", "l:skip:links", "l:floor:2500", "l:dev:0", "l:payer"];

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
    expect(buttonData(tg.last(DM.id))).toContain("l:skip:image");

    tg.files.set("PHOTO1", new Uint8Array(1234));
    await send(photoUpdate(0, DM, "PHOTO1"));
    expect(api.uploads).toEqual([{ bytes: 1234, filename: "PHOTO1.jpg" }]);
    expect(tg.last(DM.id)!.text).toContain("description");

    await send(buttonUpdate(0, DM, "l:skip:description"));
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
    expect(api.quotes).toEqual([{ devBuySol: 0.5, name: "Moat Dog", ticker: "MDOG" }]);
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
    for (const b of SKIP_TO_CONFIRM) await send(buttonUpdate(0, DM, b));
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

  it("checks every answer with the API's rules, so the launch is never refused at the end", () => {
    // Name: trimmed, 1-32 characters; ticker: 1-10 A-Z/0-9 after "$" and case; description: up to 500, blank is none.
    expect(applyText("name", {}, `  ${"x".repeat(32)}  `)).toEqual({ ok: true, data: { name: "x".repeat(32) } });
    expect(applyText("ticker", {}, " $mdog1 ")).toEqual({ ok: true, data: { ticker: "MDOG1" } });
    expect(applyText("ticker", {}, "x".repeat(11))).toMatchObject({ ok: false });
    expect(applyText("description", {}, "d".repeat(500))).toMatchObject({ ok: true });
    expect(applyText("description", {}, "d".repeat(501))).toMatchObject({ ok: false });
    expect(applyText("description", { name: "Dog" }, "   ")).toEqual({ ok: true, data: { name: "Dog", description: undefined } });
    // Lengths count like the API (an emoji is 2), and the answer says so when that is the reason.
    expect(applyText("name", {}, "x".repeat(33))).toEqual({ ok: false, error: "That name is 33 characters. Please keep it to 32 or less." });
    expect(applyText("description", {}, "🐶".repeat(250))).toMatchObject({ ok: true });
    expect(applyText("description", {}, "🐶".repeat(251))).toEqual({
      ok: false,
      error: "That description is too long: emoji count as 2 characters, so it is 502 of the 500 allowed. Please make it a bit shorter.",
    });
    // Blocked terms (the API's moderation) are refused at their own step.
    expect(applyText("name", {}, "Wallet Drainer")).toEqual({ ok: false, error: "That name is not allowed on Moatpad. Please choose another one." });
    expect(applyText("ticker", {}, "csam")).toMatchObject({ ok: false });
    expect(applyText("description", {}, "Claim airdrop now")).toMatchObject({ ok: false });
    expect(applyText("links", {}, "freesolairdrop.com")).toMatchObject({ ok: false, error: expect.stringContaining("not allowed") });
    // Links: at most 200 characters once normalized, like the API.
    const longest = `x.com/${"a".repeat(MAX_LINK_LENGTH - "https://x.com/".length)}`;
    expect(parseLinks(longest)).toEqual({ x: `https://${longest}` });
    expect(parseLinks(`${longest}a`)).toBeNull();
    expect(applyText("links", {}, `${longest}a`)).toEqual({ ok: false, error: "One of those links is too long. A link can be up to 200 characters." });
    // Dev buy: plain decimal amounts from 0 to 10 SOL.
    expect(applyText("devbuy", {}, ".5")).toEqual({ ok: true, data: { devBuySol: 0.5 } });
    expect(applyText("devbuy", {}, "10 sol")).toEqual({ ok: true, data: { devBuySol: 10 } });
    for (const bad of ["10.01", "-1", "0x1", "1e1", "Infinity", "abc"]) expect(applyText("devbuy", {}, bad)).toMatchObject({ ok: false });
    // Creator: a regular wallet. A program address (off the curve) could never sign the fee claims.
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], new PublicKey(addr("program")));
    expect(applyText("creator", {}, pda.toBase58())).toEqual({
      ok: false,
      error: "That is a program address, not a wallet, so it could never claim the fees. Send your own wallet address (from Phantom, Solflare, ...), or tap the button to use the wallet you pay from.",
    });
  });

  it("warns not to pay from an exchange at the creator step", () => {
    const html = ask("creator", {}).html;
    expect(html).toContain("<i>Don't pay from an exchange: refunds and dev-buy tokens go back to the wallet that pays.</i>");
    expect(html).not.toContain("Paying from an exchange?");
  });

  it("cuts a long description in the summary by characters, never inside an emoji", () => {
    const description = `${"a".repeat(79)}😀${"b".repeat(20)}`;
    const html = summary({ name: "Dog", ticker: "DOG", description }, null).html;
    expect(html).toContain(`📝 Description: ${"a".repeat(79)}😀…\n`);
    expect(wellFormed(html)).toBe(true);
    expect(wellFormed(description.slice(0, 80))).toBe(false); // what a UTF-16 cut would have sent
    expect(summary({ name: "Dog", ticker: "DOG", description: "short 😀" }, null).html).toContain("📝 Description: short 😀\n");
  });

  it("a double-tapped or old Skip button only skips its own step", async () => {
    const bot = makeBot();
    let id = 200;
    const send = async (u: TgUpdate) => bot.handleUpdate({ ...u, update_id: id++ });
    for (const t of ["/launch", "Dog", "DOG"]) await send(textUpdate(0, DM, t));
    await send(buttonUpdate(0, DM, "l:skip:image"));
    expect((await getDraft(db, DM.id))?.step).toBe("description");
    // The same Skip again (double tap), or a Skip without its step from before this version: the question is asked again.
    for (const stale of ["l:skip:image", "l:skip"]) {
      await send(buttonUpdate(0, DM, stale));
      expect(tg.last(DM.id)!.text).toMatch(/^⚠️ That button belongs to another step\. Please answer the question above\.\n\n<b>Step 4 of 8<\/b>\nWrite a short <b>description<\/b>/);
      expect((await getDraft(db, DM.id))?.step).toBe("description");
    }
    await send(buttonUpdate(0, DM, "l:skip:description"));
    expect((await getDraft(db, DM.id))?.step).toBe("links");
    expect(applyButton("links", {}, "skip", "links")).toEqual({ ok: true, data: {} });
    expect(applyButton("floor", {}, "skip", "floor")).toMatchObject({ ok: false });
  });

  it("keeps every button's callback data under Telegram's 64 bytes", () => {
    const steps: Step[] = ["name", "ticker", "image", "description", "links", "floor", "devbuy", "creator", "confirm"];
    const data = steps.flatMap((step) => buttonData({ chatId: 0, text: "", buttons: ask(step, { name: "x".repeat(32), ticker: "XXXXXXXXXX" }).buttons }));
    expect(data).toContain("l:skip:description");
    for (const d of data) expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
  });

  it("limits launch tries and image uploads per Telegram user, and sends the user to the API", async () => {
    const bot = makeBot();
    let id = 300;
    const send = async (u: TgUpdate) => bot.handleUpdate({ ...u, update_id: id++ });
    const fill = async (chat: typeof DM, fromId: number) => {
      for (const t of ["/launch", "Dog", "DOG"]) await send(textUpdate(0, chat, t, fromId));
      for (const b of SKIP_TO_CONFIRM) await send(buttonUpdate(0, chat, b, fromId));
    };

    // 10 images a minute: the 11th waits, and is not downloaded or uploaded.
    for (const t of ["/launch", "Dog", "DOG"]) await send(textUpdate(0, DM, t));
    for (let i = 0; i < 10; i++) {
      await send(photoUpdate(0, DM, "MISSING"));
      expect(tg.last(DM.id)!.text).toContain("I couldn't use that image");
    }
    tg.files.set("PHOTO1", new Uint8Array(10));
    await send(photoUpdate(0, DM, "PHOTO1"));
    expect(tg.last(DM.id)!.text).toContain("⚠️ You sent a lot of images in the last minute. Please wait a minute and send it again, or tap Skip.");
    expect(api.uploads).toEqual([]);
    now += MIN;
    await send(photoUpdate(0, DM, "PHOTO1"));
    expect(api.uploadUsers).toEqual([7]);
    expect((await getDraft(db, DM.id))?.step).toBe("description");

    // 3 launch tries per 10 minutes, refused ones included.
    await send(textUpdate(0, DM, "/cancel"));
    await fill(DM, 7);
    api.fail = new ApiError(503, "Launches are not open yet");
    for (let i = 0; i < 3; i++) await send(buttonUpdate(0, DM, "l:go"));
    api.fail = null;
    await send(buttonUpdate(0, DM, "l:go"));
    expect(tg.last(DM.id)!.text).toBe("⚠️ You tried to launch 3 times in the last 10 minutes. Please wait a few minutes, then tap Try again.");
    expect(buttonData(tg.last(DM.id))).toEqual(["l:go", "l:restart", "l:cancel"]);
    expect(api.launchUsers).toEqual([7, 7, 7]);
    // Somebody else is not held up.
    const OTHER = { id: 43, type: "private" as const };
    await fill(OTHER, 8);
    await send(buttonUpdate(0, OTHER, "l:go", 8));
    expect(tg.last(OTHER.id)!.text).toContain("Last step: send the SOL");
    now += 10 * MIN;
    await send(buttonUpdate(0, DM, "l:go"));
    expect(tg.last(DM.id)!.text).toContain("Last step: send the SOL");
    expect(api.launchUsers).toEqual([7, 7, 7, 8, 7]);
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

  it("menu buttons only run menu commands, and buttons in a channel only get a toast", async () => {
    const bot = makeBot();
    const coin = await seedCoin(db, "hound");
    await setBuybot(db, { chatId: GROUP.id, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW });
    for (const [i, data] of ["m:stop", "m:buybot", "m:unfollow", "m:dance"].entries()) await bot.handleUpdate(buttonUpdate(10 + i, GROUP, data, 5));
    expect(tg.sent).toEqual([]);
    expect(tg.answered).toEqual(["cb10", "cb11", "cb12", "cb13"]);
    expect(await getBuybot(db, GROUP.id)).not.toBeNull();

    await bot.handleUpdate(buttonUpdate(20, CHANNEL, "m:trending"));
    await bot.handleUpdate(buttonUpdate(21, CHANNEL, `f:${coin.mint}`));
    await bot.handleUpdate(buttonUpdate(22, CHANNEL, "l:go"));
    expect(tg.sent).toEqual([]);
    expect(await listChatSubscriptions(db, CHANNEL.id)).toEqual([]);
    expect([...tg.toasts.values()]).toEqual(Array(3).fill("Buttons don't work in channels. Open me in a private chat to use them."));
  });

  it("a coin's Get alerts button in a group needs a group admin", async () => {
    const bot = makeBot();
    const coin = await seedCoin(db, "hound");
    await bot.handleUpdate(buttonUpdate(30, GROUP, `f:${coin.mint}`, 5));
    expect(tg.toasts.get("cb30")).toBe("Only group admins can turn on alerts here. Open me in a private chat to follow it yourself.");
    expect(tg.sent).toEqual([]);
    expect(await listChatSubscriptions(db, GROUP.id)).toEqual([]);

    tg.members.set(`${GROUP.id}:9`, "administrator");
    await bot.handleUpdate(buttonUpdate(31, GROUP, `f:${coin.mint}`, 9));
    expect(tg.last(GROUP.id)!.text).toContain("🔔 Alerts on for $HOUND");
    expect(await listChatSubscriptions(db, GROUP.id)).toMatchObject([{ kind: "coin", target: coin.mint }]);
    // In a private chat anyone follows for themselves.
    await bot.handleUpdate(buttonUpdate(32, DM, `f:${coin.mint}`, 5));
    expect(tg.last(DM.id)!.text).toContain("🔔 Alerts on for $HOUND");
    expect(tg.toasts.size).toBe(1);
  });
});

describe("a group that becomes a supergroup", () => {
  const OLD = { id: -5001, type: "group" as const };
  const NEW = -1005001;
  const upgraded = () => new TelegramError("sendMessage", 400, "Bad Request: group chat was upgraded to a supergroup chat", undefined, NEW);

  it("moves its buy bot and alerts when Telegram announces the upgrade", async () => {
    const coin = await seedCoin(db, "hound");
    await setBuybot(db, { chatId: OLD.id, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW });
    await addSubscription(db, { chatId: OLD.id, kind: "coin", target: coin.mint, atMs: NOW });
    await makeBot().handleUpdate({ update_id: 40, message: { message_id: 1, date: Math.floor(NOW / 1000), chat: OLD, migrate_to_chat_id: NEW } });
    expect(await getBuybot(db, OLD.id)).toBeNull();
    expect(await getBuybot(db, NEW)).toMatchObject({ mint: coin.mint });
    expect(await listChatSubscriptions(db, NEW)).toMatchObject([{ kind: "coin", target: coin.mint }]);
    expect(tg.sent).toEqual([]);
  });

  it("an alert refused with the new chat id moves the group and is sent there, once", async () => {
    const coin = await seedCoin(db, "hound");
    await setBuybot(db, { chatId: OLD.id, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - 60 * MIN });
    tg.fail.set(OLD.id, upgraded());
    await insertTrade(db, { sig: "Buy1", ixIndex: 0, mint: coin.mint, wallet: addr("buyer"), side: "buy", sol: 100_000_000n, tokens: 5n * TOK, price: 5e-8, ts: NOW - MIN, slot: 1, source: "curve" });
    const n = new Notifier({ db, outbox: new Outbox(db, tg), links: LINKS, now: () => now });
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "Buy1" })).toBe(1);
    expect(tg.to(NEW)).toHaveLength(1);
    expect(tg.to(NEW)[0]).toContain("<b>$HOUND Buy!</b>");
    expect(await getBuybot(db, NEW)).toMatchObject({ mint: coin.mint });
    expect(await getBuybot(db, OLD.id)).toBeNull();
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "Buy1" })).toBe(0);
    expect(tg.to(NEW)).toHaveLength(1);
  });

  it("a command answered in the old group moves it and the answer goes to the new id", async () => {
    const id = "11111111-2222-3333-4444-666666666666";
    await addTgLaunch(db, id, OLD.id);
    tg.fail.set(OLD.id, upgraded());
    await makeBot().handleUpdate(textUpdate(41, OLD, "/help"));
    expect(tg.to(NEW)).toHaveLength(1);
    expect(tg.to(NEW)[0]).toContain("<b>Moatpad Bot</b>");
    expect(await chatForLaunch(db, id)).toBe(NEW);
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

  it("a buy alert shows the coin's market cap after the buy, not at the buy's average price", async () => {
    await setBuybot(db, { chatId: GROUP_A, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - 60 * MIN });
    await insertTrade(db, { sig: "Buy2", ixIndex: 0, mint: coin.mint, wallet: addr("buyer"), side: "buy", sol: 500_000_000n, tokens: 10_000_000n * TOK, price: 5e-8, ts: NOW - MIN, slot: 13, source: "curve" });
    // The indexer stores the spot price after the trade as the coin's last price (what the coin page shows).
    await updateLastPrice(db, coin.mint, 5.5e-8, NOW - MIN, 13);
    expect(await makeNotifier().handle({ kind: "trade", mint: coin.mint, sig: "Buy2" })).toBe(1);
    expect(tg.last(GROUP_A)!.text).toContain("📊 Market cap: 55 SOL");
  });

  it("a buy handled after later trades moved the price (a burst, a replay) shows its own market cap", async () => {
    await setBuybot(db, { chatId: GROUP_A, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - 60 * MIN });
    const buy = async (sig: string, price: number, spotAfter: number, ts: number, slot: number) => {
      await insertTrade(db, { sig, ixIndex: 0, mint: coin.mint, wallet: addr(`buyer:${sig}`), side: "buy", sol: 500_000_000n, tokens: 10_000_000n * TOK, price, ts, slot, source: "curve" });
      await updateLastPrice(db, coin.mint, spotAfter, ts, slot);
    };
    await buy("Burst1", 5e-8, 5.5e-8, NOW - MIN, 13);
    await buy("Burst2", 6e-8, 6.5e-8, NOW - MIN + 1_000, 14);
    const n = makeNotifier();
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "Burst1" })).toBe(1);
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "Burst2" })).toBe(1);
    expect(tg.to(GROUP_A).map((t) => /Market cap: ([\d.]+) SOL/.exec(t)?.[1])).toEqual(["50", "65"]);
  });

  it("posts only fresh buys (an indexer backfill does not flood groups), while older floor defences still go out", async () => {
    await setBuybot(db, { chatId: GROUP_A, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - 60 * MIN });
    const trade = (sig: string, side: "buy" | "vault", ts: number) =>
      insertTrade(db, { sig, ixIndex: 0, mint: coin.mint, wallet: side === "vault" ? coin.treasury : addr("buyer"), side, sol: 100_000_000n, tokens: 5n * TOK, price: 5e-8, ts, slot: 1, source: side === "vault" ? "vault" : "curve" });
    await trade("OldBuy", "buy", NOW - 5 * MIN);
    await trade("FreshBuy", "buy", NOW - 90_000);
    await trade("OldDefend", "vault", NOW - 5 * MIN);
    const n = makeNotifier();
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "OldBuy" })).toBe(0);
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "FreshBuy" })).toBe(1);
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "OldDefend" })).toBe(1);
    expect(tg.to(GROUP_A).map((t) => t.split("\n")[0])).toEqual(["<b>$HOUND Buy!</b>", expect.stringMatching(/^🛡 Floor defended/)]);
  });

  it("catch-up replays launch progress and burns missed while the bot was down", async () => {
    const CHANNEL = -1009999;
    const id = "11111111-2222-3333-4444-555555555555";
    await insertLaunch(db, { id, form: { name: "Dog", ticker: "DOG", triggerBps: 2500 }, depositAddress: addr("dep"), depositIndex: 1n, requiredLamports: 15_000_000n, devBuyLamports: 0n, expiresAt: NOW + 30 * MIN });
    await addTgLaunch(db, id, DM.id);
    await updateLaunchStatus(db, id, "live", { mint: coin.mint });
    await insertHoldBurn(db, { sig: "BurnSig", mint: coin.mint, solSpent: 100_000_000n, holdBurned: 2_500_000_000_000n, ts: NOW - MIN });
    const n = makeNotifier(CHANNEL);
    expect(await n.catchUp(NOW - 15 * MIN)).toBe(2);
    expect(tg.last(DM.id)!.text).toContain("$DOG is LIVE!");
    expect(tg.last(CHANNEL)!.text).toContain("$MOATPAD burned!");
    expect(await n.catchUp(NOW - 15 * MIN)).toBe(0);
  });

  it("catch-up posts the fresh buys made while the bot was down, once", async () => {
    await setBuybot(db, { chatId: GROUP_A, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - 60 * MIN });
    const buy = (sig: string, ts: number) =>
      insertTrade(db, { sig, ixIndex: 0, mint: coin.mint, wallet: addr("buyer"), side: "buy", sol: 100_000_000n, tokens: 5n * TOK, price: 5e-8, ts, slot: 1, source: "curve" });
    await buy("DownBuy", NOW - MIN);
    await buy("StaleBuy", NOW - 5 * MIN);
    const n = makeNotifier();
    expect(await n.catchUp(NOW - 15 * MIN)).toBe(1);
    expect(tg.to(GROUP_A)).toEqual([expect.stringContaining("DownBuy")]);
    expect(await n.catchUp(NOW - 15 * MIN)).toBe(0);
  });

  it("catch-up does not post to a group what happened before it turned the buy bot on", async () => {
    await setBuybot(db, { chatId: GROUP_A, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW });
    await insertTrade(db, { sig: "EarlyBuy", ixIndex: 0, mint: coin.mint, wallet: addr("buyer"), side: "buy", sol: 100_000_000n, tokens: 5n * TOK, price: 5e-8, ts: NOW - MIN, slot: 1, source: "curve" });
    await insertTrade(db, { sig: "EarlyDefend", ixIndex: 0, mint: coin.mint, wallet: coin.treasury, side: "vault", sol: 100_000_000n, tokens: 5n * TOK, price: 5e-8, ts: NOW - MIN, slot: 1, source: "vault" });
    // A replay re-reads events that were handled live before the group had the buy bot: nothing for it.
    expect(await makeNotifier().catchUp(NOW - 15 * MIN)).toBe(0);
    // Live, the grace covers block time and indexing lag: a buy notified after the group turned it on is posted.
    expect(await makeNotifier().handle({ kind: "trade", mint: coin.mint, sig: "EarlyBuy" })).toBe(1);
    expect(tg.to(GROUP_A)).toHaveLength(1);
  });

  it("a catch-up replay of buys posted already takes no throttle slot; the next alert counts only dropped buys", async () => {
    await setBuybot(db, { chatId: GROUP_A, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - 60 * MIN });
    const n = makeNotifier();
    const buy = async (sig: string, at: number) => {
      now = at;
      await insertTrade(db, { sig, ixIndex: 0, mint: coin.mint, wallet: addr(`buyer:${sig}`), side: "buy", sol: 100_000_000n, tokens: 5n * TOK, price: 5e-8, ts: at, slot: 1, source: "curve" });
      return n.handle({ kind: "trade", mint: coin.mint, sig });
    };
    for (let i = 0; i < 10; i++) expect(await buy(`Live${i}`, NOW + i * 1_000)).toBe(1);
    // The database connection came back: catch-up re-reads the ten buys, all posted already.
    now = NOW + 10_000;
    expect(await n.catchUp(NOW - 15 * MIN)).toBe(0);
    for (let i = 0; i < 5; i++) expect(await buy(`After${i}`, NOW + 11_000 + i * 1_000)).toBe(1);
    // 15 alerts this minute: the next two are dropped and counted, and a replay does not post them later.
    expect(await buy("Over1", NOW + 20_000)).toBe(0);
    expect(await buy("Over2", NOW + 21_000)).toBe(0);
    now = NOW + 30_000;
    expect(await n.catchUp(NOW - 15 * MIN)).toBe(0);
    expect(await buy("Later", NOW + 61_000)).toBe(1);
    const alerts = tg.to(GROUP_A);
    expect(alerts).toHaveLength(16);
    expect(alerts.filter((t) => t.includes("since the last alert"))).toEqual([expect.stringContaining("+2 more buys since the last alert")]);
    expect(alerts[15]).toContain("Later");
  });

  it("a buy alert Telegram refused is posted by a later replay", async () => {
    await setBuybot(db, { chatId: GROUP_A, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - 60 * MIN });
    await insertTrade(db, { sig: "Refused1", ixIndex: 0, mint: coin.mint, wallet: addr("buyer"), side: "buy", sol: 100_000_000n, tokens: 5n * TOK, price: 5e-8, ts: NOW - MIN, slot: 1, source: "curve" });
    tg.fail.set(GROUP_A, new TelegramError("sendMessage", 500, "Internal Server Error"));
    const n = makeNotifier();
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "Refused1" })).toBe(0);
    tg.fail.clear();
    expect(await n.catchUp(NOW - 15 * MIN)).toBe(1);
    expect(tg.to(GROUP_A)).toEqual([expect.stringContaining("Refused1")]);
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
    await addTgLaunch(db, id, DM.id);
    const n = makeNotifier();
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(0); // awaiting deposit: nothing to say
    await updateLaunchStatus(db, id, "deposit_received", { receivedLamports: 15_000_000n, sender: addr("s") });
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(1);
    expect(tg.last(DM.id)!.text).toContain("Payment received</b> (0.015 SOL)");
    await updateLaunchStatus(db, id, "creating", {});
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(0);
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

  it("says payment received when the launcher is already creating the coin", async () => {
    // The launcher moves deposit_received → creating within milliseconds: the deposit's notification finds "creating".
    const id = "11111111-2222-3333-4444-777777777777";
    await insertLaunch(db, { id, form: { name: "Dog", ticker: "DOG", triggerBps: 2500 }, depositAddress: addr("dep2"), depositIndex: 2n, requiredLamports: 15_000_000n, devBuyLamports: 0n, expiresAt: NOW + 30 * MIN });
    await addTgLaunch(db, id, DM.id);
    await updateLaunchStatus(db, id, "deposit_received", { receivedLamports: 20_000_000n, sender: addr("s") });
    await updateLaunchStatus(db, id, "creating", {});
    const n = makeNotifier();
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(1);
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(0);
    expect(tg.to(DM.id)).toEqual([expect.stringContaining("Payment received</b> (0.02 SOL)")]);
  });

  it("a failed launch says its SOL was refunded, with the refund", async () => {
    const id = "11111111-2222-3333-4444-888888888888";
    await insertLaunch(db, { id, form: { name: "Dog", ticker: "DOG", triggerBps: 2500 }, depositAddress: addr("dep3"), depositIndex: 3n, requiredLamports: 15_000_000n, devBuyLamports: 0n, expiresAt: NOW + 30 * MIN });
    await addTgLaunch(db, id, DM.id);
    await updateLaunchStatus(db, id, "refunding", { error: "create: Blockhash not found" });
    const n = makeNotifier();
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(0);
    await updateLaunchStatus(db, id, "failed", { refundSig: "RefundSig1" });
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(1);
    const text = tg.last(DM.id)!.text;
    expect(text).toContain("⚠️ The $DOG launch failed: create: Blockhash not found.");
    expect(text).toContain("Your SOL was refunded to the wallet that paid");
    expect(text).toContain('href="https://solscan.io/tx/RefundSig1?cluster=devnet"');
    expect(text).not.toContain("will be refunded");
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
