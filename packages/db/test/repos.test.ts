import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyDecrease, applyBuy, buildRoundSnapshot, computeRound, emptyLedger, verifyRoundSnapshot, type RoundInputs } from "@holdfast/core";
import {
  addExcluded,
  addSubscription,
  applyLotConsumptions,
  applyVaultDelta,
  chatsWatchingCoin,
  chatsWatchingWallets,
  countCoins,
  countChatSubscriptions,
  countDefendsSince,
  countHolders,
  countSubscriptionsByKind,
  earningsByMint,
  earningsByWallet,
  expireLaunches,
  filterExcluded,
  findCoinsByVenue,
  getCarry,
  getCoin,
  getCoins,
  getLatestRound,
  getLaunch,
  getLaunchByDepositAddress,
  getRound,
  getRoundRow,
  getTelegramOffset,
  getTokenAccounts,
  getTradesBySig,
  getVaultState,
  getWalletBalance,
  insertCoin,
  insertDefend,
  insertFloorPoint,
  insertLaunch,
  insertLot,
  insertRound,
  insertTrade,
  isExcluded,
  latestTradePrice,
  listCandles,
  listChatSubscriptions,
  listCoins,
  listDefends,
  listExcluded,
  listFloorHistory,
  listPayouts,
  listPendingLaunches,
  listRounds,
  listTrades,
  listWalletSubscriptions,
  loadCarries,
  loadEligibleHolders,
  loadHolderBook,
  loadLedger,
  loadOpenLots,
  loadWalletBook,
  markGraduated,
  markPayout,
  markSent,
  nextDepositIndex,
  openLotsByWallet,
  pruneSent,
  recentPayoutsForWallet,
  recentNotifierEvents,
  removeChatSubscriptions,
  removeSubscription,
  saveCarries,
  saveLedger,
  setLaunchSig,
  setTelegramOffset,
  sumCarries,
  unmarkSent,
  updateCoinMetadata,
  updateLastPrice,
  updateLaunchStatus,
  updateRoundStatus,
  upsertCandles,
  upsertTokenAccount,
  upsertVaultState,
  upsertWalletBalance,
  type Db,
  type TradeRow,
} from "../src/index.js";
import { addr, coinFixture, freshDb, resetDb, seedCoin, sig } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await db.close();
});

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

describe("coins", () => {
  it("inserts, reads and updates coins", async () => {
    const c = coinFixture("alpha", { socials: { x: "@alpha" }, launchSig: null, createdAt: T0 });
    expect(await insertCoin(db, c)).toBe(true);
    expect(await insertCoin(db, { ...c, name: "other" })).toBe(false);
    const row = await getCoin(db, c.mint);
    expect(row).toMatchObject({ mint: c.mint, name: "alpha coin", ticker: "ALPHA", triggerBps: 2500, decimals: 6, graduated: false, createdAt: T0 });
    expect(row?.socials).toEqual({ x: "@alpha" });
    expect(await getCoin(db, addr("nope"))).toBeNull();

    await setLaunchSig(db, c.mint, "sig1");
    await setLaunchSig(db, c.mint, "sig2");
    await updateCoinMetadata(db, c.mint, { description: "hello", imageUrl: "http://img", socials: { website: "https://a.b" } });
    await updateLastPrice(db, c.mint, 2e-8, T0 + 1000, 100);
    await updateLastPrice(db, c.mint, 1e-8, T0 + 500, 99); // older slot: ignored
    const pool = addr("pool:alpha");
    await markGraduated(db, c.mint, pool, T0 + 2000);
    const after = await getCoin(db, c.mint);
    expect(after).toMatchObject({
      launchSig: "sig1",
      description: "hello",
      imageUrl: "http://img",
      lastPrice: 2e-8,
      lastTradeAt: T0 + 1000,
      graduated: true,
      ammPool: pool,
      graduatedAt: T0 + 2000,
    });
    expect(after?.socials).toEqual({ website: "https://a.b" });

    const b = await seedCoin(db, "beta");
    expect((await getCoins(db, [c.mint, b.mint, c.mint])).size).toBe(2);
    expect((await findCoinsByVenue(db, [pool])).map((x) => x.mint)).toEqual([c.mint]);
    expect((await findCoinsByVenue(db, [b.bondingCurve])).map((x) => x.mint)).toEqual([b.mint]);
    expect(await countCoins(db)).toBe(2);
    expect((await listCoins(db)).map((x) => x.mint)).toEqual([c.mint, b.mint]);
  });
});

