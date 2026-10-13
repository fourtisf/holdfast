import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lotsTotal, verifyRoundSnapshot } from "@holdfast/core";
import {
  getCoinMetrics,
  getGlobalStats,
  getRound,
  insertDefend,
  insertTrade,
  listCoinMetrics,
  loadHolderBook,
  seedDemo,
  updateLastPrice,
  upsertVaultState,
  upsertWalletBalance,
  type Db,
} from "../src/index.js";
import { addr, freshDb, resetDb, seedCoin, sig } from "./helpers.js";

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

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const H = 3_600_000;

function vault(mint: string, over: Record<string, bigint | number | null> = {}) {
  return {
    mint,
    floorSol: 0n,
    holderSol: 0n,
    burnSol: 0n,
    holderTokens: 0n,
    ath: 0n,
    floor: 0n,
    defendCount: 0n,
    lastDefendTs: null,
    roundId: 0n,
    totalFees: 0n,
    totalDefended: 0n,
    totalPaidSol: 0n,
    totalPaidTokens: 0n,
    totalBurnedSol: 0n,
    slot: 1,
    ...over,
  } as Parameters<typeof upsertVaultState>[1];
}

describe("coin metrics", () => {
  it("aggregates price, volume, holders and sorts", async () => {
    const a = await seedCoin(db, "aa", { createdAt: NOW - 48 * H });
    const b = await seedCoin(db, "bb", { createdAt: NOW - 2 * H, name: "Bravo Dog" });
    const c = await seedCoin(db, "cc", { createdAt: NOW - 1 * H });

    // a: old trade at price 1e-8, recent at 2e-8 → +100% / 24h
    await insertTrade(db, { sig: sig("a1"), ixIndex: 0, mint: a.mint, wallet: addr("x"), side: "buy", sol: 5n * 10n ** 9n, tokens: 1n, price: 1e-8, ts: NOW - 30 * H, slot: 1, source: "curve" });
    await insertTrade(db, { sig: sig("a2"), ixIndex: 0, mint: a.mint, wallet: addr("x"), side: "buy", sol: 2n * 10n ** 9n, tokens: 1n, price: 2e-8, ts: NOW - 2 * H, slot: 2, source: "curve" });
    await updateLastPrice(db, a.mint, 2.1e-8, NOW - 2 * H, 2);
    // b: busy last hour
    for (let i = 0; i < 5; i++) {
      await insertTrade(db, { sig: sig(`b${i}`), ixIndex: 0, mint: b.mint, wallet: addr("y"), side: "buy", sol: 10n ** 9n, tokens: 1n, price: 3e-8, ts: NOW - 10 * 60_000, slot: 10 + i, source: "curve" });
    }
    await upsertWalletBalance(db, { mint: b.mint, wallet: addr("y"), balance: 5n, untracked: 0n, slot: 1 });
    await upsertWalletBalance(db, { mint: b.mint, wallet: addr("z"), balance: 0n, untracked: 0n, slot: 1 });
    // c: below its floor with a recent defend, biggest vault
    await insertTrade(db, { sig: sig("c1"), ixIndex: 0, mint: c.mint, wallet: addr("q"), side: "sell", sol: 10n ** 8n, tokens: 1n, price: 1e-8, ts: NOW - 5 * 60_000, slot: 20, source: "curve" });
    await updateLastPrice(db, c.mint, 1e-8, NOW - 5 * 60_000, 20);
    // floor 2e-8 SOL/token = 20 lamports per 1e6 base → fixed 2e-8 * 1e9 / 1e6 * 1e18 = 2e13
    await upsertVaultState(db, vault(c.mint, { floor: 20_000_000_000_000n, ath: 30_000_000_000_000n, floorSol: 9n * 10n ** 9n }));
    await insertDefend(db, { sig: sig("cd"), mint: c.mint, solSpent: 10n ** 8n, tokensBought: 1n, price: 1e-8, ts: NOW - 4 * 60_000 });
    await upsertVaultState(db, vault(a.mint, { floorSol: 10n ** 9n, totalPaidSol: 7n * 10n ** 9n }));

    const ma = await getCoinMetrics(db, a.mint, NOW);
    expect(ma).toMatchObject({ price: 2.1e-8, lastTradePrice: 2e-8, price24hAgo: 1e-8, volume24h: 2n * 10n ** 9n, trades1h: 0, paidOutSol: 7n * 10n ** 9n });
    const mb = await getCoinMetrics(db, b.mint, NOW);
    expect(mb).toMatchObject({ price: 3e-8, price24hAgo: 3e-8, volume1h: 5n * 10n ** 9n, trades1h: 5, holders: 1 });
    const mc = await getCoinMetrics(db, c.mint, NOW);
    expect(mc).toMatchObject({ defendCount: 1, defendedSol: 10n ** 8n, lastDefendAt: NOW - 4 * 60_000 });
    expect(await getCoinMetrics(db, addr("missing"), NOW)).toBeNull();

    const order = async (sort: Parameters<typeof listCoinMetrics>[1]["sort"]) =>
      (await listCoinMetrics(db, { sort, limit: 10, now: NOW })).map((m) => m.coin.ticker);
    expect(await order("newest")).toEqual(["CC", "BB", "AA"]);
    expect(await order("trending")).toEqual(["BB", "CC", "AA"]);
    expect(await order("vault_buying")).toEqual(["CC"]); // a filter: only coins at/below their floor
    expect(await order("top_payouts")).toEqual(["AA", "CC", "BB"]);
    expect(await order("biggest_vault")).toEqual(["CC", "AA", "BB"]);

    const search = await listCoinMetrics(db, { sort: "newest", search: "bravo", limit: 10, now: NOW });
    expect(search.map((m) => m.coin.mint)).toEqual([b.mint]);
    expect((await listCoinMetrics(db, { sort: "newest", search: "$cc", limit: 10, now: NOW })).map((m) => m.coin.mint)).toEqual([c.mint]);
    expect((await listCoinMetrics(db, { sort: "newest", search: a.mint, limit: 10, now: NOW })).map((m) => m.coin.mint)).toEqual([a.mint]);
    expect(await listCoinMetrics(db, { sort: "newest", search: "%", limit: 10, now: NOW })).toEqual([]);

    const page1 = await listCoinMetrics(db, { sort: "newest", limit: 2, now: NOW });
    const last = page1[1]!.coin;
    const page2 = await listCoinMetrics(db, { sort: "newest", limit: 2, now: NOW, after: { createdAt: last.createdAt, mint: last.mint } });
    expect(page2.map((m) => m.coin.ticker)).toEqual(["AA"]);
    expect((await listCoinMetrics(db, { sort: "trending", limit: 2, offset: 2, now: NOW })).map((m) => m.coin.ticker)).toEqual(["AA"]);

    const stats = await getGlobalStats(db, NOW);
    expect(stats).toEqual({
      coins: 3,
      totalVaultSol: 10n * 10n ** 9n,
      totalPaidSol: 7n * 10n ** 9n,
      defends24h: 1,
      volume24h: 2n * 10n ** 9n + 5n * 10n ** 9n + 10n ** 8n,
    });
  });
});

describe("demo seed", () => {
  it("produces a consistent dataset", async () => {
    const { mints } = await seedDemo(db, { now: NOW });
    expect(mints).toHaveLength(6);
    for (const mint of mints) {
      for (const h of await loadHolderBook(db, mint)) {
        expect(lotsTotal(h) + h.untracked).toBe(h.balance);
      }
      const round = await getRound(db, mint, 1);
      if (round) expect(verifyRoundSnapshot(round.snapshot).ok).toBe(true);
    }
    const list = await listCoinMetrics(db, { sort: "newest", limit: 10, now: NOW });
    expect(list).toHaveLength(6);
    expect(list.some((m) => m.coin.graduated)).toBe(true);
    expect(list.every((m) => m.price > 0)).toBe(true);
  });
});
