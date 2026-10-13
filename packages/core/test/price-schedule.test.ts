import { describe, expect, it } from "vitest";
import {
  curvePriceFixed,
  fixedToSolPerToken,
  floorFromAth,
  floorToAthProgress,
  marketCapSol,
  poolPriceFixed,
  solPerTokenToFixed,
} from "../src/price.js";
import { candleBucket, nextRoundAt, roundSlot } from "../src/schedule.js";

describe("price math", () => {
  it("initial pump.fun curve price ≈ 2.8e-8 SOL/token and ≈ 28 SOL market cap", () => {
    const p = curvePriceFixed(30_000_000_000n, 1_073_000_000_000_000n);
    const perToken = fixedToSolPerToken(p);
    expect(perToken).toBeCloseTo(2.796e-8, 10);
    expect(marketCapSol(perToken)).toBeCloseTo(27.96, 1);
  });

  it("pool price uses effective quote = balance + virtual (signed)", () => {
    expect(poolPriceFixed(100n, -20n, 10n)).toBe(8n * 10n ** 18n);
    expect(poolPriceFixed(100n, 0n, 0n)).toBe(0n);
  });

  it("floor = ATH × (1 − trigger)", () => {
    expect(floorFromAth(1_000_000n, 2_500)).toBe(750_000n);
    expect(floorFromAth(1_000_000n, 1_500)).toBe(850_000n);
    expect(floorFromAth(1_000_000n, 3_500)).toBe(650_000n);
  });

  it("converts display prices back and forth", () => {
    const fixed = solPerTokenToFixed(1.5e-7);
    expect(fixedToSolPerToken(fixed)).toBeCloseTo(1.5e-7, 15);
  });

  it("floor→ATH progress is clamped", () => {
    expect(floorToAthProgress(5, 4, 8)).toBe(0.25);
    expect(floorToAthProgress(3, 4, 8)).toBe(0);
    expect(floorToAthProgress(9, 4, 8)).toBe(1);
  });
});

describe("round schedule", () => {
  it("aligns rounds to 2-minute wall clock boundaries", () => {
    const t = Date.UTC(2026, 9, 13, 12, 3, 30);
    expect(nextRoundAt(t)).toBe(Date.UTC(2026, 9, 13, 12, 4, 0));
    expect(nextRoundAt(Date.UTC(2026, 9, 13, 12, 4, 0))).toBe(Date.UTC(2026, 9, 13, 12, 6, 0));
    expect(roundSlot(t + 30_000)).toBe(roundSlot(t) + 1);
  });

  it("buckets candles", () => {
    const t = Date.UTC(2026, 9, 13, 12, 7, 45);
    expect(candleBucket(t, "5m")).toBe(Date.UTC(2026, 9, 13, 12, 5, 0));
    expect(candleBucket(t, "1h")).toBe(Date.UTC(2026, 9, 13, 12, 0, 0));
  });
});