function trade(mint: string, i: number, over: Partial<TradeRow> = {}): TradeRow {
  return {
    sig: sig(`t${i}`),
    ixIndex: 0,
    mint,
    wallet: addr(`w${i % 3}`),
    side: "buy",
    sol: 1_000_000_000n,
    tokens: 35_000_000_000_000n,
    price: 1_000_000_000 / 1e9 / (35_000_000_000_000 / 1e6),
    ts: T0 + i * 1000,
    slot: 1000 + i,
    source: "curve",
    ...over,
  };
}

describe("trades and candles", () => {
  it("records trades idempotently and pages newest first", async () => {
    const c = await seedCoin(db, "t");
    for (let i = 0; i < 5; i++) expect(await insertTrade(db, trade(c.mint, i))).toBe(true);
    expect(await insertTrade(db, trade(c.mint, 0))).toBe(false);
    const page1 = await listTrades(db, c.mint, { limit: 2 });
    expect(page1.map((t) => t.ts)).toEqual([T0 + 4000, T0 + 3000]);
    const last = page1[1]!;
    const page2 = await listTrades(db, c.mint, { limit: 10, before: { ts: last.ts, sig: last.sig, ixIndex: last.ixIndex } });
    expect(page2.map((t) => t.ts)).toEqual([T0 + 2000, T0 + 1000, T0]);
    expect((await getTradesBySig(db, sig("t2")))[0]).toMatchObject({ sol: 1_000_000_000n, tokens: 35_000_000_000_000n, side: "buy" });
    expect(await latestTradePrice(db, c.mint)).toBeCloseTo(1 / 35_000_000);
  });

  it("builds OHLCV candles per timeframe, tolerant of out-of-order trades", async () => {
    const c = await seedCoin(db, "c");
    const base = Date.UTC(2026, 9, 1, 12, 0, 0);
    const ticks = [
      { ts: base + 5_000, price: 10, volume: 100n, slot: 1 },
      { ts: base + 50_000, price: 8, volume: 50n, slot: 3 },
      { ts: base + 20_000, price: 12, volume: 10n, slot: 2 }, // arrives late, inside the same minute
      { ts: base + 65_000, price: 9, volume: 5n, slot: 4 }, // next 1m bucket
    ];
    for (const t of ticks) await upsertCandles(db, { mint: c.mint, ...t });
    const m1 = await listCandles(db, c.mint, "1m", { limit: 10 });
    expect(m1).toEqual([
      { ts: base, open: 10, high: 12, low: 8, close: 8, volume: 160n, trades: 3 },
      { ts: base + 60_000, open: 9, high: 9, low: 9, close: 9, volume: 5n, trades: 1 },
    ]);
    const m5 = await listCandles(db, c.mint, "5m", { limit: 10 });
    expect(m5).toEqual([{ ts: base, open: 10, high: 12, low: 8, close: 9, volume: 165n, trades: 4 }]);
    expect(await listCandles(db, c.mint, "1m", { limit: 1 })).toHaveLength(1);
    expect((await listCandles(db, c.mint, "1m", { limit: 10, from: base + 60_000 }))[0]?.ts).toBe(base + 60_000);
    expect(await listCandles(db, c.mint, "1h", { limit: 10, to: base - 1 })).toEqual([]);
  });
});

