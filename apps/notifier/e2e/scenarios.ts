/** The user-level scenarios of the end-to-end run, in order (later ones build on earlier state). */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { BurnStats, CoinDetail, CoinSummary, LaunchQuote, LaunchStatus, Page } from "@holdfast/core";
import { getBuybot, getDraft, getLaunch, getTelegramOffset, type LaunchRow } from "@holdfast/db";

import { formatCompact, formatPrice, formatSol, formatSolNumber, formatTokens, shortAddress, solscanAccountUrl, solscanTxUrl } from "../src/format.js";
import type { TgUser } from "../src/telegram.js";
import { address, FLOOR_PRICE_SOL, indexBurn, indexBuyback, indexGraduation, indexLot, indexTrade, insertBotLaunch, registerCoin, runPayoutRound, sig, transition, type E2eCoin, type IndexedTrade } from "./chain-events.js";
import type { SentMessage } from "./fake-telegram.js";
import {
  button,
  callbackData,
  Chat,
  check,
  contains,
  equal,
  eventsSettled,
  getJson,
  indent,
  lacks,
  plain,
  SYSTEM_CHATS,
  updatesSettled,
  urls,
  type Ctx,
} from "./harness.js";
import { sleep } from "./processes.js";

export type Scenario = (name: string, fn: () => Promise<void>) => Promise<void>;

const user = (id: number, first_name: string): TgUser => ({ id, is_bot: false, first_name });
const ALICE = user(5001, "Alice");
const BOB = user(5002, "Bob");
const CAROL = user(5003, "Carol");
const DAVE = user(5004, "Dave");
const ADMIN = user(6001, "Grace");
const MEMBER = user(6002, "Mallory");
const BOT_MEMBER = (bot: TgUser, status: string) => ({ status, user: bot });

const pct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
const enc = encodeURIComponent;

/** A buy as the indexer records it, `sol` SOL at ~3e-8 SOL per token. */
function buyTrade(label: string, sol: number, opts: Partial<IndexedTrade> = {}): IndexedTrade {
  const lamports = BigInt(Math.round(sol * 1e9));
  return {
    sig: sig(label),
    wallet: address(`wallet:${label}`),
    side: "buy",
    lamports,
    tokens: (lamports * 32_000_000n) / 1_000n,
    ts: Date.now(),
    spotAfter: 3.3e-8,
    ...opts,
  };
}

function launchQuestion(m: SentMessage | undefined, step: number): void {
  contains(m, `Step ${step} of 8`);
}

/** Like a database restart or failover: every other session (the services' LISTEN connections too) is cut. */
async function cutDatabaseConnections(ctx: Ctx): Promise<void> {
  ctx.expectedLogErrors.push(/terminating connection due to administrator command|Connection terminated unexpectedly/);
  const killed = await ctx.db.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'");
  check(killed.rows.length > 0, "no database session to cut");
}

/** A lot this old reaches 0.5x weight (0.1x + 0.9x × age / 168 h). */
const HALF_WEIGHT_AGE_MS = 268_800_000;

