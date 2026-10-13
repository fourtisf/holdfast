import { describe, expect, it } from "vitest";
import { MOCK_WALLET } from "./ids";
import { candles, coinDetail, holdersList, listCoins, position, profile, stats, tradesPage } from "./market";

describe("mock market", () => {
  const coins = listCoins("newest");

  it("generates a varied set of coins with consistent floor maths", () => {
    expect(coins.length).toBeGreaterThan(20);
    expect(coins.some((c) => c.vaultBuying)).toBe(true);
    expect(coins.some((c) => c.imageUrl === null)).toBe(true);
    for (const c of coins) {
      expect(c.vault.floorPrice).toBeCloseTo(c.vault.athPrice * (1 - c.triggerBps / 10_000), 12);
      expect(c.vaultBuying).toBe(c.price <= c.vault.floorPrice);
      expect(c.floorToAthProgress).toBeGreaterThanOrEqual(0);
      expect(c.floorToAthProgress).toBeLessThanOrEqual(1);
      expect(c.vault.floorSol).toBeGreaterThanOrEqual(0);
    }
  });

  it("sorts and filters", () => {
    const newest = listCoins("newest");
    expect(newest[0]!.createdAt).toBeGreaterThanOrEqual(newest[1]!.createdAt);
    expect(listCoins("vault_buying").every((c) => c.vaultBuying)).toBe(true);
    const vaults = listCoins("biggest_vault").map((c) => c.vault.floorSol);
    expect([...vaults].sort((a, b) => b - a)).toEqual(vaults);
    expect(listCoins("newest", "kelp").map((c) => c.ticker)).toContain("KELP");
  });

  it("returns candles with a rising floor line and defends", () => {
    const kelp = coins.find((c) => c.ticker === "KELP")!;
    const res = candles(kelp.mint, "5m")!;
    expect(res.candles.length).toBeGreaterThan(50);
    for (let i = 1; i < res.floorLine.length; i++) expect(res.floorLine[i]!.price).toBeGreaterThanOrEqual(res.floorLine[i - 1]!.price);
    expect(coinDetail(kelp.mint)!.vault.defendCount).toBeGreaterThan(0);
  });

  it("pages trades without duplicates", () => {
    const mint = coins[0]!.mint;
    const first = tradesPage(mint, 30)!;
    const second = tradesPage(mint, 30, first.nextCursor)!;
    const sigs = [...first.items, ...second.items].map((t) => t.sig);
    expect(new Set(sigs).size).toBe(sigs.length);
    expect(first.items[0]!.ts).toBeGreaterThanOrEqual(second.items[0]!.ts);
  });

  it("gives the demo wallet positions that match the holders list", () => {
    const p = profile(MOCK_WALLET);
    expect(p.positions.length).toBeGreaterThanOrEqual(4);
    const pos = p.positions[0]!;
    expect(pos.weightMultiplier).toBeGreaterThanOrEqual(0.1);
    expect(pos.weightMultiplier).toBeLessThanOrEqual(1);
    const holder = holdersList(pos.mint)!.find((h) => h.wallet === MOCK_WALLET)!;
    expect(holder.share).toBeCloseTo(position(MOCK_WALLET, pos.mint)!.share, 6);
    const shares = holdersList(pos.mint)!.reduce((s, h) => s + h.share, 0);
    expect(shares).toBeCloseTo(1, 6);
  });

  it("aggregates stats", () => {
    const s = stats();
    expect(s.coins).toBe(coins.length);
    expect(s.schedule.nextRoundAt % (s.schedule.roundIntervalSec * 1000)).toBe(0);
  });
});