describe("lots and balances", () => {
  it("persists ledgers produced by core lot functions", async () => {
    const c = await seedCoin(db, "l");
    const w = addr("holder");
    expect(await loadLedger(db, c.mint, w)).toEqual(emptyLedger());

    const id1 = await insertLot(db, { wallet: w, mint: c.mint, amount: 100n, acquiredAt: T0, sourceSig: "s1", sourceIx: 0 });
    const id2 = await insertLot(db, { wallet: w, mint: c.mint, amount: 50n, acquiredAt: T0 + 1000, sourceSig: "s2", sourceIx: 0 });
    expect(await insertLot(db, { wallet: w, mint: c.mint, amount: 100n, acquiredAt: T0, sourceSig: "s1", sourceIx: 0 })).toBeNull();
    await upsertWalletBalance(db, { mint: c.mint, wallet: w, balance: 170n, untracked: 20n, slot: 5 });

    const ledger = await loadLedger(db, c.mint, w, { forUpdate: true });
    expect(ledger).toEqual({
      balance: 170n,
      untracked: 20n,
      lots: [
        { id: id1, amount: 100n, acquiredAt: T0 },
        { id: id2, amount: 50n, acquiredAt: T0 + 1000 },
      ],
    });

    // Sell 70: untracked 20 first, then 50 from the oldest lot (FIFO).
    const dec = applyDecrease(ledger, 70n);
    const withBuy = applyBuy(dec.ledger, { id: "~new", amount: 30n, acquiredAt: T0 + 5000 });
    await saveLedger(db, {
      mint: c.mint,
      wallet: w,
      ledger: withBuy,
      consumed: dec.consumed,
      newLots: [{ wallet: w, mint: c.mint, amount: 30n, acquiredAt: T0 + 5000, sourceSig: "s3", sourceIx: 0 }],
      slot: 6,
    });
    const after = await loadLedger(db, c.mint, w);
    expect(after.balance).toBe(130n);
    expect(after.untracked).toBe(0n);
    expect(after.lots.map((l) => [l.amount, l.acquiredAt])).toEqual([
      [50n, T0],
      [50n, T0 + 1000],
      [30n, T0 + 5000],
    ]);
    expect((await getWalletBalance(db, c.mint, w))?.updatedSlot).toBe(6);

    await applyLotConsumptions(db, [{ lotId: id1!, amount: 500n }]);
    expect((await loadOpenLots(db, c.mint, w)).map((l) => l.amount)).toEqual([50n, 30n]);
  });

  it("holder book excludes pools/PDAs and counts holders", async () => {
    const c = await seedCoin(db, "h");
    const a = addr("a");
    const b = addr("b");
    const pool = addr("pool");
    await upsertWalletBalance(db, { mint: c.mint, wallet: a, balance: 10n, untracked: 0n, slot: 1 });
    await upsertWalletBalance(db, { mint: c.mint, wallet: b, balance: 5n, untracked: 5n, slot: 1 });
    await upsertWalletBalance(db, { mint: c.mint, wallet: pool, balance: 1_000n, untracked: 1_000n, slot: 1 });
    await insertLot(db, { wallet: a, mint: c.mint, amount: 10n, acquiredAt: T0, sourceSig: "x", sourceIx: 0 });
    await insertLot(db, { wallet: pool, mint: c.mint, amount: 10n, acquiredAt: T0, sourceSig: "y", sourceIx: 0 });
    await addExcluded(db, [{ address: pool, reason: "pool" }]);

    const book = await loadHolderBook(db, c.mint);
    expect(book.map((e) => e.wallet).sort()).toEqual([a, b].sort());
    expect(book.find((e) => e.wallet === a)?.lots).toHaveLength(1);
    expect(await countHolders(db, c.mint)).toBe(2);
    expect((await loadEligibleHolders(db, c.mint)).map((h) => h.wallet)).toEqual([a]);

    const wb = await loadWalletBook(db, a);
    expect(wb.get(c.mint)?.balance).toBe(10n);
    expect(wb.get(c.mint)?.lots[0]?.amount).toBe(10n);
  });

  it("token account mirror", async () => {
    const c = await seedCoin(db, "ta");
    await upsertTokenAccount(db, { address: "acc1", mint: c.mint, owner: "o1", amount: 5n, slot: 3 });
    await upsertTokenAccount(db, { address: "acc1", mint: c.mint, owner: "o1", amount: 7n, slot: 4 });
    const got = await db.tx((q) => getTokenAccounts(q, ["acc1", "acc2"]));
    expect(got.get("acc1")).toEqual({ address: "acc1", mint: c.mint, owner: "o1", amount: 7n, slot: 4 });
    expect(got.has("acc2")).toBe(false);
  });
});

