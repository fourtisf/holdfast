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
  markSent,
  sentKeys,
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
import { buyDots, launchStatusMessage } from "../src/messages.js";
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
  fail: Error | null = null;
  quotes: QuoteRequest[] = [];
  /** The operator keeps launches closed (LAUNCHES_PAUSED): quotes say so. */
  paused = false;
  async quote(req: QuoteRequest) {
    this.quotes.push(req);
    const devBuySol = req.devBuySol;
    const required = Math.round((0.015 + devBuySol * 1.01) * 1e4) / 1e4;
    return { launchFeeSol: 0.015, devBuySol, devBuyExtraSol: 0, requiredSol: required, requiredLamports: String(required * 1e9), specFeeSol: 0.015, exceedsSpecFee: false, launchesPaused: this.paused };
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

/** The steps here follow each other at the same instant: no private reply budget (bot.test.ts tests it). */
const NO_REPLY_BUDGET = { perMinute: 1_000, burst: 1_000 };

function makeBot(): Bot {
  const launch = new LaunchFlow({ db, api, tg, links: LINKS, now: () => now });
  return new Bot({ db, tg, commands: { db, links: LINKS, now: () => now, api, launch, tg }, botUsername: "HoldfastBot", pollTimeoutSec: 30, privateReplies: NO_REPLY_BUDGET });
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
    // /launch asks first whether launches are open; the summary quotes this coin.
    expect(api.quotes).toEqual([{ devBuySol: 0 }, { devBuySol: 0.5, name: "Moat Dog", ticker: "MDOG" }]);
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

    // 3 launch tries per 10 minutes, refused ones included; a try the API never answered, or answered "paused", does not count.
    await send(textUpdate(0, DM, "/cancel"));
    await fill(DM, 7);
    api.fail = new ApiError(503, "Launches are not open yet");
    await send(buttonUpdate(0, DM, "l:go"));
    api.fail = new TypeError("fetch failed");
    await send(buttonUpdate(0, DM, "l:go"));
    api.fail = new ApiError(400, "name is not allowed");
    for (let i = 0; i < 3; i++) await send(buttonUpdate(0, DM, "l:go"));
    expect(tg.last(DM.id)!.text).toBe("⚠️ name is not allowed");
    api.fail = null;
    await send(buttonUpdate(0, DM, "l:go"));
    expect(tg.last(DM.id)!.text).toBe("⚠️ You tried to launch 3 times in the last 10 minutes. Please wait a few minutes, then tap Try again.");
    expect(buttonData(tg.last(DM.id))).toEqual(["l:go", "l:restart", "l:cancel"]);
    expect(api.launchUsers).toEqual([7, 7, 7, 7, 7]);
    // Somebody else is not held up.
    const OTHER = { id: 43, type: "private" as const };
    await fill(OTHER, 8);
    await send(buttonUpdate(0, OTHER, "l:go", 8));
    expect(tg.last(OTHER.id)!.text).toContain("Last step: send the SOL");
    now += 10 * MIN;
    await send(buttonUpdate(0, DM, "l:go"));
    expect(tg.last(DM.id)!.text).toContain("Last step: send the SOL");
    expect(api.launchUsers).toEqual([7, 7, 7, 7, 7, 8, 7]);
  });

  it("checks the name in UTF-8 bytes like pump.fun, so a paid launch is never refused for its name", () => {
    // Fit in 32 characters, not in pump.fun's 32 bytes: the launcher would refund them after payment.
    for (const name of ["Пушистый Кот Монета", "Crème Brûlée Pâtisserie Royale", "🐸 Frog King of the Pond 🐸👑", "月球狗狗币月球狗狗币月"]) {
      const r = applyText("name", {}, name);
      expect(r, name).toEqual({
        ok: false,
        error: `That name is too long for pump.fun: it takes ${Buffer.byteLength(name)} of the 32 bytes allowed, because accented letters, non-Latin letters and emoji take 2 to 4 each. Please make it shorter.`,
      });
    }
    expect(applyText("name", {}, "Café Moat Dog Coin of the Ponds")).toEqual({ ok: true, data: { name: "Café Moat Dog Coin of the Ponds" } }); // 32 bytes
    expect(applyText("name", {}, "🐶".repeat(8))).toMatchObject({ ok: true });
    expect(ask("name", {}).html).toContain("(max 32 characters; accented letters and emoji take 2 to 4 each)");
  });

  it("tells the truth about the dev buy and the creator's share", () => {
    const dev = ask("devbuy", {}).html;
    expect(dev).toContain("You buy your own coin when it launches. Dev-buy tokens go to the wallet that pays and do not earn holder payouts.");
    expect(dev).not.toContain("sniper");
    const creator = ask("creator", {}).html;
    expect(creator).toContain("The creator earns 15% of the coin's creator fees (what each trade pays into its vault)");
    expect(creator).not.toContain("every trading fee");
  });

  it("says a GIF, sticker or video cannot be used at the image step, instead of asking for text", async () => {
    const bot = makeBot();
    let id = 400;
    const send = async (u: TgUpdate) => bot.handleUpdate({ ...u, update_id: id++ });
    for (const t of ["/launch", "Dog", "DOG"]) await send(textUpdate(0, DM, t));
    // A GIF from Telegram's picker arrives as an MP4 animation document.
    await send({ update_id: 0, message: { message_id: 1, date: 0, chat: DM, from: { id: 7, is_bot: false, first_name: "Ann" }, document: { file_id: "GIF1", mime_type: "video/mp4" } } });
    const text = tg.last(DM.id)!.text;
    expect(text).toMatch(/^⚠️ I can't use that kind of file\. Send a picture as a photo, or a PNG\/JPG\/GIF\/WEBP image as a file, or tap Skip\./);
    expect(text).not.toContain("Please answer with text");
    expect((await getDraft(db, DM.id))?.step).toBe("image");
  });

  it("while launches are paused, says so at /launch instead of after the last question", async () => {
    const bot = makeBot();
    let id = 500;
    const send = async (u: TgUpdate) => bot.handleUpdate({ ...u, update_id: id++ });
    api.paused = true;
    await send(textUpdate(0, DM, "/launch"));
    expect(tg.last(DM.id)!.text).toBe("🚧 Launches open soon on Moatpad. I'll be ready when they do.");
    expect(await getDraft(db, DM.id)).toBeNull();
    // A launch already being filled in when they were paused: the summary has no Launch button, and Check again finds them open.
    api.paused = false;
    await send(textUpdate(0, DM, "/launch"));
    for (const t of ["Dog", "DOG"]) await send(textUpdate(0, DM, t));
    api.paused = true;
    for (const b of SKIP_TO_CONFIRM) await send(buttonUpdate(0, DM, b));
    const paused = tg.last(DM.id)!;
    expect(paused.text).toContain("🚧 Launches open soon on Moatpad.");
    expect(paused.text).not.toContain("Total to pay");
    expect(buttonData(paused)).toEqual(["l:recheck", "l:restart", "l:cancel"]);
    api.paused = false;
    await send(buttonUpdate(0, DM, "l:recheck"));
    expect(tg.last(DM.id)!.text).toContain("Total to pay");
    expect(buttonData(tg.last(DM.id))).toEqual(["l:go", "l:restart", "l:cancel"]);
  });

  it("answers a launch the API did not answer with Try again, not with silence", async () => {
    const warnings: string[] = [];
    const launch = new LaunchFlow({ db, api, tg, links: LINKS, now: () => now, log: { warn: (_o, msg) => void warnings.push(msg ?? "") } });
    const bot = new Bot({ db, tg, commands: { db, links: LINKS, now: () => now, api, launch, tg }, botUsername: "HoldfastBot", pollTimeoutSec: 30, privateReplies: NO_REPLY_BUDGET });
    let id = 600;
    const send = async (u: TgUpdate) => bot.handleUpdate({ ...u, update_id: id++ });
    for (const t of ["/launch", "Dog", "DOG"]) await send(textUpdate(0, DM, t));
    for (const b of SKIP_TO_CONFIRM) await send(buttonUpdate(0, DM, b));
    api.fail = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    await send(buttonUpdate(0, DM, "l:go"));
    expect(tg.last(DM.id)!.text).toBe("⚠️ Moatpad is not reachable right now. Please tap Try again in a moment.");
    expect(buttonData(tg.last(DM.id))).toEqual(["l:go", "l:restart", "l:cancel"]);
    expect(warnings).toEqual(["creating a launch failed: the API did not answer"]);
    api.fail = null;
    await send(buttonUpdate(0, DM, "l:go"));
    expect(tg.last(DM.id)!.text).toContain("Last step: send the SOL");
  });

  it("a second tap on Launch shows the launch that is waiting for its SOL, not that it expired", async () => {
    const bot = makeBot();
    let id = 700;
    const send = async (u: TgUpdate) => bot.handleUpdate({ ...u, update_id: id++ });
    for (const t of ["/launch", "Dog", "DOG"]) await send(textUpdate(0, DM, t));
    for (const b of SKIP_TO_CONFIRM) await send(buttonUpdate(0, DM, b));
    await send(buttonUpdate(0, DM, "l:go"));
    const created = api.launches.length;
    // The API answered with a launch id: the API's row is what a real launch looks like.
    await insertLaunch(db, { id: "11111111-2222-3333-4444-555555555555", form: { name: "Dog", ticker: "DOG", triggerBps: 2500 }, depositAddress: addr("deposit"), depositIndex: 9n, requiredLamports: 520_000_000n, devBuyLamports: 0n, expiresAt: now + 30 * MIN });
    await send(buttonUpdate(0, DM, "l:go"));
    const again = tg.last(DM.id)!;
    expect(again.text).toContain("Your launch is already created: send the SOL");
    expect(again.text).toContain("Send exactly <b>0.52 SOL</b> to this address:");
    expect(again.text).toContain(`<code>${addr("deposit")}</code>`);
    expect(again.text).toContain("Sent it already? Don't send it again");
    expect(buttonData(again)).toEqual([`${LINKS.webUrl}/pay/11111111-2222-3333-4444-555555555555`]);
    expect(api.launches).toHaveLength(created);
    // Part of it arrived: only the missing part is asked for, never the full amount again.
    await updateLaunchStatus(db, "11111111-2222-3333-4444-555555555555", "awaiting_deposit", { receivedLamports: 500_000_000n });
    await send(buttonUpdate(0, DM, "l:go"));
    const short = tg.last(DM.id)!;
    expect(short.text).toContain("Only part of your $DOG payment arrived");
    expect(short.text).toContain("Send the missing <b>0.02 SOL</b> to the same address");
    expect(short.text).not.toContain("0.52 SOL</b>");
    expect(buttonData(short)).toEqual([`${LINKS.webUrl}/pay/11111111-2222-3333-4444-555555555555`]);
    // Paid in full (the launch is starting): nothing more to send.
    await updateLaunchStatus(db, "11111111-2222-3333-4444-555555555555", "deposit_received", { receivedLamports: 520_000_000n });
    await send(buttonUpdate(0, DM, "l:go"));
    expect(tg.last(DM.id)!.text).toBe("✅ <b>Payment received</b> (0.52 SOL)\nYour $DOG launch is starting. I'll message you here the moment your coin is live. 🚀");
    await updateLaunchStatus(db, "11111111-2222-3333-4444-555555555555", "awaiting_deposit", { receivedLamports: 0n });
    // Once the address expired, the old button says so.
    now += 31 * MIN;
    await send(buttonUpdate(0, DM, "l:go"));
    expect(tg.last(DM.id)!.text).toBe("This launch has expired. Send /launch to start a new one.");
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

  it("a failed launch says its SOL was refunded, with the refund, and never shows the launcher's internal error", async () => {
    const id = "11111111-2222-3333-4444-888888888888";
    await insertLaunch(db, { id, form: { name: "Dog", ticker: "DOG", triggerBps: 2500 }, depositAddress: addr("dep3"), depositIndex: 3n, requiredLamports: 15_000_000n, devBuyLamports: 0n, expiresAt: NOW + 30 * MIN });
    await addTgLaunch(db, id, DM.id);
    await updateLaunchStatus(db, id, "refunding", { error: "launch failed after 6 attempts (atomic: simulation failed: Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1771. Logs: [...] [rejected 5ig])" });
    const n = makeNotifier();
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(0);
    await updateLaunchStatus(db, id, "failed", { refundSig: "RefundSig1" });
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(1);
    const text = tg.last(DM.id)!.text;
    expect(text).toContain("⚠️ The $DOG launch failed. Something went wrong on our side while creating the coin.");
    expect(text).not.toContain("simulation");
    expect(text).toContain("Your SOL was refunded to the wallet that paid");
    expect(text).toContain('href="https://solscan.io/tx/RefundSig1?cluster=devnet"');
    expect(text).not.toContain("will be refunded");

    // A form the launcher refused is the user's to fix: its reason is shown.
    const id2 = "11111111-2222-3333-4444-888888888889";
    await insertLaunch(db, { id: id2, form: { name: "Dog", ticker: "DOG", triggerBps: 2500 }, depositAddress: addr("dep4"), depositIndex: 4n, requiredLamports: 15_000_000n, devBuyLamports: 0n, expiresAt: NOW + 30 * MIN });
    await addTgLaunch(db, id2, DM.id);
    await updateLaunchStatus(db, id2, "failed", { error: "invalid launch: name must be 1-32 bytes", refundSig: "RefundSig2" });
    expect(await n.handle({ kind: "launch", launchId: id2 })).toBe(1);
    expect(tg.last(DM.id)!.text).toContain("⚠️ The $DOG launch failed: name must be 1-32 bytes.");
  });

  it("tells the user how much is missing when only part of the payment arrived, and why a launch was refunded", async () => {
    const id = "11111111-2222-3333-4444-999999999999";
    await insertLaunch(db, { id, form: { name: "Dog", ticker: "DOG", triggerBps: 2500 }, depositAddress: addr("dep5"), depositIndex: 5n, requiredLamports: 23_456_789n, devBuyLamports: 0n, expiresAt: NOW + 10 * MIN + 30_000 });
    await addTgLaunch(db, id, DM.id);
    const n = makeNotifier();
    // The user typed 0.02345 instead of 0.023456789: the launcher records it and keeps waiting.
    await updateLaunchStatus(db, id, "awaiting_deposit", { receivedLamports: 23_450_000n });
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(1);
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(0);
    const short = tg.last(DM.id)!;
    expect(short.text).toContain("⚠️ <b>Only part of your $DOG payment arrived</b>");
    expect(short.text).toContain("Received 0.02345 of the 0.023456789 SOL needed.");
    expect(short.text).toContain("Send the missing <b>0.000006789 SOL</b> to the same address within 10 minutes:");
    expect(short.text).toContain(`<code>${addr("dep5")}</code>`);
    expect(buttonData(short)).toEqual([`${LINKS.webUrl}/pay/${id}`]);
    // More arrives, still short: told again with the new amount.
    await updateLaunchStatus(db, id, "awaiting_deposit", { receivedLamports: 23_455_000n });
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(1);
    expect(tg.last(DM.id)!.text).toContain("Send the missing <b>0.000001789 SOL</b>");
    // Nothing more came: refunded at expiry, with the reason.
    await updateLaunchStatus(db, id, "refunded", { refundSig: "RefundSig3" });
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(1);
    const refunded = tg.last(DM.id)!.text;
    expect(refunded).toContain("↩️ <b>Your $DOG launch was refunded.</b>\nReceived 0.023455 of the 0.023456789 SOL needed, and the full amount did not arrive before the address expired.");
    expect(refunded).not.toContain("Reason:");

    // Paid in full, but after the address expired.
    const late = "11111111-2222-3333-4444-999999999998";
    await insertLaunch(db, { id: late, form: { name: "Cat", ticker: "CAT", triggerBps: 2500 }, depositAddress: addr("dep6"), depositIndex: 6n, requiredLamports: 15_000_000n, devBuyLamports: 0n, expiresAt: NOW - MIN });
    await addTgLaunch(db, late, DM.id);
    await updateLaunchStatus(db, late, "awaiting_deposit", { receivedLamports: 15_000_000n });
    expect(await n.handle({ kind: "launch", launchId: late })).toBe(0);
    await updateLaunchStatus(db, late, "refunded", { refundSig: "RefundSig4" });
    expect(await n.handle({ kind: "launch", launchId: late })).toBe(1);
    expect(tg.last(DM.id)!.text).toContain("The address expired before the launch could start, so the payment was refunded.");

    // Nothing by the deadline (expired), then a short payment long after it: the launcher's sweep refunds it
    // (expired -> refunding -> refunded with what arrived). The reason must not claim it came in time.
    const lateShort = "11111111-2222-3333-4444-999999999997";
    await insertLaunch(db, { id: lateShort, form: { name: "Eel", ticker: "EEL", triggerBps: 2500 }, depositAddress: addr("dep7"), depositIndex: 7n, requiredLamports: 20_000_000n, devBuyLamports: 0n, expiresAt: NOW - 60 * MIN });
    await addTgLaunch(db, lateShort, DM.id);
    await updateLaunchStatus(db, lateShort, "expired", {});
    expect(await n.handle({ kind: "launch", launchId: lateShort })).toBe(1);
    await updateLaunchStatus(db, lateShort, "refunding", { receivedLamports: 5_000_000n, sender: addr("payer"), depositSig: "LateDeposit" });
    await updateLaunchStatus(db, lateShort, "refunded", { refundSig: "RefundSig5" });
    expect(await n.handle({ kind: "launch", launchId: lateShort })).toBe(1);
    const lateRefund = tg.last(DM.id)!.text;
    expect(lateRefund).toContain("↩️ <b>Your $EEL launch was refunded.</b>\nReceived 0.005 of the 0.02 SOL needed, and the full amount did not arrive before the address expired.");
    expect(lateRefund).not.toContain("arrived before the address expired");
  });

  it("the expired message says a late payment is refunded, and not to reuse the address weeks later", () => {
    const msg = launchStatusMessage(
      LINKS,
      { id: "x", status: "expired", ticker: "DOG", mint: null, depositAddress: addr("d"), requiredLamports: 1n, receivedLamports: 0n, expiresAt: NOW, refundSig: null, error: null },
      NOW,
    );
    expect(msg?.html).toContain("If you sent SOL late, it will be refunded automatically.");
    // The launcher only watches finished launches of the last 30 days for late deposits.
    expect(msg?.html).toContain("Don't reuse the address: SOL sent to it more than 30 days from now is not refunded automatically.");
  });

  it("the LIVE message says when the dev buy was skipped or the leftover refund is still pending", async () => {
    const n = makeNotifier();
    const live = async (suffix: string, error: string | null) => {
      const id = `11111111-2222-3333-4444-77777777770${suffix}`;
      await insertLaunch(db, { id, form: { name: "Dog", ticker: "DOG", triggerBps: 2500 }, depositAddress: addr(`live${suffix}`), depositIndex: BigInt(20 + Number(suffix)), requiredLamports: 15_000_000n, devBuyLamports: 1_000_000_000n, expiresAt: NOW + 30 * MIN });
      await addTgLaunch(db, id, DM.id);
      await updateLaunchStatus(db, id, "live", { mint: coin.mint, error });
      expect(await n.handle({ kind: "launch", launchId: id })).toBe(1);
      return tg.last(DM.id)!.text;
    };
    const skipped = await live("1", "dev buy skipped after 6 failed attempts; its SOL was refunded; refund pending: Blockhash not found");
    expect(skipped).toContain("⚠️ Your dev buy could not be made: its SOL goes back to the wallet that paid, and you hold no tokens from it.");
    expect(skipped).toContain("↩️ Your leftover SOL is still being refunded to the wallet that paid.");
    expect(skipped).not.toContain("Blockhash");
    const clean = await live("2", null);
    expect(clean).not.toContain("dev buy");
    expect(clean).not.toContain("still being refunded");
  });

  const trade = (sig: string, ixIndex: number, wallet: string, side: "buy" | "sell" | "vault", sol: bigint, extra: { ts?: number; slot?: number; price?: number } = {}) =>
    insertTrade(db, { sig, ixIndex, mint: coin.mint, wallet, side, sol, tokens: 5n * TOK, price: extra.price ?? 5e-8, ts: extra.ts ?? NOW - MIN, slot: extra.slot ?? 1, source: side === "vault" ? "vault" : "curve" });

  it("posts one alert per buying wallet and transaction: split buys are summed, a buy sold back at once is not news", async () => {
    await setBuybot(db, { chatId: GROUP_A, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - 60 * MIN });
    await setBuybot(db, { chatId: GROUP_B, mint: coin.mint, minLamports: 1_000_000_000n, createdBy: 9, atMs: NOW - 60 * MIN });
    const [whale, bumper] = [addr("whale"), addr("bumper")];
    // 1.2 SOL bought as three 0.4 SOL instructions, and a bump bot buying 0.05 and selling it back in the same transaction.
    for (let i = 0; i < 3; i++) await trade("Split1", i, whale, "buy", 400_000_000n);
    await trade("Split1", 3, bumper, "buy", 50_000_000n);
    await trade("Split1", 4, bumper, "sell", 49_000_000n);
    const n = makeNotifier();
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "Split1" })).toBe(2);
    for (const chat of [GROUP_A, GROUP_B]) {
      expect(tg.to(chat)).toHaveLength(1);
      expect(tg.last(chat)!.text).toContain("💰 Spent: <b>1.2 SOL</b>");
      expect(tg.last(chat)!.text).toContain("🪙 Got: 15 HOUND");
    }
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "Split1" })).toBe(0);
    // A bump transaction on its own posts nothing either.
    await trade("Bump2", 0, bumper, "buy", 50_000_000n);
    await trade("Bump2", 1, bumper, "sell", 49_000_000n);
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "Bump2" })).toBe(0);
  });

  it("shows the buy's own market cap when a later trade of the same second or transaction moved the price", async () => {
    await setBuybot(db, { chatId: GROUP_A, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - 60 * MIN });
    const at = NOW - MIN; // block times are whole seconds: both trades below share it
    await trade("BuyA", 0, addr("a"), "buy", 500_000_000n, { ts: at, slot: 100, price: 5e-8 });
    await updateLastPrice(db, coin.mint, 5.5e-8, at, 100);
    await trade("SellB", 0, addr("b"), "sell", 900_000_000n, { ts: at, slot: 101, price: 4e-8 });
    await updateLastPrice(db, coin.mint, 3e-8, at, 101);
    // A buy followed by a sell in one transaction.
    await trade("BuySell", 0, addr("c"), "buy", 500_000_000n, { ts: at, slot: 101, price: 4.5e-8 });
    await trade("BuySell", 1, addr("d"), "sell", 500_000_000n, { ts: at, slot: 101, price: 4e-8 });
    const n = makeNotifier();
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "BuyA" })).toBe(1);
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "BuySell" })).toBe(1);
    expect(tg.to(GROUP_A).map((t) => /Market cap: ([\d.]+) SOL/.exec(t)?.[1])).toEqual(["50", "45"]);
  });

  it("a group in a Telegram flood wait does not hold up the queue: its buy is counted in its next alert, not posted late", async () => {
    await setBuybot(db, { chatId: GROUP_A, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - 60 * MIN });
    await setBuybot(db, { chatId: GROUP_B, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - 60 * MIN });
    const outbox = new Outbox(db, tg);
    const n = new Notifier({ db, outbox, links: LINKS, now: () => now });
    tg.fail.set(GROUP_A, new TelegramError("sendMessage", 429, "Too Many Requests: retry after 40", 40));
    await trade("Flood1", 0, addr("x"), "buy", 100_000_000n);
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "Flood1" })).toBe(1);
    expect(tg.to(GROUP_B)).toHaveLength(1);
    tg.fail.clear();
    // A buy that missed its moment stays claimed: nothing to retry.
    expect(outbox.pendingFailures()).toEqual([]);
    expect(await n.retryFailed()).toBe(0);
    expect(tg.to(GROUP_A)).toEqual([]);
    await trade("Flood2", 0, addr("y"), "buy", 100_000_000n);
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "Flood2" })).toBe(2);
    expect(tg.last(GROUP_A)!.text).toContain("+1 more buy since the last alert");
    expect(tg.last(GROUP_B)!.text).not.toContain("since the last alert");
  });

  it("floor defences posted in a buy bot group count against its buy alert budget", async () => {
    await setBuybot(db, { chatId: GROUP_A, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - 60 * MIN });
    const n = makeNotifier();
    await trade("Def1", 0, coin.treasury, "vault", 100_000_000n);
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "Def1" })).toBe(1);
    for (let i = 0; i < 15; i++) {
      await trade(`Many${i}`, 0, addr(`many${i}`), "buy", 100_000_000n);
      await n.handle({ kind: "trade", mint: coin.mint, sig: `Many${i}` });
    }
    // 1 defence + 14 buys: Telegram's ~20 a minute in one group stays out of reach.
    expect(tg.to(GROUP_A)).toHaveLength(15);
  });

  it("posts a buy bot's alerts and defences in the forum topic it was set up in", async () => {
    await setBuybot(db, { chatId: GROUP_A, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - 60 * MIN, threadId: 77 });
    await addSubscription(db, { chatId: DM.id, kind: "coin", target: coin.mint, atMs: NOW - 60 * MIN });
    const n = makeNotifier();
    await trade("TopicBuy", 0, addr("t"), "buy", 100_000_000n);
    await trade("TopicDef", 0, coin.treasury, "vault", 100_000_000n);
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "TopicBuy" })).toBe(1);
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "TopicDef" })).toBe(2);
    expect(tg.sent.map((m) => [m.chatId, m.threadId])).toEqual([
      [GROUP_A, 77],
      [DM.id, undefined],
      [GROUP_A, 77],
    ]);
  });

  it("a group that lets nobody post for now (a night-mode lock) keeps its buy bot and alerts; a bot muted for good loses them", async () => {
    await setBuybot(db, { chatId: GROUP_A, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - 60 * MIN });
    await addSubscription(db, { chatId: GROUP_A, kind: "coin", target: coin.mint, atMs: NOW - 60 * MIN });
    const outbox = new Outbox(db, tg);
    const n = new Notifier({ db, outbox, links: LINKS, now: () => now });
    tg.fail.set(GROUP_A, new TelegramError("sendMessage", 400, "Bad Request: not enough rights to send text messages to the chat"));
    await trade("Locked1", 0, addr("m"), "buy", 100_000_000n);
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "Locked1" })).toBe(0);
    expect(await getBuybot(db, GROUP_A)).toMatchObject({ mint: coin.mint });
    expect(await listChatSubscriptions(db, GROUP_A)).toHaveLength(1);
    // Given up (the claim released), and not retried every minute while the lock lasts.
    expect(await sentKeys(db, GROUP_A, [`buy:Locked1:${addr("m")}`])).toEqual(new Set());
    expect(outbox.pendingFailures()).toEqual([]);
    // The lock lifts in the morning: buys are posted again.
    tg.fail.clear();
    await trade("Locked2", 0, addr("m2"), "buy", 100_000_000n);
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "Locked2" })).toBe(1);
    // Muted for good (Telegram says so with a my_chat_member update): the buy bot and the alerts go.
    const member = (status: string, extra: Record<string, unknown> = {}) => ({ status, user: { id: 1, is_bot: true, first_name: "Bot" }, ...extra });
    await makeBot().handleUpdate({
      update_id: 950,
      my_chat_member: { chat: { id: GROUP_A, type: "supergroup" }, from: { id: 9, is_bot: false, first_name: "Ann" }, old_chat_member: member("member"), new_chat_member: member("restricted", { can_send_messages: false }) },
    });
    expect(await getBuybot(db, GROUP_A)).toBeNull();
    expect(await listChatSubscriptions(db, GROUP_A)).toEqual([]);
  });

  it("a buy posted under the older per-instruction key (buy:<sig>:<ixIndex>) before a restart is not posted again", async () => {
    await setBuybot(db, { chatId: GROUP_A, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - 60 * MIN });
    await setBuybot(db, { chatId: GROUP_B, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - 60 * MIN });
    const whale = addr("whale");
    await trade("Legacy1", 0, whale, "buy", 400_000_000n);
    await trade("Legacy1", 1, whale, "buy", 400_000_000n);
    // The previous version posted one of the two parts in GROUP_A just before the deploy.
    await markSent(db, GROUP_A, "buy:Legacy1:1");
    const n = makeNotifier();
    expect(await n.catchUp(NOW - 15 * MIN)).toBe(1);
    expect(tg.to(GROUP_A)).toEqual([]);
    expect(tg.to(GROUP_B)).toHaveLength(1);
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "Legacy1" })).toBe(0);
  });

  it("retries a delivery that failed on a Telegram or network blip, once Telegram answers again", async () => {
    const id = "11111111-2222-3333-4444-aaaaaaaaaaaa";
    await insertLaunch(db, { id, form: { name: "Dog", ticker: "DOG", triggerBps: 2500 }, depositAddress: addr("depR"), depositIndex: 30n, requiredLamports: 15_000_000n, devBuyLamports: 0n, expiresAt: NOW + 30 * MIN });
    await addTgLaunch(db, id, DM.id);
    await updateLaunchStatus(db, id, "live", { mint: coin.mint });
    const n = makeNotifier();
    expect(await n.retryFailed()).toBe(0); // nothing failed: no replay
    tg.fail.set(DM.id, new TelegramError("sendMessage", 0, "no answer (ECONNREFUSED)"));
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(0);
    expect(await n.retryFailed()).toBe(0); // still down
    tg.fail.clear();
    expect(await n.retryFailed()).toBe(1);
    expect(tg.last(DM.id)!.text).toContain("$DOG is LIVE!");
    expect(await n.retryFailed()).toBe(0);
    expect(tg.to(DM.id)).toHaveLength(1);
  });

  it("gives up a delivery that kept failing for a day", async () => {
    const id = "11111111-2222-3333-4444-bbbbbbbbbbbb";
    await insertLaunch(db, { id, form: { name: "Dog", ticker: "DOG", triggerBps: 2500 }, depositAddress: addr("depG"), depositIndex: 31n, requiredLamports: 15_000_000n, devBuyLamports: 0n, expiresAt: NOW + 30 * MIN });
    await addTgLaunch(db, id, DM.id);
    await updateLaunchStatus(db, id, "live", { mint: coin.mint });
    const outbox = new Outbox(db, tg, { now: () => now });
    const n = new Notifier({ db, outbox, links: LINKS, now: () => now });
    tg.fail.set(DM.id, new TelegramError("sendMessage", 502, "Bad Gateway"));
    expect(await n.handle({ kind: "launch", launchId: id })).toBe(0);
    for (let i = 0; i < 24; i++) {
      now += 60 * MIN;
      expect(await n.retryFailed()).toBe(0);
    }
    expect(outbox.pendingFailures()).toHaveLength(1);
    // Telegram answers again, but the message is a day old now: it is not sent any more.
    tg.fail.clear();
    now += MIN;
    expect(await n.retryFailed()).toBe(0);
    expect(tg.to(DM.id)).toEqual([]);
    expect(outbox.pendingFailures()).toEqual([]);
  });

  it("a burn chat the bot cannot post in is an operator error: logged, its claim released, nothing unsubscribed", async () => {
    const CHANNEL = -1009999;
    const errors: string[] = [];
    const log = { error: (_o: object, msg?: string) => void errors.push(msg ?? ""), warn() {}, info() {}, debug() {} };
    const outbox = new Outbox(db, tg, { log, operatorChats: [CHANNEL] });
    const n = new Notifier({ db, outbox, links: LINKS, burnChatId: CHANNEL, now: () => now, log });
    await addSubscription(db, { chatId: CHANNEL, kind: "coin", target: coin.mint, atMs: NOW - 60 * MIN });
    await insertHoldBurn(db, { sig: "BurnSig", mint: coin.mint, solSpent: 100_000_000n, holdBurned: 2_500_000_000_000n, ts: NOW - MIN });
    tg.fail.set(CHANNEL, new TelegramError("sendMessage", 403, "Forbidden: bot is not a member of the channel chat"));
    expect(await n.handle({ kind: "burn", mint: coin.mint, sig: "BurnSig" })).toBe(0);
    expect(errors).toEqual([
      "the bot cannot post in a configured chat (NOTIFIER_BURN_CHAT_ID): add it there as an admin",
      "a $MOATPAD burn could not be posted to the burn chat",
    ]);
    expect(await listChatSubscriptions(db, CHANNEL)).toHaveLength(1);
    // Fixed (the bot was added as an admin): the next catch-up posts the burn.
    tg.fail.clear();
    expect(await n.catchUp(NOW - 15 * MIN)).toBe(1);
    expect(tg.last(CHANNEL)!.text).toContain("$MOATPAD burned!");
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
