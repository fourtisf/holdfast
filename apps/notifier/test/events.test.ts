import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRoundSnapshot, computeRound, solPerTokenToFixed, weightMultiplier, type RoundInputs } from "@holdfast/core";
import {
  addExcluded,
  addSubscription,
  applyLotConsumptions,
  getBuybot,
  insertLot,
  insertRound,
  insertTrade,
  listChatSubscriptions,
  markGraduated,
  markPayout,
  notify,
  sentKeys,
  setBuybot,
  updateRoundStatus,
  upsertVaultState,
  type Db,
  type NewCoin,
} from "@holdfast/db";

import { crossedMilestones, listenForEvents, multiplierPpm, Notifier, RETRY_BATCH } from "../src/events.js";
import { formatSol, formatTokens, shortAddress } from "../src/format.js";
import { Outbox } from "../src/outbox.js";
import { TelegramError } from "../src/telegram.js";
import { addr, DAY, FakeTelegram, freshDb, H, LINKS, MIN, NOW, resetDb, seedCoin, TOK } from "./helpers.js";

let db: Db;
let tg: FakeTelegram;
let now: number;
let coin: NewCoin;
let notifier: Notifier;

const [alice, bob, carol] = [addr("alice"), addr("bob"), addr("carol")];
const CHAT_A = 101; // watches alice
const CHAT_B = 202; // watches alice and bob
const CHAT_C = 303; // follows the coin

function makeNotifier(): Notifier {
  return new Notifier({ db, outbox: new Outbox(db, tg), links: LINKS, now: () => now });
}

beforeAll(async () => {
  db = await freshDb();
});
beforeEach(async () => {
  await resetDb(db);
  tg = new FakeTelegram();
  now = NOW;
  notifier = makeNotifier();
  coin = await seedCoin(db, "hound");
});
afterAll(async () => {
  await db.close();
});

async function watch(chatId: number, kind: "wallet" | "coin", target: string, atMs = NOW - DAY, threadId?: number): Promise<void> {
  await addSubscription(db, { chatId, kind, target, atMs, threadId });
}

/**
 * Round `roundId` paying alice (7-day lot), bob (fresh lot) and carol, whose payout fails. Payouts are
 * confirmed with sig `pay<roundId>` (unless `confirm: false`) and the round closed (unless `close: false`).
 */
async function closedRound(roundId: number, opts: { ts?: number; potTokens?: bigint; confirm?: boolean; close?: boolean } = {}) {
  const at = opts.ts ?? NOW - 2 * MIN;
  const inputs: RoundInputs = {
    mint: coin.mint,
    roundId: BigInt(roundId),
    snapshotAt: at,
    potSol: 1_000_000_000n,
    potTokens: opts.potTokens ?? 0n,
    params: { minSolLamports: 1_000_000n, minTokensRaw: 1n, rentExemptMinLamports: 890_880n, carryExpiryMs: 0, maxRecipients: 10 },
    holders: [
      { wallet: alice, lots: [{ amount: 1000n * TOK, acquiredAt: at - 7 * DAY }], solBalance: 10n ** 9n, hasTokenAccount: true },
      { wallet: bob, lots: [{ amount: 1000n * TOK, acquiredAt: at }], solBalance: 10n ** 9n, hasTokenAccount: true },
      { wallet: carol, lots: [{ amount: 500n * TOK, acquiredAt: at - DAY }], solBalance: 10n ** 9n, hasTokenAccount: true },
    ],
    carriedIn: [],
  };
  const result = computeRound(inputs);
  await insertRound(db, buildRoundSnapshot(inputs, result, at));
  await updateRoundStatus(db, coin.mint, roundId, "opened", { openSig: `open${roundId}` });
  if (opts.confirm !== false) {
    for (const e of result.entries) {
      // carol's payout failed this round (carried): she must not be told she earned it.
      const status = e.wallet === carol ? "failed" : "confirmed";
      await markPayout(db, { mint: coin.mint, roundId, idx: e.index, status, sig: `pay${roundId}` });
    }
  }
  if (opts.close !== false) await updateRoundStatus(db, coin.mint, roundId, "closed", { closeSig: `close${roundId}` });
  const byWallet = new Map(result.entries.map((e) => [e.wallet, e]));
  return { result, alice: byWallet.get(alice)!, bob: byWallet.get(bob)! };
}