describe("vault state, floor history, defends", () => {
  it("snapshots respect slot order and deltas accumulate", async () => {
    const c = await seedCoin(db, "v");
    const snap = {
      mint: c.mint,
      floorSol: 6n,
      holderSol: 3n,
      burnSol: 1n,
      holderTokens: 0n,
      ath: 10n ** 20n,
      floor: 75n * 10n ** 18n,
      defendCount: 0n,
      lastDefendTs: null,
      roundId: 0n,
      totalFees: 10n,
      totalDefended: 0n,
      totalPaidSol: 0n,
      totalPaidTokens: 0n,
      totalBurnedSol: 0n,
      slot: 10,
    };
    expect(await upsertVaultState(db, snap)).toBe(true);
    expect(await upsertVaultState(db, { ...snap, floorSol: 1n, slot: 9 })).toBe(false);
    expect((await getVaultState(db, c.mint))?.floorSol).toBe(6n);

    await applyVaultDelta(db, c.mint, { floorSol: -2n, holderTokens: 500n, totalDefended: 2n, defends: 1, lastDefendTs: T0, ath: 1n });
    const v = await getVaultState(db, c.mint);
    expect(v).toMatchObject({ floorSol: 4n, holderTokens: 500n, totalDefended: 2n, defendCount: 1n, lastDefendTs: T0, ath: 10n ** 20n });

    const other = await seedCoin(db, "v2");
    await applyVaultDelta(db, other.mint, { floorSol: 60n, holderSol: 30n, burnSol: 10n, totalFees: 100n });
    expect(await getVaultState(db, other.mint)).toMatchObject({ floorSol: 60n, holderSol: 30n, burnSol: 10n, totalFees: 100n, lastDefendTs: null });
  });

  it("floor history returns the step before the range", async () => {
    const c = await seedCoin(db, "f");
    await insertFloorPoint(db, c.mint, { ts: T0, ath: 100n, floor: 75n });
    await insertFloorPoint(db, c.mint, { ts: T0 + 60_000, ath: 200n, floor: 150n });
    await insertFloorPoint(db, c.mint, { ts: T0 + 60_000, ath: 150n, floor: 100n }); // same ts: keeps the max
    expect(await listFloorHistory(db, c.mint)).toEqual([
      { ts: T0, ath: 100n, floor: 75n },
      { ts: T0 + 60_000, ath: 200n, floor: 150n },
    ]);
    expect((await listFloorHistory(db, c.mint, { from: T0 + 30_000 })).map((p) => p.ts)).toEqual([T0, T0 + 60_000]);
    expect(await listFloorHistory(db, c.mint, { to: T0 - 1 })).toEqual([]);
  });

  it("defends", async () => {
    const c = await seedCoin(db, "d");
    const d = { sig: sig("d1"), mint: c.mint, solSpent: 100n, tokensBought: 5000n, price: 1e-8, ts: T0 };
    expect(await insertDefend(db, d)).toBe(true);
    expect(await insertDefend(db, d)).toBe(false);
    await insertDefend(db, { ...d, sig: sig("d2"), ts: T0 + 1000 });
    expect((await listDefends(db, c.mint, { limit: 10 })).map((x) => x.sig)).toEqual([sig("d2"), sig("d1")]);
    expect(await listDefends(db, c.mint, { limit: 10, from: T0 + 500 })).toHaveLength(1);
    expect(await countDefendsSince(db, T0 + 1)).toBe(1);
  });
});

