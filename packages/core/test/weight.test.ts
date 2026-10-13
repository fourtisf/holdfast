import { describe, expect, it } from "vitest";
import { lotWeightPpm, weightMultiplier, weightPpm, weightedAmount } from "../src/weight.js";

const HOUR = 3600n;

describe("weightPpm", () => {
  it("is 0.1× at purchase and 1.0× after 168h", () => {
    expect(weightPpm(0n)).toBe(100_000n);
    expect(weightPpm(168n * HOUR)).toBe(1_000_000n);
  });

  it("rises linearly", () => {
    expect(weightPpm(84n * HOUR)).toBe(550_000n);
    expect(weightPpm(24n * HOUR)).toBe(100_000n + (900_000n * 24n) / 168n);
  });

  it("caps at 1.0× and treats negative ages as zero", () => {
    expect(weightPpm(10_000n * HOUR)).toBe(1_000_000n);
    expect(weightPpm(-5n)).toBe(100_000n);
  });

  it("matches the spec formula 0.1 + 0.9 × min(h,168)/168 within rounding", () => {
    for (const hours of [0, 1, 7.5, 36, 100, 167.99, 168, 500]) {
      const expected = 0.1 + (0.9 * Math.min(hours, 168)) / 168;
      const got = Number(weightPpm(BigInt(Math.floor(hours * 3600)))) / 1e6;
      expect(got).toBeCloseTo(expected, 5);
    }
  });
});

describe("lot helpers", () => {
  const t0 = Date.UTC(2026, 0, 1);
  it("computes per-lot weight from timestamps", () => {
    expect(lotWeightPpm(t0, t0)).toBe(100_000n);
    expect(lotWeightPpm(t0, t0 + 7 * 24 * 3600 * 1000)).toBe(1_000_000n);
    expect(weightMultiplier(t0, t0 + 84 * 3600 * 1000)).toBeCloseTo(0.55, 6);
  });

  it("sums Σ amount × weight", () => {
    const lots = [
      { amount: 1_000n, acquiredAt: t0 },
      { amount: 500n, acquiredAt: t0 - 7 * 24 * 3600 * 1000 },
    ];
    expect(weightedAmount(lots, t0)).toBe(1_000n * 100_000n + 500n * 1_000_000n);
  });
});
