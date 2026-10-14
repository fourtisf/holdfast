import { describe, expect, it } from "vitest";

import { assessRound, batchFee, DEFAULT_PAYOUT_COST_MODEL as M, effectiveMinSol, effectiveMinTokens, feePerRecipient, minWorthwhileLamports, roundFee } from "../src/economics.js";

describe("payout economics", () => {
  it("prices transactions as signature + priority on their compute limit", () => {
    expect(batchFee(M, 10)).toBe(5_000n + 460n); // 460k CU × 1000 µlamports
    expect(roundFee(M, 0)).toBe(0n);
    // open + close + 2 full batches + one of 3
    expect(roundFee(M, 23)).toBe(5_100n + 5_060n + 2n * 5_460n + batchFee(M, 3));
    expect(feePerRecipient(M)).toBe(546n);
  });

  it("raises the minimum payout so a recipient's fee share stays within maxFeeBps", () => {
    expect(minWorthwhileLamports(M)).toBe(27_300n); // 546 / 2%
    expect(effectiveMinSol(20_000n, M)).toBe(27_300n);
    expect(effectiveMinSol(100_000n, M)).toBe(100_000n);
    // a token worth 28 lamports per whole token (6 decimals) → 28e-6 lamports per base unit
    const price = (28n * 10n ** 18n) / 1_000_000n;
    expect(effectiveMinTokens(1_000n, M, price)).toBe((27_300n * 10n ** 18n + price - 1n) / price);
    expect(effectiveMinTokens(1_000n, M, null)).toBe(1_000n);
  });

  it("skips rounds whose fees exceed maxFeeBps of what they pay", () => {
    const tiny = assessRound(M, 3, 500_000n, 0n, null); // 0.0005 SOL to 3 wallets
    expect(tiny.feeLamports).toBe(roundFee(M, 3));
    expect(tiny.worthIt).toBe(false);
    expect(assessRound(M, 3, 1_000_000_000n, 0n, null).worthIt).toBe(true);
    // token pots count at their current value
    const price = 10n ** 18n; // 1 lamport per base unit
    expect(assessRound(M, 3, 0n, 1_000_000n, price).worthIt).toBe(true);
    expect(assessRound(M, 3, 0n, 1_000_000n, null).worthIt).toBe(false);
    expect(assessRound(M, 0, 10n ** 12n, 0n, null).worthIt).toBe(false);
  });
});