describe("payout rounds", () => {
  it("stores snapshots, payouts, statuses, carries and earnings", async () => {
    const c = await seedCoin(db, "p");
    const w1 = addr("w1");
    const w2 = addr("w2");
    const w3 = addr("w3");
    const inputs: RoundInputs = {
      mint: c.mint,
      roundId: 1n,
      snapshotAt: T0,
      potSol: 1_000_000_000n,
      potTokens: 0n,
      params: { minSolLamports: 1_000_000n, minTokensRaw: 1n, rentExemptMinLamports: 890_880n, carryExpiryMs: 0, maxRecipients: 10 },
      holders: [
        { wallet: w1, lots: [{ amount: 1_000n, acquiredAt: T0 - 7 * 86_400_000 }], solBalance: 10n ** 9n, hasTokenAccount: true },
        { wallet: w2, lots: [{ amount: 1_000n, acquiredAt: T0 }], solBalance: 10n ** 9n, hasTokenAccount: true },
        { wallet: w3, lots: [{ amount: 1n, acquiredAt: T0 }], solBalance: 10n ** 9n, hasTokenAccount: true },
      ],
      carriedIn: [],
    };
    const result = computeRound(inputs);
    const snapshot = buildRoundSnapshot(inputs, result, T0 + 1000);
    expect(await insertRound(db, snapshot)).toBe(true);
    expect(await insertRound(db, snapshot)).toBe(false);

    const stored = await getRound(db, c.mint, 1);
    expect(stored?.snapshot).toEqual(snapshot);
    expect(verifyRoundSnapshot(stored!.snapshot).ok).toBe(true);
    expect(stored).toMatchObject({ status: "computed", recipientCount: 2, solPot: result.solPot, totalWeight: result.totalWeight });

    expect(await updateRoundStatus(db, c.mint, 1, "opened", { openSig: "open" })).toBe(true);
    expect(await updateRoundStatus(db, c.mint, 1, "closed", { closeSig: "close" })).toBe(true);
    expect(await updateRoundStatus(db, c.mint, 1, "paying")).toBe(false); // closed never goes back
    expect(await getLatestRound(db, c.mint)).toMatchObject({ roundId: 1n, status: "closed", openSig: "open", closeSig: "close" });

    const payouts = await listPayouts(db, c.mint, 1);
    expect(payouts.map((p) => [p.wallet, p.status])).toEqual(result.entries.map((e) => [e.wallet, "pending"]));
    expect(await markPayout(db, { mint: c.mint, roundId: 1n, idx: 0, status: "confirmed", sig: "pay0" })).toBe(true);
    expect(await markPayout(db, { mint: c.mint, roundId: 1n, idx: 99, status: "confirmed" })).toBe(false);

    const first = result.entries[0]!;
    expect((await earningsByWallet(db, first.wallet)).get(c.mint)).toEqual({ sol: first.sol, tokens: 0n });
    expect((await earningsByMint(db, c.mint)).get(first.wallet)?.sol).toBe(first.sol);
    expect(await recentPayoutsForWallet(db, first.wallet, 5)).toEqual([
      { mint: c.mint, roundId: 1n, sol: first.sol, tokens: 0n, ts: T0 + 1000, sig: "pay0" },
    ]);
    expect((await listRounds(db, c.mint, 5)).map((r) => r.roundId)).toEqual([1n]);

    // w3's dust is carried.
    expect(result.carriedOut.map((x) => x.wallet)).toEqual([w3]);
    await saveCarries(db, c.mint, result.carriedOut);
    expect(await loadCarries(db, c.mint)).toEqual(result.carriedOut);
    expect((await sumCarries(db, c.mint)).sol).toBe(result.carriedOut[0]!.sol);
    expect(await getCarry(db, c.mint, w3)).toEqual(result.carriedOut[0]);
    await saveCarries(db, c.mint, []);
    expect(await loadCarries(db, c.mint)).toEqual([]);
  });
});

