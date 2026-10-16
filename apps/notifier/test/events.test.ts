import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRoundSnapshot, computeRound, solPerTokenToFixed, weightMultiplier, type RoundInputs } from "@holdfast/core";
import {
  addExcluded,
  addSubscription,
  applyLotConsumptions,
  insertLot,
  insertRound,
  insertTrade,
  listChatSubscriptions,
  markGraduated,
  markPayout,
  notify,
  updateRoundStatus,
  upsertVaultState,
  type Db,
  type NewCoin,
} from "@holdfast/db";

import { crossedMilestones, listenForEvents, multiplierPpm, Notifier } from "../src/events.js";
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

async function watch(chatId: number, kind: "wallet" | "coin", target: string, atMs = NOW - DAY): Promise<void> {
  await addSubscription(db, { chatId, kind, target, atMs });
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