describe("round closed", () => {
  it("fans out payouts to wallet watchers and totals to coin followers", async () => {
    await watch(CHAT_A, "wallet", alice);
    await watch(CHAT_B, "wallet", alice);
    await watch(CHAT_B, "wallet", bob);
    await watch(CHAT_C, "coin", coin.mint);
    await watch(404, "wallet", carol);
    const { alice: a, bob: b } = await closedRound(1, { potTokens: 3000n * TOK });
    expect(a.tokens).toBeGreaterThan(0n);

    expect(await notifier.handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(4);
    const solscan = '<a href="https://solscan.io/tx/pay1?cluster=devnet">Solscan</a>';
    const coinLink = `<a href="https://holdfast.example/coin/${coin.mint}">$HOUND on Moatpad</a>`;
    const aliceMsg = [
      `💰 You earned ${formatSol(a.sol)} SOL (+ ${formatTokens(a.tokens, 6)} HOUND) from $HOUND round #1`,
      `Wallet <code>${shortAddress(alice)}</code>`,
      `${coinLink} · ${solscan}`,
    ].join("\n");
    expect(tg.to(CHAT_A)).toEqual([aliceMsg]);
    // One message per watched wallet: chat B watches both.
    expect(tg.to(CHAT_B)).toHaveLength(2);
    expect(tg.to(CHAT_B)[0]).toBe(aliceMsg);
    expect(tg.to(CHAT_B)[1]).toContain(`💰 You earned ${formatSol(b.sol)} SOL`);
    expect(tg.to(CHAT_B)[1]).toContain(`Wallet <code>${shortAddress(bob)}</code>`);
    // Only confirmed payouts count: carol's failed payout is not announced, nor counted.
    expect(tg.to(404)).toEqual([]);
    expect(tg.to(CHAT_C)).toEqual([
      [
        `Round #1 of $HOUND paid ${formatSol(a.sol + b.sol)} SOL (+ ${formatTokens(a.tokens + b.tokens, 6)} HOUND) to 2 holders`,
        `${coinLink} · <a href="https://solscan.io/tx/close1?cluster=devnet">Solscan</a>`,
      ].join("\n"),
    ]);
  });

  it("is idempotent across repeated notifications and restarts", async () => {
    await watch(CHAT_A, "wallet", alice);
    await watch(CHAT_C, "coin", coin.mint);
    await closedRound(1);
    expect(await notifier.handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(2);
    // The indexer announces the same close again; then the process restarts and catches up.
    expect(await notifier.handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(0);
    expect(await makeNotifier().handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(0);
    expect(await makeNotifier().catchUp(NOW - 15 * MIN)).toBe(0);
    expect(tg.sent).toHaveLength(2);
  });

  it("ignores rounds that are not closed, empty, stale or older than the subscription", async () => {
    await watch(CHAT_A, "wallet", alice);
    await closedRound(1, { confirm: false });
    expect(await notifier.handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(0);
    expect(await notifier.handle({ kind: "round", mint: coin.mint, roundId: 99 })).toBe(0);

    // Paid, but not closed yet.
    await closedRound(2, { close: false });
    expect(await notifier.handle({ kind: "round", mint: coin.mint, roundId: 2 })).toBe(0);

    // Two days old (re-indexed history): never announced.
    await closedRound(3, { ts: NOW - 2 * DAY });
    expect(await notifier.handle({ kind: "round", mint: coin.mint, roundId: 3 })).toBe(0);

    // Closed an hour before chat 505 started watching.
    await closedRound(4, { ts: NOW - H });
    await watch(505, "wallet", alice, NOW);
    expect(await notifier.handle({ kind: "round", mint: coin.mint, roundId: 4 })).toBe(1);
    expect(tg.to(CHAT_A)).toHaveLength(1);
    expect(tg.to(505)).toEqual([]);
  });

  it("retries a refused send later, and drops chats that blocked the bot", async () => {
    await watch(CHAT_A, "wallet", alice);
    await watch(CHAT_B, "wallet", alice);
    await watch(CHAT_B, "coin", coin.mint);
    await watch(CHAT_C, "coin", coin.mint);
    await closedRound(1);
    tg.fail.set(CHAT_A, new TelegramError("sendMessage", 500, "Internal Server Error"));
    tg.fail.set(CHAT_B, new TelegramError("sendMessage", 403, "Forbidden: bot was blocked by the user"));
    expect(await notifier.handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(1);
    expect(tg.to(CHAT_C)).toHaveLength(1);
    expect(await listChatSubscriptions(db, CHAT_B)).toEqual([]);
    expect(await listChatSubscriptions(db, CHAT_A)).toHaveLength(1);

    tg.fail.clear();
    expect(await notifier.handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(1);
    expect(tg.to(CHAT_A)).toHaveLength(1);
    expect(tg.to(CHAT_B)).toEqual([]);
    expect(tg.to(CHAT_C)).toHaveLength(1);
  });
});

describe("floor defence", () => {
  it("announces vault buybacks to coin followers, once", async () => {
    const treasury = coin.treasury;
    await watch(CHAT_C, "coin", coin.mint);
    await watch(CHAT_A, "wallet", treasury);
    await upsertVaultState(db, {
      mint: coin.mint, floorSol: 0n, holderSol: 0n, burnSol: 0n, holderTokens: 0n,
      ath: solPerTokenToFixed(2e-7), floor: solPerTokenToFixed(1.5e-7), defendCount: 1n, lastDefendTs: NOW - MIN,
      roundId: 0n, totalFees: 0n, totalDefended: 150_000_000n, totalPaidSol: 0n, totalPaidTokens: 0n, totalBurnedSol: 0n, creatorSol: 0n, totalCreatorClaimed: 0n, platformSol: 0n, totalPlatformSwept: 0n, slot: 1,
    });
    await insertTrade(db, { sig: "DefSig", ixIndex: 0, mint: coin.mint, wallet: treasury, side: "vault", sol: 150_000_000n, tokens: 1_000_000n * TOK, price: 1.5e-7, ts: NOW - MIN, slot: 10, source: "vault" });
    await insertTrade(db, { sig: "BuySig", ixIndex: 0, mint: coin.mint, wallet: alice, side: "buy", sol: 10_000_000n, tokens: 50n * TOK, price: 2e-7, ts: NOW - MIN, slot: 11, source: "curve" });

    expect(await notifier.handle({ kind: "trade", mint: coin.mint, sig: "DefSig" })).toBe(1);
    expect(tg.to(CHAT_C)).toEqual([
      [
        "🛡 Floor defended: the $HOUND vault bought back 0.15 SOL at price 0.00000015 SOL",
        "Floor: 0.00000015 SOL per token",
        `<a href="https://holdfast.example/coin/${coin.mint}">$HOUND on Moatpad</a> · <a href="https://solscan.io/tx/DefSig?cluster=devnet">Solscan</a>`,
      ].join("\n"),
    ]);
    expect(await notifier.handle({ kind: "trade", mint: coin.mint, sig: "DefSig" })).toBe(0);
    // Ordinary trades, and a sig that names another mint, are not defences.
    expect(await notifier.handle({ kind: "trade", mint: coin.mint, sig: "BuySig" })).toBe(0);
    expect(await notifier.handle({ kind: "trade", mint: addr("other"), sig: "DefSig" })).toBe(0);
    expect(tg.sent).toHaveLength(1);
  });
});

describe("graduation", () => {
  it("announces the graduation once, only to followers from before it", async () => {
    await watch(CHAT_C, "coin", coin.mint);
    expect(await notifier.handle({ kind: "coin", mint: coin.mint })).toBe(0); // not graduated yet
    await markGraduated(db, coin.mint, addr("pool"), NOW - 2 * H);
    await watch(404, "coin", coin.mint, NOW); // followed two hours after the graduation

    expect(await notifier.handle({ kind: "coin", mint: coin.mint })).toBe(1);
    expect(tg.to(CHAT_C)).toEqual([`🎓 $HOUND graduated to PumpSwap\n<a href="https://holdfast.example/coin/${coin.mint}">$HOUND on Moatpad</a>`]);
    expect(await notifier.handle({ kind: "coin", mint: coin.mint })).toBe(0);
    expect(tg.to(404)).toEqual([]);
  });

  it("is replayed by catch-up after downtime", async () => {
    await watch(CHAT_C, "coin", coin.mint);
    await markGraduated(db, coin.mint, addr("pool"), NOW - 5 * MIN);
    await closedRound(1);
    expect(await notifier.catchUp(NOW - 15 * MIN)).toBe(2);
    expect(tg.to(CHAT_C).map((t) => t.split("\n")[0])).toEqual([expect.stringMatching(/^Round #1 of \$HOUND paid/), "🎓 $HOUND graduated to PumpSwap"]);
  });
});

describe("weight milestones", () => {
  it("measures the average weight of a position", () => {
    const lots = [
      { amount: 100n, acquiredAt: NOW - 7 * DAY },
      { amount: 100n, acquiredAt: NOW },
    ];
    expect(multiplierPpm(lots, NOW)).toBe(550_000n); // (1.0 + 0.1) / 2
    expect(multiplierPpm([], NOW)).toBe(0n);
    expect(crossedMilestones(lots, NOW - 7 * DAY, NOW)).toEqual(["0.5"]);
    expect(crossedMilestones(lots, NOW, NOW + 7 * DAY)).toEqual(["1.0"]);
    expect(crossedMilestones(lots, NOW, NOW + 7 * DAY - 1000)).toEqual([]);
  });

  it("sends 0.5x and full weight once each, from a fixed clock", async () => {
    // alice: 4 days in at NOW (0.61x), watched for 5 days. bob: full weight before he was watched.
    await watch(CHAT_A, "wallet", alice, NOW - 5 * DAY);
    await watch(CHAT_B, "wallet", bob, NOW - DAY);
    await insertLot(db, { wallet: alice, mint: coin.mint, amount: 1000n * TOK, acquiredAt: NOW - 4 * DAY, sourceSig: "a1", sourceIx: 0 });
    await insertLot(db, { wallet: bob, mint: coin.mint, amount: 1000n * TOK, acquiredAt: NOW - 8 * DAY, sourceSig: "b1", sourceIx: 0 });
    expect(weightMultiplier(NOW - 4 * DAY, NOW)).toBeCloseTo(0.614, 3);

    expect(await notifier.checkMilestones()).toBe(1);
    expect(tg.to(CHAT_A)).toEqual([
      [
        "⚖️ Your $HOUND position reached 0.5x weight (now 0.61x); it keeps rising to 1.0x over 7 days of holding",
        `Wallet <code>${shortAddress(alice)}</code>`,
        `<a href="https://holdfast.example/coin/${coin.mint}">$HOUND on Moatpad</a>`,
      ].join("\n"),
    ]);
    expect(await notifier.checkMilestones()).toBe(0);

    now = NOW + 3 * DAY - MIN; // 1 minute short of 7 days
    expect(await notifier.checkMilestones()).toBe(0);
    now = NOW + 3 * DAY;
    expect(await makeNotifier().checkMilestones()).toBe(1);
    expect(tg.to(CHAT_A)[1]?.split("\n")[0]).toBe("🏆 Your $HOUND position reached full weight (1.0x): it now earns its full share of every payout");
    expect(await notifier.checkMilestones()).toBe(0);
    expect(tg.to(CHAT_B)).toEqual([]);
  });

  it("skips straight to full weight, and starts over after a sell-out and re-buy", async () => {
    await watch(CHAT_C, "wallet", carol, NOW - 2 * H);
    const lot = await insertLot(db, { wallet: carol, mint: coin.mint, amount: 500n * TOK, acquiredAt: NOW - H, sourceSig: "c1", sourceIx: 0 });
    expect(await notifier.checkMilestones()).toBe(0);

    // The notifier was down for 8 days: only the higher milestone is sent, the lower one is claimed silently.
    now = NOW + 8 * DAY;
    expect(await notifier.checkMilestones()).toBe(1);
    expect(tg.to(CHAT_C)).toHaveLength(1);
    expect(tg.to(CHAT_C)[0]).toContain("full weight");
    expect(await notifier.checkMilestones()).toBe(0);

    // A big buy drags the average below 0.5x; climbing back over it is not announced again.
    const big = await insertLot(db, { wallet: carol, mint: coin.mint, amount: 5000n * TOK, acquiredAt: now, sourceSig: "c2", sourceIx: 0 });
    now += 4 * DAY;
    expect(await notifier.checkMilestones()).toBe(0);

    // Sold everything, bought back: a new position, new milestones.
    await applyLotConsumptions(db, [
      { lotId: lot!, amount: 500n * TOK },
      { lotId: big!, amount: 5000n * TOK },
    ]);
    await insertLot(db, { wallet: carol, mint: coin.mint, amount: 100n * TOK, acquiredAt: now, sourceSig: "c3", sourceIx: 0 });
    now += 4 * DAY;
    expect(await notifier.checkMilestones()).toBe(1);
    expect(tg.to(CHAT_C)[1]).toContain("reached 0.5x weight");
  });

  it("a sell that uses up the oldest lot (FIFO) does not announce full weight again", async () => {
    // W buys lot A, then lot B an hour later, and holds both for 9 days.
    await watch(CHAT_A, "wallet", alice, NOW - 10 * DAY);
    const a = await insertLot(db, { wallet: alice, mint: coin.mint, amount: 100n * TOK, acquiredAt: NOW - 9 * DAY, sourceSig: "a1", sourceIx: 0 });
    await insertLot(db, { wallet: alice, mint: coin.mint, amount: 100n * TOK, acquiredAt: NOW - 9 * DAY + H, sourceSig: "a2", sourceIx: 0 });
    expect(await notifier.checkMilestones()).toBe(1);
    expect(tg.to(CHAT_A)[0]).toContain("reached full weight (1.0x)");
    expect(await notifier.checkMilestones()).toBe(0);
    // Selling exactly lot A's amount empties lot A (FIFO): lot B is still at full weight, the same position.
    await applyLotConsumptions(db, [{ lotId: a!, amount: 100n * TOK }]);
    expect(await notifier.checkMilestones()).toBe(0);
    expect(tg.to(CHAT_A)).toHaveLength(1);
  });

  it("a lot bought after a milestone inherits its claim, so a later FIFO sell keeps it announced", async () => {
    await watch(CHAT_A, "wallet", alice, NOW - 5 * DAY);
    const a = await insertLot(db, { wallet: alice, mint: coin.mint, amount: 1000n * TOK, acquiredAt: NOW - 4 * DAY, sourceSig: "a1", sourceIx: 0 });
    expect(await notifier.checkMilestones()).toBe(1); // 0.5x
    // A second lot (bought an hour after the first, recorded late) is past 0.5x too; then the first lot is sold.
    await insertLot(db, { wallet: alice, mint: coin.mint, amount: 10n * TOK, acquiredAt: NOW - 4 * DAY + H, sourceSig: "a2", sourceIx: 0 });
    expect(await notifier.checkMilestones()).toBe(0);
    await applyLotConsumptions(db, [{ lotId: a!, amount: 1000n * TOK }]);
    expect(await notifier.checkMilestones()).toBe(0);
    expect(tg.to(CHAT_A)).toHaveLength(1);
  });

  it("ignores excluded addresses and unwatched wallets", async () => {
    const pool = addr("pool");
    await addExcluded(db, [{ address: pool, reason: "pool" }]);
    await watch(CHAT_A, "wallet", pool, NOW - 9 * DAY);
    await insertLot(db, { wallet: pool, mint: coin.mint, amount: 10n * TOK, acquiredAt: NOW - 8 * DAY, sourceSig: "p1", sourceIx: 0 });
    await insertLot(db, { wallet: bob, mint: coin.mint, amount: 10n * TOK, acquiredAt: NOW - 4 * DAY, sourceSig: "b1", sourceIx: 0 });
    expect(await notifier.checkMilestones()).toBe(0);
    expect(tg.sent).toEqual([]);
  });
});

describe("forum topics", () => {
  const GROUP = -100500;
  const closed = () => new TelegramError("sendMessage", 400, "Bad Request: TOPIC_CLOSED");
  const buy = (sig: string) =>
    insertTrade(db, { sig, ixIndex: 0, mint: coin.mint, wallet: addr(`buyer:${sig}`), side: "buy", sol: 100_000_000n, tokens: 5n * TOK, price: 2e-7, ts: NOW - MIN, slot: 20, source: "curve" });

  it("posts each alert in the topic /follow or /watch was sent in", async () => {
    await watch(GROUP, "wallet", alice, NOW - DAY, 5);
    await watch(GROUP, "coin", coin.mint, NOW - DAY, 9);
    await watch(CHAT_C, "coin", coin.mint);
    await closedRound(1);
    expect(await notifier.handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(3);
    expect(tg.sent.map((m) => [m.chatId, m.threadId, m.text.startsWith("💰 You earned") ? "payout" : "round"])).toEqual([
      [GROUP, 5, "payout"],
      [GROUP, 9, "round"],
      [CHAT_C, undefined, "round"],
    ]);
  });

  it("a follower alert to a closed General topic is not sent, and the group keeps its topic buy bot and alerts", async () => {
    const outbox = new Outbox(db, tg, { now: () => now });
    const n = new Notifier({ db, outbox, links: LINKS, now: () => now });
    await setBuybot(db, { chatId: GROUP, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - DAY, threadId: 77 });
    await watch(GROUP, "coin", coin.mint); // followed from the General topic
    tg.failIn.set(`${GROUP}:general`, closed());
    await closedRound(1);
    expect(await n.handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(0);
    expect(await getBuybot(db, GROUP)).toMatchObject({ mint: coin.mint, threadId: 77 });
    expect(await listChatSubscriptions(db, GROUP)).toHaveLength(1);
    // Not a failure to retry every minute: the group closed that topic on purpose.
    expect(outbox.pendingFailures()).toEqual([]);
    expect(await sentKeys(db, GROUP, [`round:${coin.mint}:1:coin`])).toEqual(new Set());
    // Buys still go to the buy bot's topic.
    await buy("TopicBuy1");
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "TopicBuy1" })).toBe(1);
    expect(tg.last(GROUP)).toMatchObject({ threadId: 77 });
    // The topic opens again: the round summary is sent then.
    tg.failIn.clear();
    expect(await n.handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(1);
    expect(tg.last(GROUP)!.threadId).toBeUndefined();
  });

  it("a buy bot whose topic was deleted posts in the General topic from then on, without retries", async () => {
    const outbox = new Outbox(db, tg, { now: () => now });
    const n = new Notifier({ db, outbox, links: LINKS, now: () => now });
    await setBuybot(db, { chatId: GROUP, mint: coin.mint, minLamports: 0n, createdBy: 9, atMs: NOW - DAY, threadId: 77 });
    await watch(GROUP, "coin", coin.mint, NOW - DAY, 77);
    await watch(GROUP, "wallet", alice, NOW - DAY, 78);
    tg.failIn.set(`${GROUP}:77`, new TelegramError("sendMessage", 400, "Bad Request: message thread not found"));
    await buy("GoneBuy1");
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "GoneBuy1" })).toBe(1);
    expect(tg.sent.map((m) => [m.chatId, m.threadId])).toEqual([[GROUP, undefined]]);
    expect(await getBuybot(db, GROUP)).toMatchObject({ mint: coin.mint, threadId: null });
    // What else posted in that topic moved too; other topics stay.
    expect((await listChatSubscriptions(db, GROUP)).map((x) => [x.kind, x.threadId])).toEqual([
      ["wallet", 78],
      ["coin", null],
    ]);
    expect(outbox.pendingFailures()).toEqual([]);
    await buy("GoneBuy2");
    expect(await n.handle({ kind: "trade", mint: coin.mint, sig: "GoneBuy2" })).toBe(1);
    expect(tg.sent.map((m) => m.threadId)).toEqual([undefined, undefined]);
  });
});

describe("failed deliveries", () => {
  it("only a failure a later attempt may fix is retried", async () => {
    const outbox = new Outbox(db, tg, { now: () => now });
    const n = new Notifier({ db, outbox, links: LINKS, now: () => now });
    await watch(CHAT_C, "coin", coin.mint);
    await closedRound(1);
    tg.fail.set(CHAT_C, new TelegramError("sendMessage", 400, "Bad Request: message is too long"));
    expect(await n.handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(0);
    expect(outbox.pendingFailures()).toEqual([]);
    tg.fail.set(CHAT_C, new TelegramError("sendMessage", 502, "Bad Gateway"));
    expect(await n.handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(0);
    expect(outbox.pendingFailures()).toEqual([{ chatId: CHAT_C, eventKey: `round:${coin.mint}:1:coin`, event: { kind: "round", mint: coin.mint, roundId: 1 }, since: NOW, seq: 1 }]);
  });

  it("a long outage loses nothing: a failed delivery is retried until it gets through, and a run stops at the first one failing again", async () => {
    const outbox = new Outbox(db, tg, { now: () => now });
    const n = new Notifier({ db, outbox, links: LINKS, now: () => now });
    await watch(CHAT_B, "coin", coin.mint);
    await watch(CHAT_C, "coin", coin.mint);
    await closedRound(1); // closed 2 minutes ago
    const down = new TelegramError("sendMessage", 0, "no answer (ECONNREFUSED)");
    tg.fail.set(CHAT_B, down);
    tg.fail.set(CHAT_C, down);
    expect(await n.handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(0);
    // Telegram stays unreachable for 25 minutes; the notifier retries every minute, one send per run while nothing gets through.
    const deliver = vi.spyOn(outbox, "deliver");
    for (let i = 0; i < 25; i++) {
      now += MIN;
      expect(await n.retryFailed()).toBe(0);
    }
    expect(deliver.mock.calls.map((c) => c[0])).toEqual(Array.from({ length: 25 }, (_, i) => (i % 2 ? CHAT_C : CHAT_B)));
    // The one that failed last goes last: neither waits behind the other for good.
    expect(outbox.pendingFailures().map((f) => [f.chatId, f.since])).toEqual([
      [CHAT_C, NOW],
      [CHAT_B, NOW],
    ]);
    tg.fail.clear();
    now += MIN;
    expect(await n.retryFailed()).toBe(2);
    expect(tg.sent.map((m) => m.chatId)).toEqual([CHAT_C, CHAT_B]);
    // Everything got through: nothing more to retry until the next failure.
    expect(outbox.pendingFailures()).toEqual([]);
    expect(await n.retryFailed()).toBe(0);
  });

  it("a send that got no answer after it went out may have been posted: its claim is kept, it is never sent again, and it ends a retry run", async () => {
    const outbox = new Outbox(db, tg, { now: () => now });
    const n = new Notifier({ db, outbox, links: LINKS, now: () => now });
    await watch(CHAT_B, "coin", coin.mint);
    await watch(CHAT_C, "coin", coin.mint);
    await closedRound(1);
    const key = `round:${coin.mint}:1:coin`;
    const timedOut = new TelegramError("sendMessage", 0, "no answer (TimeoutError)", undefined, undefined, true);
    // Live: no retry, and the claim stays (a catch-up or a repeated NOTIFY sends nothing).
    tg.fail.set(CHAT_B, timedOut);
    expect(await n.handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(1);
    expect(outbox.pendingFailures()).toEqual([]);
    expect(await sentKeys(db, CHAT_B, [key])).toEqual(new Set([key]));
    tg.fail.clear();
    expect(await n.handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(0);
    expect(tg.sent.map((m) => m.chatId)).toEqual([CHAT_C]);
    // Retried after a refused connection, then Telegram turns slow: the first timeout ends the run, and is given up.
    await closedRound(2);
    const refused = new TelegramError("sendMessage", 0, "no answer (ECONNREFUSED)");
    tg.fail.set(CHAT_B, refused);
    tg.fail.set(CHAT_C, refused);
    expect(await n.handle({ kind: "round", mint: coin.mint, roundId: 2 })).toBe(0);
    expect(outbox.pendingFailures().map((f) => f.chatId)).toEqual([CHAT_B, CHAT_C]);
    tg.fail.set(CHAT_B, timedOut);
    tg.fail.set(CHAT_C, timedOut);
    const deliver = vi.spyOn(outbox, "deliver");
    now += MIN;
    expect(await n.retryFailed()).toBe(0);
    expect(deliver.mock.calls.map((c) => c[0])).toEqual([CHAT_B]);
    expect(outbox.pendingFailures().map((f) => f.chatId)).toEqual([CHAT_C]);
    tg.fail.clear();
    for (let i = 0; i < 3; i++) {
      now += MIN;
      await n.retryFailed();
    }
    expect(tg.sent.map((m) => m.chatId)).toEqual([CHAT_C, CHAT_C]);
    expect(outbox.pendingFailures()).toEqual([]);
  });

  it("a delivery whose event fails to be handled again goes last: the other failed deliveries still get through", async () => {
    const outbox = new Outbox(db, tg, { now: () => now });
    const n = new Notifier({ db, outbox, links: LINKS, now: () => now });
    await watch(CHAT_B, "coin", coin.mint);
    await closedRound(1);
    await closedRound(2);
    tg.fail.set(CHAT_B, new TelegramError("sendMessage", 502, "Bad Gateway"));
    expect(await n.handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(0);
    expect(await n.handle({ kind: "round", mint: coin.mint, roundId: 2 })).toBe(0);
    tg.fail.clear();
    // Round 1 can no longer be handled (its data changed since the first try): its handler throws on every retry.
    type Handlers = { roundChanged(mint: string, roundId: number, scope: object): Promise<number> };
    const handlers = n as unknown as Handlers;
    const roundChanged = handlers.roundChanged.bind(n);
    const broken = vi.spyOn(handlers, "roundChanged").mockImplementation(async (mint, roundId, scope) => {
      if (roundId === 1) throw new Error("round 1 changed under us");
      return roundChanged(mint, roundId, scope);
    });
    const keys = () => outbox.pendingFailures().map((f) => f.eventKey);
    now += MIN;
    expect(await n.retryFailed()).toBe(0);
    expect(keys()).toEqual([`round:${coin.mint}:2:coin`, `round:${coin.mint}:1:coin`]);
    now += MIN;
    expect(await n.retryFailed()).toBe(1);
    expect(tg.to(CHAT_B)).toEqual([expect.stringContaining("Round #2 of $HOUND paid")]);
    expect(outbox.pendingFailures().map((f) => [f.eventKey, f.since])).toEqual([[`round:${coin.mint}:1:coin`, NOW]]);
    // Once it can be handled again, it is sent too.
    broken.mockRestore();
    now += MIN;
    expect(await n.retryFailed()).toBe(1);
    expect(tg.to(CHAT_B)).toHaveLength(2);
    expect(outbox.pendingFailures()).toEqual([]);
  });

  it("retries only what failed: a chat that stays in a flood wait holds up nothing, and the others' messages are not made again", async () => {
    const outbox = new Outbox(db, tg, { now: () => now });
    const n = new Notifier({ db, outbox, links: LINKS, now: () => now });
    for (const chat of [CHAT_A, CHAT_B, CHAT_C]) await watch(chat, "coin", coin.mint);
    await closedRound(1);
    // A Telegram blip for two chats, and a long flood wait for CHAT_C (a busy group at Telegram's per-group limit).
    for (const chat of [CHAT_A, CHAT_B]) tg.fail.set(chat, new TelegramError("sendMessage", 502, "Bad Gateway"));
    tg.fail.set(CHAT_C, new TelegramError("sendMessage", 429, "Too Many Requests: retry after 600", 600));
    tg.floodWait.set(CHAT_C, 600_000);
    expect(await n.handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(0);
    expect(outbox.pendingFailures().map((f) => f.chatId)).toEqual([CHAT_A, CHAT_B, CHAT_C]);
    tg.fail.delete(CHAT_A);
    tg.fail.delete(CHAT_B);
    const deliver = vi.spyOn(outbox, "deliver");
    now += MIN;
    expect(await n.retryFailed()).toBe(2);
    expect(deliver.mock.calls.map((c) => c[0])).toEqual([CHAT_A, CHAT_B]);
    // The next round reaches A and B live; CHAT_C's wait goes on through an hour of retries, which make no send at all.
    await closedRound(2, { ts: now - MIN });
    expect(await n.handle({ kind: "round", mint: coin.mint, roundId: 2 })).toBe(2);
    deliver.mockClear();
    for (let i = 0; i < 60; i++) {
      now += MIN;
      expect(await n.retryFailed()).toBe(0);
    }
    expect(deliver).not.toHaveBeenCalled();
    expect(outbox.pendingFailures().map((f) => [f.chatId, f.eventKey, f.since])).toEqual([
      [CHAT_C, `round:${coin.mint}:1:coin`, NOW],
      [CHAT_C, `round:${coin.mint}:2:coin`, NOW + MIN],
    ]);
    // The wait is over: CHAT_C gets both rounds, once.
    tg.fail.clear();
    tg.floodWait.clear();
    now += MIN;
    expect(await n.retryFailed()).toBe(2);
    expect(deliver.mock.calls.map((c) => c[0])).toEqual([CHAT_C, CHAT_C]);
    expect(tg.to(CHAT_C)).toHaveLength(2);
    expect(tg.sent).toHaveLength(6);
    expect(outbox.pendingFailures()).toEqual([]);
  });

  it(`retries at most ${RETRY_BATCH} deliveries a run`, async () => {
    const outbox = new Outbox(db, tg, { now: () => now });
    const n = new Notifier({ db, outbox, links: LINKS, now: () => now });
    const chats = Array.from({ length: RETRY_BATCH + 10 }, (_, i) => 1000 + i);
    for (const chat of chats) await watch(chat, "coin", coin.mint);
    await closedRound(1);
    for (const chat of chats) tg.fail.set(chat, new TelegramError("sendMessage", 502, "Bad Gateway"));
    expect(await n.handle({ kind: "round", mint: coin.mint, roundId: 1 })).toBe(0);
    tg.fail.clear();
    now += MIN;
    expect(await n.retryFailed()).toBe(RETRY_BATCH);
    expect(outbox.pendingFailures()).toHaveLength(10);
    now += MIN;
    expect(await n.retryFailed()).toBe(10);
    expect(tg.sent).toHaveLength(chats.length);
    expect(outbox.pendingFailures()).toEqual([]);
  });

  it("starts no delivery once shutdown has begun, and releases a claim the caller holds", async () => {
    const abort = new AbortController();
    const outbox = new Outbox(db, tg, { signal: abort.signal });
    abort.abort();
    expect(await outbox.deliver(CHAT_A, "k1", "hi", "payout")).toBe("stopped");
    expect(await outbox.claim(CHAT_A, "k2")).toBe(true);
    expect(await outbox.deliver(CHAT_A, "k2", "hi", "buy", undefined, { claimed: true })).toBe("stopped");
    expect(tg.sent).toEqual([]);
    // Neither key is claimed: the next start's catch-up can send them.
    expect(await sentKeys(db, CHAT_A, ["k1", "k2"])).toEqual(new Set());
    expect(outbox.pendingFailures()).toEqual([]);
  });
});

describe("listenForEvents", () => {
  it("delivers parsed holdfast_events notifications and drops malformed ones", async () => {
    const seen: unknown[] = [];
    const unlisten = await listenForEvents(db, (n) => seen.push(n));
    try {
      await notify(db, [{ kind: "round", mint: coin.mint, roundId: 3 }, { kind: "coin", mint: coin.mint }]);
      await db.query("SELECT pg_notify('holdfast_events', 'not json')");
      await vi.waitFor(() => expect(seen).toHaveLength(2));
      expect(seen).toEqual([{ kind: "round", mint: coin.mint, roundId: 3 }, { kind: "coin", mint: coin.mint }]);
    } finally {
      await unlisten();
    }
  });

  it("hands onReconnect to the LISTEN connection (notifications in a gap are lost: the notifier catches up)", async () => {
    const onReconnect = () => {};
    let given: unknown;
    const fakeDb = { listen: async (_channel: string, _fn: (payload: string) => void, opts?: unknown) => ((given = opts), async () => {}) };
    await listenForEvents(fakeDb, () => {}, { onReconnect });
    expect(given).toEqual({ onReconnect });
  });
});