describe("launches", () => {
  it("lifecycle", async () => {
    const i1 = await nextDepositIndex(db);
    const i2 = await nextDepositIndex(db);
    expect(i2).toBe(i1 + 1n);
    const id = "6f1c5c34-8a32-4bb1-9d0e-6a7a0f8b2a11";
    const row = await insertLaunch(db, {
      id,
      form: { name: "Dog", ticker: "DOG", triggerBps: 2500 },
      depositAddress: addr("dep"),
      depositIndex: i1,
      requiredLamports: 15_000_000n,
      devBuyLamports: 0n,
      expiresAt: T0,
    });
    expect(row).toMatchObject({ id, status: "awaiting_deposit", requiredLamports: 15_000_000n, attempts: 0 });
    expect((await getLaunch(db, id))?.form.ticker).toBe("DOG");
    expect(await getLaunch(db, "not-a-uuid")).toBeNull();
    expect((await getLaunchByDepositAddress(db, addr("dep")))?.id).toBe(id);
    expect((await listPendingLaunches(db)).map((l) => l.id)).toEqual([id]);

    expect(await updateLaunchStatus(db, id, "creating", {}, ["deposit_received"])).toBeNull();
    const received = await updateLaunchStatus(db, id, "deposit_received", { receivedLamports: 20_000_000n, sender: "S" }, ["awaiting_deposit"]);
    expect(received).toMatchObject({ status: "deposit_received", receivedLamports: 20_000_000n, sender: "S" });
    const failed = await updateLaunchStatus(db, id, "failed", { error: "x", incrementAttempts: true });
    expect(failed).toMatchObject({ status: "failed", error: "x", attempts: 1 });

    const id2 = "6f1c5c34-8a32-4bb1-9d0e-6a7a0f8b2a12";
    await insertLaunch(db, { id: id2, form: { name: "C", ticker: "C", triggerBps: 1500 }, depositAddress: addr("dep2"), depositIndex: i2, requiredLamports: 1n, devBuyLamports: 0n, expiresAt: T0 });
    expect((await expireLaunches(db, T0 + 1)).map((l) => l.id)).toEqual([id2]);
  });
});

describe("excluded wallets", () => {
  it("add / filter", async () => {
    await addExcluded(db, [
      { address: "a", reason: "pool" },
      { address: "b", reason: "launcher" },
    ]);
    await addExcluded(db, [{ address: "a", reason: "other" }]);
    expect(await filterExcluded(db, ["a", "c"])).toEqual(new Set(["a"]));
    expect(await isExcluded(db, "b")).toBe(true);
    expect(await listExcluded(db)).toEqual([
      { address: "a", reason: "pool" },
      { address: "b", reason: "launcher" },
    ]);
  });
});