export async function runScenarios(ctx: Ctx, scenario: Scenario): Promise<void> {
  const { tg, db } = ctx;
  const bot = ctx.botUser;
  const alice = new Chat(ctx, { id: ALICE.id, type: "private" }, ALICE);
  const bob = new Chat(ctx, { id: BOB.id, type: "private" }, BOB);
  const carol = new Chat(ctx, { id: CAROL.id, type: "private" }, CAROL);
  const dave = new Chat(ctx, { id: DAVE.id, type: "private" }, DAVE);
  const g1 = new Chat(ctx, { id: -1001000000501, type: "supergroup", title: "Buy Club" }, MEMBER);
  const coinUrl = (mint: string) => `${ctx.webUrl}/coin/${mint}`;
  const { buy: buyCoin, alert: alertCoin } = ctx.coins;
  let seededMint = "";

  // ---- startup ---------------------------------------------------------------------------------

  await scenario("startup: getMe, then the private and group command menus", async () => {
    const getMe = tg.calls.find((c) => c.method === "getMe");
    check(getMe?.ok, "getMe was not called (the bot needs its username for deep links)");
    const menus = tg.calls.filter((c) => c.method === "setMyCommands");
    const byScope = new Map(menus.map((c) => [(c.params.scope as { type: string }).type, (c.params.commands as { command: string }[]).map((x) => x.command)]));
    equal(byScope.get("default"), ["launch", "coin", "trending", "burns", "buybot", "follow", "unfollow", "watch", "unwatch", "alerts", "stop", "cancel", "help"], "private (default scope) menu");
    equal(byScope.get("all_group_chats"), ["buybot", "coin", "trending", "burns", "help"], "group menu");
    check(menus.every((c) => c.ok), "a setMyCommands call was refused");
    const poll = tg.calls.find((c) => c.method === "getUpdates");
    check(poll && poll.seq > getMe.seq, "getUpdates did not start after getMe");
    equal(poll.params.allowed_updates, ["message", "channel_post", "callback_query", "my_chat_member"], "allowed_updates");
  });

  // ---- private chat basics ---------------------------------------------------------------------

  await scenario("/start: welcome and the menu", async () => {
    const m = await alice.say("/start");
    contains(m, "Welcome to Moatpad", "defends the floor", "What do you want to do?");
    equal(callbackData(m), ["m:launch", "m:trending", "m:burns", "m:help"], "menu buttons");
    check(urls(m).includes(ctx.webUrl), `no ${ctx.webUrl} button`);
  });

  await scenario("/help lists every command", async () => {
    const m = await alice.say("/help");
    contains(m, "/launch", "/coin <address>", "/trending", "/burns", "/buybot", "/follow <address>", "/watch <wallet>", "/alerts", "/cancel", "40% defends the floor", "10% buys and burns $MOATPAD");
    // ... and how to turn alerts off again.
    contains(m, "/unfollow <address>", "/unwatch <wallet>", "/stop - turn off every alert in this chat");
    equal(callbackData(m), ["m:launch"], "help buttons");
    check(urls(m).includes(ctx.webUrl), "no website button");
  });

  await scenario("menu buttons: m:help, m:trending, m:burns, m:launch", async () => {
    const welcome = await alice.say("/start");
    contains(await alice.press("m:help", { on: welcome }), "Moatpad Bot", "/launch");
    contains(await alice.press("m:trending", { on: welcome }), "Trending on Moatpad");
    contains(await alice.press("m:burns", { on: welcome }), "$MOATPAD buy & burn");
    const launch = await alice.press("m:launch", { on: welcome });
    launchQuestion(launch, 1);
    contains(launch, "name");
    contains(await alice.say("/cancel"), "Launch cancelled.");
  });

  await scenario("/burns before any burn matches GET /burns", async () => {
    const api = await getJson<BurnStats>(ctx, "/burns");
    equal(api.burns, 0, "GET /burns count");
    const m = await alice.say("/burns");
    contains(m, "$MOATPAD buy & burn", "No burn has happened yet", `CA: ${ctx.moatCa}`);
    check(urls(m).includes(`https://pump.fun/coin/${ctx.moatCa}`), "no Buy $MOATPAD button");
  });

  await scenario("plain text and unknown commands", async () => {
    const m = await alice.say("hello there");
    contains(m, "What do you want to do?");
    equal(callbackData(m), ["m:launch", "m:trending", "m:burns", "m:help"], "menu buttons");
    contains(await alice.say("/frobnicate"), "Unknown command /frobnicate");
  });

  // ---- market data -----------------------------------------------------------------------------

  await scenario("/trending shows what GET /coins?sort=trending returns", async () => {
    const m = await alice.say("/trending");
    const page = await getJson<Page<CoinSummary>>(ctx, "/coins?sort=trending&limit=5");
    equal(page.items.length, 5, "trending coins from the API");
    seededMint = page.items[0]!.mint;
    page.items.forEach((c, i) => {
      contains(m, `${i + 1}. $${c.ticker} · MC ${formatSolNumber(c.marketCapSol)} SOL · ${pct(c.change24hPct)}`, `🛡 vault ${formatSolNumber(c.vault.floorSol)} SOL · 👥 ${c.holders}`);
      check(m.text.includes(`href="${coinUrl(c.mint)}"`), `no link to ${c.ticker}'s coin page`);
    });
    const order = page.items.map((c) => plain(m).indexOf(`$${c.ticker} ·`));
    check(order.every((v, i) => i === 0 || v > order[i - 1]!), "coins are not in the API's order");
  });

  await scenario("/coin <mint> shows what GET /coins/:mint returns", async () => {
    const m = await alice.say(`/coin ${seededMint}`);
    const d = await getJson<CoinDetail>(ctx, `/coins/${seededMint}`);
    contains(
      m,
      `🪙 ${d.name} ($${d.ticker})`,
      d.mint,
      `📊 Market cap: ${formatSolNumber(d.marketCapSol)} SOL (${pct(d.change24hPct)} 24h)`,
      `💧 Volume 24h: ${formatSolNumber(d.volume24hSol)} SOL`,
      `👥 Holders: ${d.holders.toLocaleString("en-US")}`,
      `🛡 Floor vault: ${formatSolNumber(d.vault.floorSol)} SOL`,
      `💰 Paid to holders: ${formatSolNumber(d.paidOutSol)} SOL`,
      d.graduated ? "Graduated to PumpSwap" : `Bonding curve: ${Math.round(d.bondingCurveProgress * 100)}%`,
    );
    equal(button(m, (b) => b.text.startsWith("🟢 Buy"), "buy").url, coinUrl(d.mint), "buy button URL");
    equal(callbackData(m), [`f:${d.mint}`], "alerts button");
    equal(button(m, (b) => b.text.includes("Buy bot"), "buy bot").url, `https://t.me/${ctx.botUsername}?startgroup=buybot_${d.mint}`, "buy bot deep link (bot username from getMe)");
    // The alerts button follows the coin from a private chat.
    contains(await alice.press(`f:${d.mint}`, { on: m }), `Alerts on for $${d.ticker}`);
    contains(await alice.say(`/unfollow ${d.mint}`), `Alerts off for ${d.mint}`);
  });

  await scenario("/coin with a bad or unknown address gives a plain error", async () => {
    contains(await alice.say("/coin"), "Usage: /coin <coin address>");
    contains(await alice.say("/coin notanaddress"), "notanaddress is not a valid Solana address.");
    const unknown = address("no-such-coin");
    contains(await alice.say(`/coin ${unknown}`), `No Moatpad coin has the address ${unknown}.`);
    const long = await alice.say(`/coin ${"x".repeat(300)}`);
    contains(long, `${"x".repeat(64)} is not a valid Solana address.`);
    lacks(long, "x".repeat(65));
  });

  await scenario("/start coin_<mint> deep link opens the coin card", async () => {
    const m = await alice.say(`/start coin_${seededMint}`);
    contains(m, seededMint, "Market cap:");
  });

  await scenario("/buybot in a private chat: the setup steps and the add-to-group button", async () => {
    for (const m of [await alice.say("/buybot"), await alice.say("/start buybot")]) {
      contains(
        m,
        "🟢 Buy bot",
        "Post every buy of your coin in your Telegram group, for free.",
        "1. Add me to your group (button below)",
        "2. In the group, send: /buybot <coin address>",
        "Optional: only buys above an amount, e.g. /buybot <address> 0.5",
      );
      equal(m.buttons.flat().map((b) => [b.text, b.url]), [["➕ Add to a group", `https://t.me/${ctx.botUsername}?startgroup=buybot`]], "buy bot buttons");
    }
  });

  // ---- the launch wizard -----------------------------------------------------------------------

  const NAME = "Moat Dog E2E";
  const DESCRIPTION = `The moat dog 🐶🛡 guards the floor & pays <holders> every 2 minutes. ${"🐶".repeat(20)}`;
  const creator = Keypair.generate().publicKey.toBase58();
  let imageUrl = "";
  let summaryTotal = "";
  let aliceLaunch: LaunchRow | null = null;

  await scenario("launch: name and ticker (too long, bad ticker refused)", async () => {
    launchQuestion(await alice.say("/launch"), 1);
    equal(callbackData(alice.last), ["l:cancel"], "name step buttons");
    const long = await alice.say("A".repeat(33));
    contains(long, "That name is 33 characters. Please keep it to 32 or less.");
    launchQuestion(long, 1);
    launchQuestion(await alice.say(NAME), 2);
    const bad = await alice.say("MO-AT!");
    contains(bad, "A ticker is 1 to 10 letters or numbers, like MDOG.");
    launchQuestion(bad, 2);
    const image = await alice.say("$mdog");
    launchQuestion(image, 3);
    equal(callbackData(image), ["l:skip:image", "l:cancel"], "image step buttons");
  });

  await scenario("launch: the photo is downloaded from Telegram and uploaded to the API", async () => {
    contains(await alice.say("here is my logo"), "Please send the image as a photo, or tap Skip.");
    const since = tg.cursor;
    const m = await alice.photo("logo-file-1");
    launchQuestion(m, 4);
    const getFile = tg.callsSince(since, "getFile");
    equal(getFile.map((c) => c.params.file_id), ["logo-file-1"], "getFile (the largest photo size)");
    check(tg.downloads.includes("photos/logo-file-1.png"), "the bot never downloaded the file");
    const draft = await getDraft(db, ALICE.id);
    imageUrl = String(draft?.data.imageUrl ?? "");
    check(imageUrl.startsWith(`${ctx.apiUrl}/metadata/`), `imageUrl ${imageUrl} is not served by the API`);
    const res = await fetch(imageUrl);
    equal(res.status, 200, "GET imageUrl");
    check(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(ctx.pngBytes)), "the API serves different bytes than the photo");
    const stored = await readFile(join(ctx.metadataDir, imageUrl.split("/").pop()!));
    check(stored.equals(Buffer.from(ctx.pngBytes)), "the stored upload differs from the photo");
  });

  await scenario("launch: description (too long with emoji refused, HTML and emoji kept)", async () => {
    const tooLong = await alice.say("🐶".repeat(251));
    contains(tooLong, "That description is too long: emoji count as 2 characters, so it is 502 of the 500 allowed.");
    launchQuestion(tooLong, 4);
    launchQuestion(await alice.say(DESCRIPTION), 5);
  });

  await scenario("launch: links (bad refused, X / Telegram / website read)", async () => {
    const bad = await alice.say("not a link");
    contains(bad, "I couldn't read those links");
    launchQuestion(bad, 5);
    const floor = await alice.say("x.com/moatdog t.me/moatdog moatdog.com");
    launchQuestion(floor, 6);
    equal(callbackData(floor), ["l:floor:1500", "l:floor:2500", "l:floor:3500", "l:cancel"], "floor buttons");
  });

  await scenario("launch: floor button and a typed dev buy", async () => {
    contains(await alice.say("25%"), "Please tap one of the floor buttons.");
    const dev = await alice.press("l:floor:1500");
    launchQuestion(dev, 7);
    equal(callbackData(dev), ["l:dev:0", "l:dev:0.1", "l:dev:0.5", "l:dev:1", "l:cancel"], "dev buy buttons");
    contains(await alice.say("11"), "Type an amount from 0 to 10 SOL");
    const creatorQ = await alice.say("0.25 sol");
    launchQuestion(creatorQ, 8);
    equal(callbackData(creatorQ), ["l:payer", "l:cancel"], "creator step buttons");
  });

  await scenario("launch: creator wallet (off-curve refused, typed wallet kept)", async () => {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("moatpad-e2e")], new PublicKey("11111111111111111111111111111111"));
    contains(await alice.say(pda.toBase58()), "That is a program address, not a wallet");
    contains(await alice.say("not-a-wallet"), "That is not a Solana wallet address.");
    contains(await alice.say(creator), "Ready to launch? Check your coin:");
  });

  await scenario("launch: the summary shows the form and the API's quote", async () => {
    const m = alice.last;
    const shown = Array.from(DESCRIPTION).slice(0, 80).join("") + "…";
    contains(
      m,
      `🪙 ${NAME} ($MDOG)`,
      "🖼 Image: added",
      `📝 Description: ${shown}`,
      "🔗 Links: X, Telegram, Website",
      "🛡 Floor: 15% below the all-time high",
      "🛒 Dev buy: 0.25 SOL",
      `💸 Creator fees go to: ${shortAddress(creator)}`,
    );
    equal(callbackData(m), ["l:go", "l:restart", "l:cancel"], "summary buttons");
    const quote = await getJson<LaunchQuote>(ctx, `/launch/quote?devBuySol=0.25&name=${enc(NAME)}&ticker=MDOG`);
    summaryTotal = /Total to pay: ([\d.]+) SOL/.exec(plain(m))?.[1] ?? "";
    equal(summaryTotal, String(quote.requiredSol), "total to pay vs GET /launch/quote for this coin");
  });

  await scenario("launch: Launch creates the API launch with exactly the form", async () => {
    const m = await alice.press("l:go");
    contains(m, "Last step: send the SOL", "This address expires in 30 minutes.");
    const id = await db.query<{ launch_id: string }>("SELECT launch_id FROM tg_launches WHERE chat_id = $1", [String(ALICE.id)]);
    equal(id.rows.length, 1, "launches linked to Alice's chat");
    const row = await getLaunch(db, id.rows[0]!.launch_id);
    check(row, "the launch row does not exist");
    aliceLaunch = row;
    equal(row.status, "awaiting_deposit", "launch status");
    const f = row.form;
    equal(
      { name: f.name, ticker: f.ticker, description: f.description, imageUrl: f.imageUrl, socials: f.socials, triggerBps: f.triggerBps, devBuySol: f.devBuySol, creatorWallet: f.creatorWallet },
      {
        name: NAME,
        ticker: "MDOG",
        description: DESCRIPTION,
        imageUrl,
        socials: { x: "https://x.com/moatdog", telegram: "https://t.me/moatdog", website: "https://moatdog.com/" },
        triggerBps: 1500,
        devBuySol: 0.25,
        creatorWallet: creator,
      },
      "launch form stored by the API",
    );
    const required = Number(row.requiredLamports) / 1e9;
    contains(m, `Send exactly ${required} SOL to this address:`, row.depositAddress);
    equal(summaryTotal, String(required), "the summary's total vs what the launch requires");
    equal(button(m, (b) => b.text.includes("Pay with QR"), "pay").url, `${ctx.webUrl}/pay/${row.id}`, "pay button URL");
    const status = await getJson<LaunchStatus>(ctx, `/launch/${row.id}`);
    equal(
      { name: status.name, ticker: status.ticker, devBuySol: status.devBuySol, expiresAt: status.expiresAt, depositAddress: status.depositAddress, status: status.status },
      { name: NAME, ticker: "MDOG", devBuySol: 0.25, expiresAt: row.expiresAt, depositAddress: row.depositAddress, status: "awaiting_deposit" },
      "GET /launch/:id",
    );
    equal(await getDraft(db, ALICE.id), null, "the draft after launching");
  });

  /** /launch → name → ticker → skips → floor → dev buy → payer → summary. */
  async function quickLaunch(c: Chat, name: string, ticker: string, dev = "l:dev:0", floor = "l:floor:2500"): Promise<SentMessage> {
    launchQuestion(await c.say("/launch"), 1);
    launchQuestion(await c.say(name), 2);
    launchQuestion(await c.say(ticker), 3);
    launchQuestion(await c.press("l:skip:image"), 4);
    launchQuestion(await c.press("l:skip:description"), 5);
    launchQuestion(await c.press("l:skip:links"), 6);
    launchQuestion(await c.press(floor), 7);
    launchQuestion(await c.press(dev), 8);
    const summary = await c.press("l:payer");
    contains(summary, "Ready to launch?");
    return summary!;
  }

  let bobLaunch: LaunchRow | null = null;

  await scenario("launch: Skip, a stale Skip, dev buy button, payer as creator, Start over", async () => {
    launchQuestion(await bob.say("/launch"), 1);
    await bob.say("Skip Coin");
    const imageQ = await bob.say("skip");
    launchQuestion(imageQ, 3);
    launchQuestion(await bob.press("l:skip:image"), 4);
    // The same Skip tapped again (double tap / old message) must not skip the description.
    const stale = await bob.press("l:skip:image", { on: imageQ });
    contains(stale, "That button belongs to another step.");
    launchQuestion(stale, 4);
    launchQuestion(await bob.press("l:skip:description"), 5);
    launchQuestion(await bob.press("l:skip:links"), 6);
    launchQuestion(await bob.press("l:floor:2500"), 7);
    launchQuestion(await bob.press("l:dev:0.5"), 8);
    const summary = await bob.press("l:payer");
    contains(summary, "🪙 Skip Coin ($SKIP)", "Image: none", "Description: none", "Links: none", "Floor: 25%", "Dev buy: 0.5 SOL", "Creator fees go to: the wallet you pay from");
    const quote = await getJson<LaunchQuote>(ctx, `/launch/quote?devBuySol=0.5&name=${enc("Skip Coin")}&ticker=SKIP`);
    contains(summary, `Total to pay: ${quote.requiredSol} SOL`);
    launchQuestion(await bob.press("l:restart", { on: summary }), 1);
    const old = await bob.press("l:go", { on: summary });
    contains(old, "Please finish the steps first.");
    launchQuestion(old, 1);
    const again = await quickLaunch(bob, "Skip Coin", "SKIP", "l:dev:0.5", "l:floor:3500");
    const paid = await bob.press("l:go", { on: again });
    contains(paid, "Last step: send the SOL", "That wallet becomes the creator.");
    const id = await db.query<{ launch_id: string }>("SELECT launch_id FROM tg_launches WHERE chat_id = $1", [String(BOB.id)]);
    equal(id.rows.length, 1, "launches linked to Bob's chat");
    bobLaunch = await getLaunch(db, id.rows[0]!.launch_id);
    const f = bobLaunch!.form;
    equal(
      { name: f.name, ticker: f.ticker, description: f.description ?? null, imageUrl: f.imageUrl ?? null, socials: f.socials ?? null, triggerBps: f.triggerBps, devBuySol: f.devBuySol, creatorWallet: f.creatorWallet ?? null },
      { name: "Skip Coin", ticker: "SKIP", description: null, imageUrl: null, socials: null, triggerBps: 3500, devBuySol: 0.5, creatorWallet: null },
      "launch form stored by the API",
    );
  });

  await scenario("launch: Cancel, and old buttons after cancelling", async () => {
    const nameQ = await bob.say("/launch");
    await bob.say("Cancel Me");
    const imageQ = await bob.say("CNCL");
    const cancelled = await bob.press("l:cancel", { on: imageQ });
    contains(cancelled, "Launch cancelled. Send /launch whenever you want to start again.");
    equal(callbackData(cancelled), ["m:launch"], "after-cancel button");
    equal(await getDraft(db, BOB.id), null, "the draft after cancelling");
    contains(await bob.press("l:cancel", { on: nameQ }), "Nothing to cancel.");
    contains(await bob.press("l:skip:image", { on: imageQ }), "This launch has expired. Send /launch to start a new one.");
    contains(await bob.say("/cancel"), "Nothing to cancel.");
    contains(await bob.say("Cancel Me"), "What do you want to do?");
  });

  let carolLaunches: string[] = [];

  await scenario("launch: per-user limit (3 tries in 10 minutes)", async () => {
    for (let i = 1; i <= 3; i++) {
      const summary = await quickLaunch(carol, `Limit ${i}`, `LIM${i}`);
      contains(await carol.press("l:go", { on: summary }), "Last step: send the SOL");
    }
    const summary = await quickLaunch(carol, "Limit 4", "LIM4");
    const refused = await carol.press("l:go", { on: summary });
    contains(refused, "You tried to launch 3 times in the last 10 minutes.");
    equal(callbackData(refused), ["l:go", "l:restart", "l:cancel"], "buttons after the limit");
    const rows = await db.query<{ launch_id: string }>("SELECT launch_id FROM tg_launches WHERE chat_id = $1 ORDER BY created_at", [String(CAROL.id)]);
    equal(rows.rows.length, 3, "launches created for Carol");
    carolLaunches = rows.rows.map((r) => r.launch_id);
    contains(await carol.say("/cancel"), "Launch cancelled.");
  });

  const erin = new Chat(ctx, { id: 5005, type: "private" }, user(5005, "Erin"));

  await scenario("launch: an image sent as a file works, a too-big one is refused before downloading", async () => {
    launchQuestion(await erin.say("/start launch"), 1);
    await erin.say("File Coin");
    launchQuestion(await erin.say("FILE"), 3);
    const since = tg.cursor;
    const big = await erin.send({ document: { file_id: "big-doc", file_name: "logo.png", mime_type: "image/png", file_size: 6 * 1024 * 1024 } });
    contains(big, "That image is bigger than 5 MB.");
    launchQuestion(big, 3);
    equal(tg.callsSince(since, "getFile").length, 0, "getFile calls for the too-big file");
    launchQuestion(await erin.send({ document: { file_id: "logo-doc", file_name: "logo.png", mime_type: "image/png", file_size: ctx.pngBytes.length } }), 4);
    equal(tg.callsSince(since, "getFile").map((c) => c.params.file_id), ["logo-doc"], "getFile calls");
    const draft = await getDraft(db, erin.id);
    const res = await fetch(String(draft?.data.imageUrl));
    check(res.ok && Buffer.from(await res.arrayBuffer()).equals(Buffer.from(ctx.pngBytes)), "the uploaded file is not served by the API");
    const wrongStep = await erin.photo("late-photo");
    contains(wrongStep, "I'm not asking for an image right now.");
    launchQuestion(wrongStep, 4);
    contains(await erin.say("/cancel"), "Launch cancelled.");
  });

  await scenario("API rate limits the bot per Telegram user (INTERNAL_API_TOKEN), not per notifier IP", async () => {
    // POST /launch allows 10 a minute per key: 12 launches from 4 users within seconds only pass when each user is its own key.
    const users = [5101, 5102, 5103, 5104].map((id) => new Chat(ctx, { id, type: "private" }, user(id, `User${id}`)));
    let launched = 0;
    for (const [u, c] of users.entries()) {
      for (let i = 1; i <= 3; i++) {
        const summary = await quickLaunch(c, `Rate ${u}${i}`, `R${u}X${i}`);
        const paid = await c.press("l:go", { on: summary });
        contains(paid, "Last step: send the SOL");
        launched++;
      }
    }
    equal(launched, 12, "launches created");
  });

  // ---- launch progress, as the launcher reports it ----------------------------------------------

  await scenario("launch progress: deposit received, then LIVE, each once", async () => {
    check(aliceLaunch, "no launch from the wizard scenario");
    const l = aliceLaunch;
    const since = tg.cursor;
    const received = l.requiredLamports + 1_234_000n;
    // watchDeposit, then beginCreation right away (no chain call in between), like the launcher.
    await transition(db, l.id, "deposit_received", { receivedLamports: received, sender: address("payer:alice"), depositSig: sig("deposit:alice"), error: null }, ["awaiting_deposit"]);
    await transition(db, l.id, "creating", { error: null }, ["deposit_received"]);
    // The create / dev-buy transactions take seconds: the bot reports the payment meanwhile.
    await tg.waitForMessage(since, (m) => m.chatId === ALICE.id && plain(m).includes("Payment received"), 15_000, "Payment received");
    const mint = address("mint:mdog");
    await registerCoin(db, { label: "mdog", mint, name: NAME, ticker: "MDOG", floorSol: 0n, createdAt: Date.now() });
    await transition(db, l.id, "live", { mint, refundSig: sig("refund:alice"), error: null }, ["creating"]);
    await tg.waitForMessage(since, (m) => m.chatId === ALICE.id && plain(m).includes("is LIVE!"), 15_000, "the LIVE message");
    // The sweep patches finished launches without changing their status: no new message.
    await transition(db, l.id, "live", { error: null }, ["live"]);
    await eventsSettled(ctx);
    const msgs = tg.messagesSince(since, ALICE.id);
    const paid = msgs.filter((m) => plain(m).includes("Payment received"));
    const live = msgs.filter((m) => plain(m).includes("is LIVE!"));
    equal(paid.length, 1, "Payment received messages");
    equal(live.length, 1, "LIVE messages");
    equal(msgs.length, 2, "messages to Alice");
    check(paid[0]!.seq < live[0]!.seq, "LIVE arrived before Payment received");
    contains(paid[0], `✅ Payment received (${formatSolNumber(Number(received) / 1e9)} SOL)`, "Creating $MDOG on pump.fun");
    contains(live[0], "🚀 $MDOG is LIVE!", `CA: ${mint}`);
    equal(button(live[0], (b) => b.text.includes("Open $MDOG"), "coin").url, coinUrl(mint), "coin button");
    equal(button(live[0], (b) => b.text.includes("buy bot"), "add buy bot").url, `https://t.me/${ctx.botUsername}?startgroup=buybot_${mint}`, "buy bot button");
    const share = button(live[0], (b) => b.text.includes("Share on X"), "share").url ?? "";
    check(share.startsWith("https://x.com/intent/tweet?text=") && decodeURIComponent(share).includes(coinUrl(mint)), `share URL ${share}`);
  });

  await scenario("launch progress: refunded, expired and failed launches", async () => {
    equal(carolLaunches.length, 3, "Carol's launches");
    const [refunded, expired, failed] = carolLaunches as [string, string, string];
    const since = tg.cursor;
    const refundSig = sig("refund:lim1");
    // A deposit after the deadline: refunding, then refunded (launcher watchDeposit + refund).
    await transition(db, refunded, "refunding", { receivedLamports: 30_000_000n, sender: address("payer:carol"), depositSig: sig("deposit:lim1") }, ["awaiting_deposit"]);
    await transition(db, refunded, "refunded", { refundSig }, ["refunding"]);
    await transition(db, expired, "expired", {}, ["awaiting_deposit"]);
    // Paid, then creating failed for good: refunding with the error, then failed once refunded.
    const failSig = sig("refund:lim3");
    await transition(db, failed, "deposit_received", { receivedLamports: 25_000_000n, sender: address("payer:carol"), depositSig: sig("deposit:lim3"), error: null }, ["awaiting_deposit"]);
    await transition(db, failed, "creating", { error: null }, ["deposit_received"]);
    await tg.waitForMessage(since, (m) => m.chatId === CAROL.id && plain(m).includes("Creating $LIM3"), 15_000, "Payment received for $LIM3");
    // Failed attempts are retried with a backoff (onCreateFailure touches the row), then it gives up.
    await transition(db, failed, "creating", { error: "create: Blockhash not found", incrementAttempts: true }, ["creating"]);
    await sleep(300);
    await transition(db, failed, "refunding", { error: "create: Blockhash not found", incrementAttempts: true }, ["creating"]);
    await transition(db, failed, "failed", { refundSig: failSig }, ["refunding"]);
    await eventsSettled(ctx);
    const msgs = tg.messagesSince(since, CAROL.id);
    const one = (needle: string) => {
      const found = msgs.filter((m) => plain(m).includes(needle));
      equal(found.length, 1, `messages containing ${JSON.stringify(needle)}`);
      return found[0]!;
    };
    const r = one("$LIM1 launch was refunded");
    check(r.text.includes(`href="${solscanTxUrl(refundSig, "devnet")}"`), "no Solscan link to the refund");
    contains(r, "The address expired before the launch could start, so the payment was refunded.");
    contains(one("$LIM2 launch expired"), "No payment arrived in time", "it will be refunded automatically");
    contains(one("Payment received"), "Creating $LIM3");
    const f = one("$LIM3 launch failed");
    // The launcher's own error text (transaction logs, signatures) never reaches the user.
    contains(f, "Something went wrong on our side while creating the coin.");
    lacks(f, "Blockhash", "will be refunded");
    contains(f, "refunded");
    check(f.text.includes(`href="${solscanTxUrl(failSig, "devnet")}"`), "no Solscan link to the refund of the failed launch");
    equal(msgs.length, 4, "messages to Carol");
  });

  const ivan = new Chat(ctx, { id: 5008, type: "private" }, user(5008, "Ivan"));

  await scenario("launch progress: a short deposit says what is missing, then the refund says why", async () => {
    const id = await insertBotLaunch(db, ivan.id, "SHORT"); // 0.02 SOL required
    const since = tg.cursor;
    // The user typed a rounded amount: the launcher records it and keeps waiting.
    await transition(db, id, "awaiting_deposit", { receivedLamports: 19_990_000n }, ["awaiting_deposit"]);
    const short = await tg.waitForMessage(since, (m) => m.chatId === ivan.id, 15_000, "the short-deposit message");
    contains(short, "Only part of your $SHORT payment arrived", "Received 0.01999 of the 0.02 SOL needed.", "Send the missing 0.00001 SOL to the same address within");
    equal(urls(short), [`${ctx.webUrl}/pay/${id}`], "pay button");
    // Nothing more came before the deadline: refunding (no error), then refunded.
    await transition(db, id, "refunding", { sender: address("payer:ivan"), depositSig: sig("deposit:short") }, ["awaiting_deposit"]);
    await transition(db, id, "refunded", { refundSig: sig("refund:short") }, ["refunding"]);
    await eventsSettled(ctx);
    const msgs = tg.messagesSince(since, ivan.id);
    equal(msgs.length, 2, "messages to Ivan");
    contains(msgs[1], "Your $SHORT launch was refunded.", "Received 0.01999 of the 0.02 SOL needed, and the full amount did not arrive before the address expired.");
  });

  // ---- groups and the buy bot ------------------------------------------------------------------

  await scenario("group: bot added -> welcome with the /buybot steps", async () => {
    const m = await g1.raw({ my_chat_member: { chat: g1.chat, from: ADMIN, date: Math.floor(Date.now() / 1000), old_chat_member: BOT_MEMBER(bot, "left"), new_chat_member: BOT_MEMBER(bot, "member") } });
    contains(m, "Thanks for adding Moatpad Bot!", "an admin sends:", "/buybot <coin address>");
  });

  await scenario("group: non-admin /buybot refused, admin /buybot <mint> 0.1 enabled", async () => {
    tg.members.set(`${g1.id}:${ADMIN.id}`, "administrator");
    contains(await g1.say(`/buybot ${buyCoin.mint} 0.1`, MEMBER), "Only group admins can set up the buy bot.");
    equal(await getBuybot(db, g1.id), null, "buy bot row after the refusal");
    const on = await g1.say(`/buybot@${ctx.botUsername} ${buyCoin.mint} 0.1`, ADMIN);
    contains(on, `✅ Buy bot on for $${buyCoin.ticker}`, "Every buy of 0.1 SOL or more will be posted here.");
    equal(urls(on), [coinUrl(buyCoin.mint)], "buy bot button");
    equal((await getBuybot(db, g1.id))?.minLamports, 100_000_000n, "min_lamports");
    contains(await g1.say("/buybot", MEMBER), `Buy alerts are on for $${buyCoin.ticker} (buys of 0.1 SOL or more)`);
    await g1.sayNothing(`/buybot@SomeOtherBot ${buyCoin.mint}`, ADMIN);
  });

  await scenario("buy bot: a 0.5 SOL buy -> alert with the right numbers and buttons", async () => {
    const t = buyTrade("buy:0.5", 0.5, { tokens: 16_000_000_000_000n, spotAfter: 3.3e-8 });
    const since = tg.cursor;
    await indexTrade(db, buyCoin, t);
    const m = await tg.waitForMessage(since, (x) => x.chatId === g1.id, 15_000, "the buy alert");
    const d = await getJson<CoinDetail>(ctx, `/coins/${buyCoin.mint}`);
    contains(
      m,
      `$${buyCoin.ticker} Buy!`,
      "🟢".repeat(5),
      "💰 Spent: 0.5 SOL",
      `🪙 Got: ${formatTokens(t.tokens, 6)} ${buyCoin.ticker}`,
      `👤 Buyer: ${shortAddress(t.wallet)} · Txn`,
      `📊 Market cap: ${formatSolNumber(d.marketCapSol)} SOL`,
      `🛡 Floor vault: ${formatSolNumber(d.vault.floorSol)} SOL`,
    );
    equal(formatTokens(t.tokens, 6), "16,000,000", "tokens");
    check(m.text.includes(`href="${solscanAccountUrl(t.wallet, "devnet")}"`), "no buyer link");
    check(m.text.includes(`href="${solscanTxUrl(t.sig, "devnet")}"`), "no transaction link");
    equal(
      m.buttons.flat().map((b) => [b.text, b.url]),
      [
        [`🟢 Buy $${buyCoin.ticker}`, coinUrl(buyCoin.mint)],
        ["🚀 Launch yours", `https://t.me/${ctx.botUsername}?start=launch`],
      ],
      "buy alert buttons",
    );
  });

  await scenario("buy bot: below the minimum, sells and buys older than 2 minutes -> nothing", async () => {
    const small = buyTrade("buy:0.05", 0.05);
    const sell = { ...buyTrade("sell:1", 1), side: "sell" as const };
    const old = buyTrade("buy:old", 0.8, { ts: Date.now() - 3 * 60_000 });
    const control = buyTrade("buy:control", 0.2);
    const since = tg.cursor;
    for (const t of [small, sell, old, control]) await indexTrade(db, buyCoin, t);
    await tg.waitForMessage(since, (m) => m.chatId === g1.id && m.text.includes(control.sig), 15_000, "the control buy alert");
    await eventsSettled(ctx);
    const got = tg.messagesSince(since, g1.id);
    equal(got.length, 1, `alerts in the group (${got.map((m) => indent(plain(m))).join("\n")})`);
    contains(got[0], "💰 Spent: 0.2 SOL");
  });

  await scenario("buy bot: the same notification twice -> one alert", async () => {
    const t = buyTrade("buy:dup", 0.3);
    const since = tg.cursor;
    await indexTrade(db, buyCoin, t, 3);
    await tg.waitForMessage(since, (m) => m.chatId === g1.id, 15_000, "the buy alert");
    await eventsSettled(ctx);
    equal(tg.messagesSince(since, g1.id).length, 1, "alerts for one buy notified three times");
  });

  await scenario("buy bot: a vault buyback -> floor-defence message", async () => {
    const b = { sig: sig("buyback:1"), lamports: 300_000_000n, tokens: 12_000_000_000_000n, ts: Date.now() };
    const since = tg.cursor;
    await indexBuyback(db, buyCoin, b);
    const m = await tg.waitForMessage(since, (x) => x.chatId === g1.id, 15_000, "the floor defence");
    await eventsSettled(ctx);
    contains(m, `🛡 Floor defended: the $${buyCoin.ticker} vault bought back 0.3 SOL at price ${formatPrice(0.3 / 12_000_000)} SOL`, `Floor: ${formatPrice(FLOOR_PRICE_SOL)} SOL per token`);
    check(m.text.includes(`href="${solscanTxUrl(b.sig, "devnet")}"`), "no Solscan link");
    equal(tg.messagesSince(since, g1.id).length, 1, "messages for the buyback (no buy alert)");
  });

  await scenario("group: only admins change alerts (/stop, /unfollow, /follow, /watch)", async () => {
    const refused = "Only group admins";
    contains(await g1.say("/stop", MEMBER), refused);
    contains(await g1.say(`/unfollow ${alertCoin.mint}`, MEMBER), refused);
    contains(await g1.say(`/follow ${alertCoin.mint}`, MEMBER), refused);
    contains(await g1.say(`/watch ${address("wallet:someone")}`, MEMBER), refused);
    const subs = await db.query("SELECT 1 FROM tg_subscriptions WHERE chat_id = $1", [String(g1.id)]);
    equal(subs.rows.length, 0, "subscriptions a non-admin added to the group");
    check(await getBuybot(db, g1.id), "a non-admin /stop removed the buy bot");
  });

  await scenario("group: the alerts button needs an admin", async () => {
    const card = await g1.say(`/coin ${alertCoin.mint}`, MEMBER);
    const since = tg.cursor;
    await g1.press(`f:${alertCoin.mint}`, { on: card, from: MEMBER, expectReply: false });
    const answer = tg.callsSince(since, "answerCallbackQuery")[0];
    check(String(answer?.params.text ?? "").includes("Only group admins"), `toast for a non-admin: ${JSON.stringify(answer?.params.text)}`);
    contains(await g1.press(`f:${alertCoin.mint}`, { on: card, from: ADMIN }), `Alerts on for $${alertCoin.ticker}`);
    contains(await g1.say(`/unfollow ${alertCoin.mint}`, ADMIN), `Alerts off for ${alertCoin.mint}`);
  });

  await scenario("group: /launch and the menu point to the private chat", async () => {
    const m = await g1.say("/launch", MEMBER);
    contains(m, "Launching works in a private chat with me.");
    equal(urls(m), [`https://t.me/${ctx.botUsername}?start=launch`], "deep link");
    const hi = await g1.say("/start", MEMBER);
    contains(hi, "I post buys, floor defences and payouts");
    contains(await g1.press("m:launch", { on: hi, from: MEMBER }), "Launching works in a private chat with me.");
    contains(await g1.press("m:trending", { on: hi, from: MEMBER }), "Trending on Moatpad");
    await g1.sayNothing("gm everyone", MEMBER);
  });

  await scenario("group: admin /buybot off -> no more alerts", async () => {
    contains(await g1.say("/buybot off", MEMBER), "Only group admins can set up the buy bot.");
    contains(await g1.say("/buybot off", ADMIN), "Buy alerts are off for this group.");
    equal(await getBuybot(db, g1.id), null, "buy bot row");
    const since = tg.cursor;
    await indexTrade(db, buyCoin, buyTrade("buy:after-off", 1));
    await eventsSettled(ctx);
    equal(tg.messagesSince(since, g1.id).length, 0, "alerts after /buybot off");
  });

  const g4 = new Chat(ctx, { id: -1001000000504, type: "supergroup", title: "Deep Link Group" }, ADMIN);
  await scenario("group: /start buybot_<mint> deep link (added with startgroup)", async () => {
    tg.members.set(`${g4.id}:${ADMIN.id}`, "creator");
    const hello = await g4.raw({ my_chat_member: { chat: g4.chat, from: ADMIN, date: Math.floor(Date.now() / 1000), old_chat_member: BOT_MEMBER(bot, "left"), new_chat_member: BOT_MEMBER(bot, "administrator") } });
    contains(hello, "Thanks for adding Moatpad Bot!");
    // Added with the private chat's button (startgroup=buybot): no coin yet.
    contains(await g4.say(`/start@${ctx.botUsername} buybot`, ADMIN), "Send /buybot <coin address> to post every buy of a Moatpad coin in this group.");
    equal(await getBuybot(db, g4.id), null, "buy bot row before a coin is given");
    contains(await g4.say(`/start@${ctx.botUsername} buybot_${buyCoin.mint}`, MEMBER), "Only group admins can set up the buy bot.");
    const on = await g4.say(`/start@${ctx.botUsername} buybot_${buyCoin.mint}`, ADMIN);
    contains(on, `Buy bot on for $${buyCoin.ticker}`, "Every buy will be posted here.");
    const since = tg.cursor;
    const t = buyTrade("buy:deeplink", 0.01);
    await indexTrade(db, buyCoin, t);
    const m = await tg.waitForMessage(since, (x) => x.chatId === g4.id, 15_000, "the buy alert in the deep-linked group");
    contains(m, "💰 Spent: 0.01 SOL", "🟢");
  });

  await scenario("restart: a launch change and a buy while the notifier is down are caught up once", async () => {
    check(bobLaunch, "no launch from Bob's wizard");
    const offset = await getTelegramOffset(db);
    const exit = await ctx.notifier.stop();
    equal(exit, 0, "notifier exit code on SIGTERM");
    const since = tg.cursor;
    await transition(db, bobLaunch.id, "expired", {}, ["awaiting_deposit"]);
    const buy = buyTrade("buy:while-down", 0.05);
    await indexTrade(db, buyCoin, buy);
    await ctx.startNotifier();
    await tg.waitForMessage(since, (m) => m.chatId === BOB.id && plain(m).includes("$SKIP launch expired"), 20_000, "the caught-up expiry");
    await tg.waitForMessage(since, (m) => m.chatId === g4.id && m.text.includes(buy.sig), 20_000, "the caught-up buy alert");
    await eventsSettled(ctx);
    await updatesSettled(ctx);
    const sent = tg.messagesSince(since).filter((m) => !SYSTEM_CHATS.has(m.chatId));
    equal(
      sent.map((m) => `${m.chatId}: ${plain(m).split("\n")[0]}`).sort(),
      [`${BOB.id}: ⌛ No payment arrived in time, so the $SKIP launch expired.`, `${g4.id}: $${buyCoin.ticker} Buy!`].sort(),
      "messages sent after the restart",
    );
    const poll = tg.callsSince(since, "getUpdates")[0];
    equal(poll?.params.offset, offset, "first getUpdates offset after the restart");
  });

  await scenario("database connections dropped: events in the gap are caught up after the reconnect", async () => {
    const id = await insertBotLaunch(db, CAROL.id, "GAP");
    const buy = buyTrade("buy:db-gap", 0.06);
    const since = tg.cursor;
    await cutDatabaseConnections(ctx);
    await transition(db, id, "expired", {}, ["awaiting_deposit"]);
    await indexTrade(db, buyCoin, buy);
    await tg.waitForMessage(since, (m) => m.chatId === CAROL.id && plain(m).includes("$GAP launch expired"), 30_000, "the launch change sent during the gap");
    await tg.waitForMessage(since, (m) => m.chatId === g4.id && m.text.includes(buy.sig), 30_000, "the buy alert for the buy during the gap");
    await eventsSettled(ctx);
    equal(tg.messagesSince(since, CAROL.id).length, 1, "messages to Carol");
    equal(tg.messagesSince(since, g4.id).filter((m) => m.text.includes(buy.sig)).length, 1, "alerts for the buy");
    contains(await alice.say("/help"), "Moatpad Bot");
  });

  // ---- private alerts --------------------------------------------------------------------------

  const watched = address("wallet:dave");

  await scenario("/follow, /watch, /alerts", async () => {
    contains(await dave.say(`/follow ${alertCoin.mint}`), `🔔 Alerts on for $${alertCoin.ticker} (${alertCoin.name}).`);
    contains(await dave.say(`/follow ${alertCoin.mint}`), `Alerts are already on for ${alertCoin.mint}.`);
    contains(await dave.say(`/watch ${alertCoin.mint}`), `is the coin $${alertCoin.ticker}, not a wallet`);
    contains(await dave.say("/watch nope"), "nope is not a valid Solana address.");
    contains(await dave.say(`/watch ${watched}`), `👀 Watching wallet ${watched}.`);
    const list = await dave.say("/alerts");
    contains(list, "This chat has 2 of 20 alerts", "Wallets:", `• ${watched}`, "Coins:", `• $${alertCoin.ticker} ${alertCoin.mint}`);
  });

  await scenario("payout round: the watched wallet gets its payout, the follower the round", async () => {
    const since = tg.cursor;
    const other = address("wallet:other-holder");
    const round = await runPayoutRound(db, alertCoin, {
      roundId: 1n,
      potSol: 400_000_000n,
      potTokens: 2_000_000_000n,
      holders: [
        { wallet: watched, amount: 30_000_000_000_000n },
        { wallet: other, amount: 10_000_000_000_000n },
      ],
      now: Date.now(),
    });
    await eventsSettled(ctx);
    const mine = round.entries.find((e) => e.wallet === watched);
    check(mine && mine.sol > 0n, "the watched wallet got nothing in the round");
    const msgs = tg.messagesSince(since, DAVE.id);
    equal(msgs.length, 2, `messages to Dave (${msgs.map((m) => indent(plain(m))).join("\n")})`);
    const payout = msgs.find((m) => plain(m).includes("You earned"));
    contains(payout, `💰 You earned ${formatSol(mine.sol)} SOL (+ ${formatTokens(mine.tokens, 6)} ${alertCoin.ticker}) from $${alertCoin.ticker} round #1`, `Wallet ${shortAddress(watched)}`);
    const totalSol = round.entries.reduce((s, e) => s + e.sol, 0n);
    const totalTokens = round.entries.reduce((s, e) => s + e.tokens, 0n);
    const summary = msgs.find((m) => plain(m).startsWith("Round #1"));
    contains(summary, `Round #1 of $${alertCoin.ticker} paid ${formatSol(totalSol)} SOL (+ ${formatTokens(totalTokens, 6)} ${alertCoin.ticker}) to ${round.entries.length} holders`);
    check(summary!.text.includes(`href="${solscanTxUrl(round.closeSig, "devnet")}"`), "no link to the closing transaction");
  });

  await scenario("graduation reaches the coin's followers once", async () => {
    const since = tg.cursor;
    await indexGraduation(db, alertCoin, Date.now());
    await indexGraduation(db, alertCoin, Date.now());
    await eventsSettled(ctx);
    const msgs = tg.messagesSince(since, DAVE.id);
    equal(msgs.length, 1, "graduation messages");
    contains(msgs[0], `🎓 $${alertCoin.ticker} graduated to PumpSwap`);
  });

  await scenario("/unfollow, /unwatch, /cancel, then no more alerts", async () => {
    contains(await dave.say(`/unfollow ${alertCoin.mint}`), `Alerts off for ${alertCoin.mint}.`);
    contains(await dave.say(`/unfollow ${alertCoin.mint}`), `This chat had no alerts for ${alertCoin.mint}.`);
    contains(await dave.say(`/unwatch ${watched}`), `Stopped watching ${watched}.`);
    contains(await dave.say("/alerts"), "No alerts yet.");
    contains(await dave.say("/cancel"), "Nothing to cancel.");
    const since = tg.cursor;
    await runPayoutRound(db, alertCoin, { roundId: 2n, potSol: 400_000_000n, potTokens: 0n, holders: [{ wallet: watched, amount: 30_000_000_000_000n }], now: Date.now() });
    await eventsSettled(ctx);
    equal(tg.messagesSince(since, DAVE.id).length, 0, "messages after unsubscribing");
  });

  const heidi = new Chat(ctx, { id: 5007, type: "private" }, user(5007, "Heidi"));
  const holder = address("wallet:heidi");

  await scenario("/start follow_<mint> and /start watch_<wallet> deep links turn alerts on", async () => {
    contains(await heidi.say(`/start follow_${alertCoin.mint}`), `🔔 Alerts on for $${alertCoin.ticker} (${alertCoin.name}).`);
    contains(await heidi.say(`/start watch_${address("wallet:heidi-other")}`), `👀 Watching wallet ${address("wallet:heidi-other")}.`);
    contains(await heidi.say("/start watch_notawallet"), "Welcome to Moatpad");
    const list = await heidi.say("/alerts");
    contains(list, "This chat has 2 of 20 alerts", `• ${address("wallet:heidi-other")}`, `• $${alertCoin.ticker} ${alertCoin.mint}`);
    contains(await heidi.say("/stop"), "Removed 2 alerts.");
    contains(await heidi.say("/alerts"), "No alerts yet.");
  });

  await scenario("weight milestone: a watched wallet crossing 0.5x is announced by the startup sweep, once", async () => {
    // A wallet that has held for ~74.7 hours: it reaches 0.5x weight a few seconds after Heidi starts watching it.
    const crossAt = Date.now() + 4_000;
    await indexLot(db, alertCoin, { wallet: holder, amount: 40_000_000_000_000n, acquiredAt: crossAt - HALF_WEIGHT_AGE_MS, sig: sig("buy:heidi") });
    contains(await heidi.say(`/start watch_${holder}`), `👀 Watching wallet ${holder}.`, "when one of its positions reaches 0.5x and full weight");
    check(Date.now() < crossAt - 1_000, "the /watch took so long that the position was already at 0.5x when it started");
    await sleep(crossAt + 300 - Date.now());
    const since = tg.cursor;
    equal(await ctx.notifier.stop(), 0, "notifier exit code on SIGTERM");
    await ctx.startNotifier();
    const m = await tg.waitForMessage(since, (x) => x.chatId === heidi.id, 20_000, "the 0.5x weight milestone");
    contains(m, `⚖️ Your $${alertCoin.ticker} position reached 0.5x weight (now 0.50x); it keeps rising to 1.0x over 7 days of holding`, `Wallet ${shortAddress(holder)}`, `$${alertCoin.ticker} on Moatpad`);
    check(m.text.includes(`href="${coinUrl(alertCoin.mint)}"`), "no link to the coin page");
    // The next startup sweep finds it claimed.
    equal(await ctx.notifier.stop(), 0, "notifier exit code on SIGTERM");
    await ctx.startNotifier();
    await eventsSettled(ctx);
    equal(tg.messagesSince(since, heidi.id).length, 1, "milestone messages to Heidi after two sweeps");
    contains(await heidi.say(`/unwatch ${holder}`), `Stopped watching ${holder}.`);
  });

  // ---- the buy limit ---------------------------------------------------------------------------

  const g6 = new Chat(ctx, { id: -1001000000506, type: "supergroup", title: "Busy Group" }, ADMIN);
  let busyCoin: E2eCoin | null = null;
  let firstBusyAlertAt = 0;

  await scenario("buy limit: 17 buys in a minute -> 15 alerts; a catch-up of posted buys takes no slot", async () => {
    busyCoin = await registerCoin(db, { label: "busy", name: "E2E Busy Coin", ticker: "BUSY", floorSol: 1_000_000_000n, createdAt: Date.now() - 3_600_000 });
    const coin = busyCoin;
    tg.members.set(`${g6.id}:${ADMIN.id}`, "administrator");
    contains(await g6.say(`/buybot ${coin.mint}`), `Buy bot on for $${coin.ticker}`);
    const since = tg.cursor;
    const live = Array.from({ length: 10 }, (_, i) => buyTrade(`busy:live:${i}`, 0.1 + i / 100));
    for (const t of live) await indexTrade(db, coin, t);
    await tg.waitForMessage(since, (m) => m.chatId === g6.id && m.text.includes(live[9]!.sig), 15_000, "the 10th buy alert");
    firstBusyAlertAt = tg.messagesSince(since, g6.id)[0]!.at;
    // The connections drop and come back: the catch-up re-reads the ten buys, all posted already.
    const gap = await insertBotLaunch(db, heidi.id, "GAPB");
    const cut = tg.cursor;
    await cutDatabaseConnections(ctx);
    await transition(db, gap, "expired", {}, ["awaiting_deposit"]);
    await tg.waitForMessage(cut, (m) => m.chatId === heidi.id && plain(m).includes("$GAPB launch expired"), 30_000, "the launch change sent during the gap");
    await eventsSettled(ctx);
    equal(tg.messagesSince(cut, g6.id).length, 0, "alerts the catch-up sent again");
    const more = Array.from({ length: 7 }, (_, i) => buyTrade(`busy:more:${i}`, 0.2 + i / 100));
    for (const t of more) await indexTrade(db, coin, t);
    await tg.waitForMessage(since, (m) => m.chatId === g6.id && m.text.includes(more[4]!.sig), 15_000, "the 15th buy alert");
    await eventsSettled(ctx);
    const alerts = tg.messagesSince(since, g6.id);
    equal(alerts.length, 15, "alerts for 17 buys within a minute");
    const posted = [...live, ...more.slice(0, 5)].map((t) => t.sig);
    equal(
      alerts.map((m) => posted.findIndex((s) => m.text.includes(s))),
      posted.map((_, i) => i),
      "alerts, in order",
    );
    for (const m of alerts) lacks(m, "since the last alert");
    check(Date.now() - firstBusyAlertAt < 60_000, "the 17 buys took more than a minute");
  });

  // ---- $MOATPAD burns --------------------------------------------------------------------------

  await scenario("$MOATPAD burn: posted to the burn channel once", async () => {
    const b = { sig: sig("burn:1"), lamports: 50_000_000n, holdBurned: 1_234_567_000_000n, ts: Date.now() };
    const since = tg.cursor;
    await indexBurn(db, buyCoin, b, 2);
    await eventsSettled(ctx);
    const msgs = tg.messagesSince(since, ctx.burnChatId);
    equal(msgs.length, 1, "burn posts");
    contains(msgs[0], "🔥 $MOATPAD burned!", `The $${buyCoin.ticker} vault bought and burned 1.2M $MOATPAD (0.05 SOL).`, "View on Solscan");
    check(msgs[0]!.text.includes(`href="${solscanTxUrl(b.sig, "devnet")}"`), "no Solscan link");
  });

  await scenario("/burns after burns matches GET /burns", async () => {
    const since = tg.cursor;
    await indexBurn(db, alertCoin, { sig: sig("burn:2"), lamports: 120_000_000n, holdBurned: 3_500_000_000_000n, ts: Date.now() });
    await tg.waitForMessage(since, (m) => m.chatId === ctx.burnChatId, 15_000, "the second burn post");
    const m = await alice.say("/burns");
    const b = await getJson<BurnStats>(ctx, "/burns");
    equal(b.burns, 2, "GET /burns count");
    contains(m, `Burned: ${formatCompact(b.tokensBurned)} $MOATPAD`, `Spent: ${formatSolNumber(b.solSpent)} SOL in 2 burns`, "Latest burns");
    for (const r of b.recent) contains(m, `• ${formatCompact(r.tokensBurned)} $MOATPAD by the $${r.ticker} vault · tx`);
    equal(formatCompact(b.tokensBurned), "4.7M", "burned total");
  });

  // ---- supergroup migration --------------------------------------------------------------------

  await scenario("supergroup migration on an alert: buy bot moved, alert delivered once at the new id", async () => {
    const g2 = new Chat(ctx, { id: -501, type: "group", title: "Old Group" }, ADMIN);
    const to = -1001000000502;
    tg.members.set(`${g2.id}:${ADMIN.id}`, "administrator");
    contains(await g2.say(`/buybot ${buyCoin.mint}`), `Buy bot on for $${buyCoin.ticker}`);
    tg.migrated.set(g2.id, to);
    ctx.expectedRefusals.push((c) => Number(c.params.chat_id) === g2.id && c.errorCode === 400 && /upgraded to a supergroup/.test(c.description ?? ""));
    const since = tg.cursor;
    await indexTrade(db, buyCoin, buyTrade("buy:migrate-1", 0.4));
    await tg.waitForMessage(since, (m) => m.chatId === to, 15_000, "the alert at the supergroup id");
    await indexTrade(db, buyCoin, buyTrade("buy:migrate-2", 0.6));
    await eventsSettled(ctx);
    equal(await getBuybot(db, g2.id), null, "buy bot row at the old id");
    equal((await getBuybot(db, to))?.mint, buyCoin.mint, "buy bot row at the new id");
    const alerts = tg.messagesSince(since, to);
    equal(alerts.length, 2, "alerts at the new id");
    contains(alerts[0], "💰 Spent: 0.4 SOL");
    contains(alerts[1], "💰 Spent: 0.6 SOL");
    const tries = tg.callsSince(since, "sendMessage").filter((c) => Number(c.params.chat_id) === g2.id);
    equal(tries.length, 1, "sends tried at the old id");
  });

  await scenario("supergroup migration on a reply: answered at the new id, buy bot moved", async () => {
    const g3 = new Chat(ctx, { id: -503, type: "group", title: "Old Group 3" }, ADMIN);
    const to = -1001000000503;
    tg.members.set(`${g3.id}:${ADMIN.id}`, "administrator");
    contains(await g3.say(`/buybot ${buyCoin.mint} 0.2`), "Buy bot on");
    tg.migrated.set(g3.id, to);
    ctx.expectedRefusals.push((c) => Number(c.params.chat_id) === g3.id && c.errorCode === 400 && /upgraded to a supergroup/.test(c.description ?? ""));
    const since = tg.cursor;
    tg.push({ message: { message_id: 90_001, date: Math.floor(Date.now() / 1000), chat: g3.chat, from: MEMBER, text: "/buybot" } } as never);
    const m = await tg.waitForMessage(since, (x) => x.chatId === to, 15_000, "the reply at the supergroup id");
    contains(m, `Buy alerts are on for $${buyCoin.ticker} (buys of 0.2 SOL or more)`);
    await updatesSettled(ctx);
    equal(tg.messagesSince(since, to).length, 1, "replies at the new id");
    equal((await getBuybot(db, to))?.minLamports, 200_000_000n, "buy bot row at the new id");
    equal(await getBuybot(db, g3.id), null, "buy bot row at the old id");
  });

  await scenario("supergroup migration service message moves the buy bot", async () => {
    const g5 = new Chat(ctx, { id: -505, type: "group", title: "Old Group 5" }, ADMIN);
    const to = -1001000000505;
    tg.members.set(`${g5.id}:${ADMIN.id}`, "administrator");
    contains(await g5.say(`/buybot ${buyCoin.mint}`), "Buy bot on");
    await g5.raw({ message: { message_id: 90_002, date: Math.floor(Date.now() / 1000), chat: g5.chat, from: ADMIN, migrate_to_chat_id: to } }, false);
    equal((await getBuybot(db, to))?.mint, buyCoin.mint, "buy bot row at the new id");
    const since = tg.cursor;
    await indexTrade(db, buyCoin, buyTrade("buy:migrate-5", 0.7));
    await tg.waitForMessage(since, (m) => m.chatId === to && plain(m).includes("0.7 SOL"), 15_000, "the alert at the new id");
    equal(tg.callsSince(since, "sendMessage").filter((c) => Number(c.params.chat_id) === g5.id).length, 0, "sends to the old id");
  });

  // ---- channels, blocked chats, flood limits ---------------------------------------------------

  await scenario("channel: commands in channel posts are answered, buttons there only get a toast", async () => {
    const ch = new Chat(ctx, { id: ctx.burnChatId, type: "channel", title: "Moatpad Burns" }, ADMIN);
    contains(await ch.say("/burns"), "$MOATPAD buy & burn", "Burned:");
    const card = await ch.say(`/coin ${buyCoin.mint}`);
    contains(card, `$${buyCoin.ticker}`, "Market cap:");
    const since = tg.cursor;
    await ch.press(`f:${buyCoin.mint}`, { on: card, from: MEMBER, expectReply: false });
    const toast = String(tg.callsSince(since, "answerCallbackQuery")[0]?.params.text ?? "");
    check(toast.includes("Buttons don't work in channels"), `toast in a channel: ${JSON.stringify(toast)}`);
    const subs = await db.query("SELECT 1 FROM tg_subscriptions WHERE chat_id = $1", [String(ch.id)]);
    equal(subs.rows.length, 0, "subscriptions a channel button added");
  });

  await scenario("a user who blocked the bot loses their alerts, quietly", async () => {
    const frank = new Chat(ctx, { id: 5006, type: "private" }, user(5006, "Frank"));
    contains(await frank.say(`/follow ${alertCoin.mint}`), `Alerts on for $${alertCoin.ticker}`);
    tg.blocked.add(frank.id);
    ctx.expectedRefusals.push((c) => Number(c.params.chat_id) === frank.id && c.errorCode === 403);
    const since = tg.cursor;
    await runPayoutRound(db, alertCoin, { roundId: 3n, potSol: 400_000_000n, potTokens: 0n, holders: [{ wallet: address("wallet:holder-3"), amount: 30_000_000_000_000n }], now: Date.now() });
    await eventsSettled(ctx);
    equal(tg.callsSince(since, "sendMessage").filter((c) => Number(c.params.chat_id) === frank.id && c.errorCode === 403).length, 1, "refused sends to Frank");
    const subs = await db.query("SELECT 1 FROM tg_subscriptions WHERE chat_id = $1", [String(frank.id)]);
    equal(subs.rows.length, 0, "Frank's subscriptions after he blocked the bot");
    // A reply to a blocked chat is dropped without an error either.
    tg.push({ message: { message_id: 90_003, date: Math.floor(Date.now() / 1000), chat: frank.chat, from: frank.user, text: "/help" } } as never);
    await updatesSettled(ctx);
    tg.blocked.delete(frank.id);
  });

  await scenario("forum topics: a closed General keeps the topic buy bot; a deleted topic falls back to General", async () => {
    const g7 = new Chat(ctx, { id: -1001000000507, type: "supergroup", title: "Forum Group" }, ADMIN);
    tg.members.set(`${g7.id}:${ADMIN.id}`, "administrator");
    const on = await g7.send({ text: `/buybot ${buyCoin.mint}`, message_thread_id: 77, is_topic_message: true });
    contains(on, `Buy bot on for $${buyCoin.ticker}`, "Every buy will be posted in this topic.");
    equal(on.threadId, 77, "topic of the /buybot reply");
    contains(await g7.say(`/follow ${alertCoin.mint}`), `Alerts on for $${alertCoin.ticker}`); // from the General topic
    // The group closes its General topic (overnight, say): the follower alert there is refused, nothing is removed.
    tg.closedTopics.add(`${g7.id}:general`);
    ctx.expectedRefusals.push((c) => Number(c.params.chat_id) === g7.id && c.errorCode === 400 && /TOPIC_CLOSED/.test(c.description ?? ""));
    let since = tg.cursor;
    await runPayoutRound(db, alertCoin, { roundId: 4n, potSol: 400_000_000n, potTokens: 0n, holders: [{ wallet: address("wallet:holder-4"), amount: 30_000_000_000_000n }], now: Date.now() });
    await eventsSettled(ctx);
    const roundTries = tg.callsSince(since, "sendMessage").filter((c) => Number(c.params.chat_id) === g7.id);
    equal(roundTries.map((c) => c.errorCode ?? 200), [400], "round summary sends to the closed General topic");
    equal((await getBuybot(db, g7.id))?.threadId, 77, "buy bot topic after the refusal");
    const subs = await db.query("SELECT 1 FROM tg_subscriptions WHERE chat_id = $1", [String(g7.id)]);
    equal(subs.rows.length, 1, "the group's subscriptions after the refusal");
    // Buys still go to the buy bot's topic.
    since = tg.cursor;
    const first = buyTrade("buy:forum-1", 0.2);
    await indexTrade(db, buyCoin, first);
    const alert = await tg.waitForMessage(since, (m) => m.chatId === g7.id && m.text.includes(first.sig), 15_000, "the buy alert in the buy bot's topic");
    equal(alert.threadId, 77, "topic of the buy alert");
    // General opens again; the buy bot's topic is deleted: its alerts go to General from then on.
    tg.closedTopics.delete(`${g7.id}:general`);
    tg.deletedTopics.add(`${g7.id}:77`);
    ctx.expectedRefusals.push((c) => Number(c.params.chat_id) === g7.id && c.errorCode === 400 && /message thread not found/.test(c.description ?? ""));
    since = tg.cursor;
    const [second, third] = [buyTrade("buy:forum-2", 0.3), buyTrade("buy:forum-3", 0.4)];
    await indexTrade(db, buyCoin, second);
    await indexTrade(db, buyCoin, third);
    await tg.waitForMessage(since, (m) => m.chatId === g7.id && m.text.includes(third.sig), 15_000, "the second buy alert after the topic was deleted");
    await eventsSettled(ctx);
    const buyTries = tg.callsSince(since, "sendMessage").filter((c) => Number(c.params.chat_id) === g7.id && [second.sig, third.sig].some((x) => String(c.params.text).includes(x)));
    equal(
      buyTries.map((c) => [c.errorCode ?? 200, c.params.message_thread_id ?? "general"]),
      [
        [400, 77],
        [200, "general"],
        [200, "general"],
      ],
      "buy alert sends after the topic was deleted",
    );
    equal((await getBuybot(db, g7.id))?.threadId, null, "buy bot topic after the topic was deleted");
  });

  await scenario("group: other bots' commands (/price) get no answer and use up none of the group's replies", async () => {
    const g8 = new Chat(ctx, { id: -1001000000508, type: "supergroup", title: "Many Bots" }, MEMBER);
    for (let i = 0; i < 25; i++) tg.push({ message: { message_id: 91_000 + i, date: Math.floor(Date.now() / 1000), chat: g8.chat, from: MEMBER, text: i % 2 ? "/price" : "/chart" } } as never);
    await updatesSettled(ctx);
    contains(await g8.say("/help"), "Moatpad Bot");
    equal(tg.messagesSince(0, g8.id).length, 1, "messages in the group");
  });

  await scenario("Telegram flood limit (429 retry_after) is waited out, the post arrives once", async () => {
    tg.floodOnce.set(ctx.burnChatId, 1);
    ctx.expectedRefusals.push((c) => Number(c.params.chat_id) === ctx.burnChatId && c.errorCode === 429);
    const since = tg.cursor;
    const b = { sig: sig("burn:flood"), lamports: 10_000_000n, holdBurned: 250_000_000_000n, ts: Date.now() };
    await indexBurn(db, buyCoin, b);
    const m = await tg.waitForMessage(since, (x) => x.chatId === ctx.burnChatId, 15_000, "the burn post after the flood limit");
    contains(m, "250K $MOATPAD");
    await eventsSettled(ctx);
    const tries = tg.callsSince(since, "sendMessage").filter((c) => Number(c.params.chat_id) === ctx.burnChatId);
    equal(tries.map((c) => c.errorCode ?? 200), [429, 200], "sends to the burn channel");
    equal(tg.messagesSince(since, ctx.burnChatId).length, 1, "burn posts");
  });

  let floodedBurnSig = "";

  await scenario("a long flood wait (429 retry_after 6 s) is not waited out: the event queue goes on at once", async () => {
    tg.floodOnce.set(ctx.burnChatId, 6);
    ctx.expectedRefusals.push((c) => Number(c.params.chat_id) === ctx.burnChatId && c.errorCode === 429);
    const since = tg.cursor;
    floodedBurnSig = sig("burn:long-flood");
    const t0 = Date.now();
    await indexBurn(db, buyCoin, { sig: floodedBurnSig, lamports: 10_000_000n, holdBurned: 125_000_000_000n, ts: Date.now() });
    await eventsSettled(ctx);
    check(Date.now() - t0 < 5_000, `the event queue waited ${Date.now() - t0} ms behind the flooded chat`);
    const tries = tg.callsSince(since, "sendMessage").filter((c) => Number(c.params.chat_id) === ctx.burnChatId);
    equal(tries.map((c) => c.errorCode ?? 200), [429], "sends to the burn channel so far");
  });

  await scenario("buy limit: the first alert after the minute counts the buys that were dropped", async () => {
    check(busyCoin && firstBusyAlertAt > 0, "no burst from the buy limit scenario");
    const wait = firstBusyAlertAt + 60_000 + 1_000 - Date.now();
    if (wait > 0) {
      console.log(`[e2e] waiting ${Math.ceil(wait / 1000)}s for the buy limit's one-minute window`);
      await sleep(wait);
    }
    const since = tg.cursor;
    const t = buyTrade("busy:next", 0.3);
    await indexTrade(db, busyCoin, t);
    const m = await tg.waitForMessage(since, (x) => x.chatId === g6.id, 15_000, "the next buy alert");
    contains(m, "💰 Spent: 0.3 SOL", "+2 more buys since the last alert");
    check(m.text.includes(t.sig), "the alert is not for the new buy");
    await eventsSettled(ctx);
    equal(tg.messagesSince(since, g6.id).length, 1, "alerts for the new buy");
  });

  await scenario("the flooded burn post arrives once, with the next retry of failed deliveries", async () => {
    check(floodedBurnSig, "no flooded burn from the flood-wait scenario");
    const m = await tg.waitForMessage(0, (x) => x.chatId === ctx.burnChatId && x.text.includes(floodedBurnSig), 75_000, "the retried burn post");
    contains(m, "125K $MOATPAD");
    await eventsSettled(ctx);
    equal(tg.messages.filter((x) => x.chatId === ctx.burnChatId && x.text.includes(floodedBurnSig)).length, 1, "posts of the flooded burn");
  });

  // ---- hygiene ---------------------------------------------------------------------------------

  await scenario("every pressed button was answered exactly once", async () => {
    const answers = new Map<string, number>();
    for (const c of tg.calls.filter((x) => x.method === "answerCallbackQuery")) {
      const id = String(c.params.callback_query_id);
      answers.set(id, (answers.get(id) ?? 0) + 1);
    }
    const wrong = ctx.pressed.filter((id) => answers.get(id) !== 1);
    equal(wrong, [], "callback queries not answered exactly once");
  });

  await scenario("Telegram refused no Bot API call (except the refusals set up on purpose)", async () => {
    const refused = tg.calls.filter((c) => !c.ok && !ctx.expectedRefusals.some((expected) => expected(c)));
    equal(
      refused.map((c) => `${c.method} ${c.errorCode}: ${c.description}`),
      [],
      "refused calls",
    );
    const unknown = tg.calls.filter((c) => c.errorCode === 404);
    equal(unknown.map((c) => c.method), [], "unknown Bot API methods called");
  });

  await scenario("notifier ops: /healthz and /metrics", async () => {
    const health = await fetch(`${ctx.opsUrl}/healthz`);
    equal(health.status, 200, "notifier /healthz");
    const metrics = await (await fetch(`${ctx.opsUrl}/metrics`)).text();
    check(/notifier_messages_total\{[^}]*result="sent"/.test(metrics), "no sent messages in /metrics");
    check(/notifier_commands_total\{[^}]*command="buybot"/.test(metrics), "no /buybot commands in /metrics");
  });
}