describe("telegram notifier", () => {
  it("subscriptions: add once, limit per chat, list, look up watchers, remove", async () => {
    const [w1, w2, m1] = [addr("w1"), addr("w2"), addr("m1")];
    expect(await addSubscription(db, { chatId: 1, kind: "wallet", target: w1, atMs: T0 })).toBe("added");
    expect(await addSubscription(db, { chatId: 1, kind: "wallet", target: w1 })).toBe("exists");
    expect(await addSubscription(db, { chatId: 1, kind: "coin", target: m1, atMs: T0 + 1 }, { limit: 2 })).toBe("added");
    expect(await addSubscription(db, { chatId: 1, kind: "wallet", target: w2 }, { limit: 2 })).toBe("limit");
    // Telegram supergroup ids need more than 32 bits.
    expect(await addSubscription(db, { chatId: -1001234567890, kind: "wallet", target: w1, atMs: T0 + 2 })).toBe("added");

    expect(await countChatSubscriptions(db, 1)).toBe(2);
    expect(await countSubscriptionsByKind(db)).toEqual({ wallet: 2, coin: 1 });
    expect(await listChatSubscriptions(db, 1)).toEqual([
      { chatId: 1, kind: "wallet", target: w1, createdAt: T0 },
      { chatId: 1, kind: "coin", target: m1, createdAt: T0 + 1 },
    ]);
    expect(await chatsWatchingWallets(db, [w1, w2])).toEqual(
      new Map([[w1, [{ chatId: -1001234567890, createdAt: T0 + 2 }, { chatId: 1, createdAt: T0 }]]]),
    );
    expect(await chatsWatchingCoin(db, m1)).toEqual([{ chatId: 1, createdAt: T0 + 1 }]);
    expect((await listWalletSubscriptions(db)).map((s) => s.chatId)).toEqual([-1001234567890, 1]);

    expect(await removeSubscription(db, 1, "coin", m1)).toBe(true);
    expect(await removeSubscription(db, 1, "coin", m1)).toBe(false);
    expect(await removeChatSubscriptions(db, 1)).toBe(1);
    expect(await countChatSubscriptions(db, 1)).toBe(0);
  });

  it("offset, sent-message claims and pruning", async () => {
    expect(await getTelegramOffset(db)).toBe(0);
    await setTelegramOffset(db, 812_345_678);
    expect(await getTelegramOffset(db)).toBe(812_345_678);

    expect(await markSent(db, 1, "round:m:1:w")).toBe(true);
    expect(await markSent(db, 1, "round:m:1:w")).toBe(false);
    expect(await markSent(db, 2, "round:m:1:w")).toBe(true);
    await unmarkSent(db, 1, "round:m:1:w");
    expect(await markSent(db, 1, "round:m:1:w")).toBe(true);
    expect(await markSent(db, 1, "weight:w:m:1.0:1")).toBe(true);

    expect(await pruneSent(db, Date.now() - 60_000)).toBe(0);
    expect(await pruneSent(db, Date.now() + 60_000, ["weight:"])).toBe(2);
    expect(await markSent(db, 1, "weight:w:m:1.0:1")).toBe(false);
    expect(await markSent(db, 1, "round:m:1:w")).toBe(true);
  });

  it("reads open lots of watched wallets and recent events", async () => {
    const c = await seedCoin(db, "n");
    const [w1, pool] = [addr("w1"), addr("pool")];
    await addExcluded(db, [{ address: pool, reason: "pool" }]);
    const first = await insertLot(db, { wallet: w1, mint: c.mint, amount: 10n, acquiredAt: T0 - 1000, sourceSig: sig("l1"), sourceIx: 0 });
    await insertLot(db, { wallet: w1, mint: c.mint, amount: 5n, acquiredAt: T0, sourceSig: sig("l2"), sourceIx: 0 });
    await insertLot(db, { wallet: pool, mint: c.mint, amount: 7n, acquiredAt: T0, sourceSig: sig("l3"), sourceIx: 0 });
    await applyLotConsumptions(db, [{ lotId: first!, amount: 4n }]);
    const lots = await openLotsByWallet(db, [w1, pool, addr("nobody")]);
    expect([...lots.keys()]).toEqual([w1]);
    expect(lots.get(w1)?.get(c.mint)).toEqual([
      { id: first, amount: 6n, acquiredAt: T0 - 1000 },
      { id: expect.any(String), amount: 5n, acquiredAt: T0 },
    ]);

    const inputs: RoundInputs = {
      mint: c.mint,
      roundId: 1n,
      snapshotAt: T0,
      potSol: 1_000_000_000n,
      potTokens: 0n,
      params: { minSolLamports: 1n, minTokensRaw: 1n, rentExemptMinLamports: 0n, carryExpiryMs: 0, maxRecipients: 10 },
      holders: [{ wallet: w1, lots: [{ amount: 10n, acquiredAt: T0 }], solBalance: 10n ** 9n, hasTokenAccount: true }],
      carriedIn: [],
    };
    await insertRound(db, buildRoundSnapshot(inputs, computeRound(inputs), T0));
    expect(await recentNotifierEvents(db, T0 - 1000)).toEqual([]);
    await updateRoundStatus(db, c.mint, 1, "closed", { closeSig: "close" });
    expect(await getRoundRow(db, c.mint, 1)).toMatchObject({ roundId: 1n, status: "closed", closeSig: "close" });
    expect(await getRoundRow(db, c.mint, 2)).toBeNull();
    await insertTrade(db, { sig: sig("v"), ixIndex: 0, mint: c.mint, wallet: c.treasury, side: "vault", sol: 1n, tokens: 1n, price: 1, ts: T0, slot: 1, source: "vault" });
    await insertTrade(db, { sig: sig("v"), ixIndex: 1, mint: c.mint, wallet: c.treasury, side: "vault", sol: 1n, tokens: 1n, price: 1, ts: T0, slot: 1, source: "vault" });
    await insertTrade(db, { sig: sig("b"), ixIndex: 0, mint: c.mint, wallet: w1, side: "buy", sol: 1n, tokens: 1n, price: 1, ts: T0, slot: 1, source: "curve" });
    await markGraduated(db, c.mint, addr("amm"), T0);
    expect(await recentNotifierEvents(db, T0 - 1000)).toEqual([
      { kind: "round", mint: c.mint, roundId: 1 },
      { kind: "trade", mint: c.mint, sig: sig("v") },
      { kind: "coin", mint: c.mint },
    ]);
    expect(await recentNotifierEvents(db, T0 + 1)).toEqual([]);
  });
});
