import { describe, expect, it } from "vitest";
import {
  buildRoundSnapshot,
  computeRound,
  roundInputsFromJson,
  roundInputsToJson,
  verifyRoundSnapshot,
  type HolderInput,
  type RoundInputs,
} from "../src/payout.js";
import { toHex } from "../src/merkle.js";

const MINT = "So11111111111111111111111111111111111111112";
const A = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const B = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const C = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const D = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const NOW = Date.UTC(2026, 9, 1);
const WEEK = 7 * 24 * 3600 * 1000;
const SOL = 1_000_000_000n;

function holder(wallet: string, lots: [bigint, number][], extra: Partial<HolderInput> = {}): HolderInput {
  return {
    wallet,
    lots: lots.map(([amount, acquiredAt]) => ({ amount, acquiredAt })),
    solBalance: SOL,
    hasTokenAccount: true,
    ...extra,
  };
}

function inputs(over: Partial<RoundInputs> = {}): RoundInputs {
  return {
    mint: MINT,
    roundId: 1n,
    snapshotAt: NOW,
    potSol: 1n * SOL,
    potTokens: 1_000_000n,
    params: { minSolLamports: 10_000n, minTokensRaw: 1n, rentExemptMinLamports: 890_880n, carryExpiryMs: 0, maxRecipients: 4096 },
    holders: [],
    carriedIn: [],
    ...over,
  };
}

describe("computeRound", () => {
  it("splits by tokens × weight: a 7-day holder earns 10× a fresh buyer of the same size", () => {
    const r = computeRound(
      inputs({
        holders: [holder(A, [[1_000n, NOW - WEEK]]), holder(B, [[1_000n, NOW]])],
      }),
    );
    const a = r.entries.find((e) => e.wallet === A)!;
    const b = r.entries.find((e) => e.wallet === B)!;
    expect(a.sol).toBe((SOL * 10n) / 11n);
    expect(b.sol).toBe(SOL / 11n);
    expect(a.tokens).toBe((1_000_000n * 10n) / 11n);
    expect(r.solPot).toBe(a.sol + b.sol);
    expect(r.solPot).toBeLessThanOrEqual(SOL);
    expect(SOL - r.solPot).toBeLessThan(2n); // rounding remainder stays in the bucket
  });

  it("share_i = tokens_i × weight_i / Σ(tokens × weight) across multiple lots", () => {
    const r = computeRound(
      inputs({
        potSol: 1_000_000_000n,
        holders: [holder(A, [[600n, NOW - WEEK], [400n, NOW]]), holder(B, [[2_000n, NOW - WEEK / 2]])],
      }),
    );
    const wA = 600n * 1_000_000n + 400n * 100_000n;
    const wB = 2_000n * 550_000n;
    expect(r.totalWeight).toBe(wA + wB);
    expect(r.entries.find((e) => e.wallet === A)!.sol).toBe((1_000_000_000n * wA) / (wA + wB));
  });

  it("carries dust below the minimum instead of losing it, and pays it once it accumulates", () => {
    const params = { minSolLamports: 100_000n, minTokensRaw: 1_000n, rentExemptMinLamports: 890_880n, carryExpiryMs: 0, maxRecipients: 10 };
    const holders = [holder(A, [[999_000n, NOW - WEEK]]), holder(B, [[1_000n, NOW - WEEK]])];
    const r1 = computeRound(inputs({ potSol: 10_000_000n, potTokens: 0n, params, holders }));
    // B owed 10_000 lamports < 100_000 minimum → carried
    expect(r1.entries.map((e) => e.wallet)).toEqual([A]);
    expect(r1.carriedOut).toEqual([{ wallet: B, sol: 10_000n, tokens: 0n, since: NOW }]);

    // Next rounds: on-chain pot = new fees + everything unpaid (the carry never left holder_sol).
    let carried = r1.carriedOut;
    let bucket = 10_000_000n - r1.solPot;
    let paidB = 0n;
    for (let round = 2n; round < 20n && paidB === 0n; round++) {
      bucket += 10_000_000n;
      const r = computeRound(inputs({ roundId: round, potSol: bucket, potTokens: 0n, params, holders, carriedIn: carried, snapshotAt: NOW + Number(round) * 120_000 }));
      bucket -= r.solPot;
      carried = r.carriedOut;
      paidB = r.entries.find((e) => e.wallet === B)?.sol ?? 0n;
      if (paidB > 0n) expect(r.entries.find((e) => e.wallet === B)!.carriedSol).toBeGreaterThan(0n);
    }
    expect(paidB).toBeGreaterThanOrEqual(100_000n);
  });

  it("waits until an empty wallet's share covers the rent-exempt minimum", () => {
    const params = { minSolLamports: 1n, minTokensRaw: 1n, rentExemptMinLamports: 890_880n, carryExpiryMs: 0, maxRecipients: 10 };
    const r = computeRound(
      inputs({
        potSol: 1_000_000n,
        params,
        holders: [holder(A, [[1n, NOW]], { solBalance: 0n }), holder(B, [[1n, NOW]], { solBalance: 5_000_000n })],
      }),
    );
    // A owed 500_000 < rent minimum with an empty wallet → SOL carried, tokens still paid.
    const a = r.entries.find((e) => e.wallet === A)!;
    expect(a.sol).toBe(0n);
    expect(a.tokens).toBeGreaterThan(0n);
    expect(r.carriedOut).toEqual([{ wallet: A, sol: 500_000n, tokens: 0n, since: NOW }]);
    expect(r.entries.find((e) => e.wallet === B)!.sol).toBe(500_000n);
  });

  it("does not pay tokens to a wallet without a token account (carried)", () => {
    const r = computeRound(inputs({ holders: [holder(A, [[1n, NOW]], { hasTokenAccount: false })] }));
    expect(r.entries[0]!.tokens).toBe(0n);
    expect(r.carriedOut[0]!.tokens).toBe(1_000_000n);
  });

  it("excludes outstanding carries from the distributable pot (no double counting)", () => {
    const r = computeRound(
      inputs({
        potSol: 1_000_000_000n,
        holders: [holder(A, [[1n, NOW]])],
        carriedIn: [{ wallet: B, sol: 400_000_000n, tokens: 0n, since: NOW - 1000 }],
      }),
    );
    expect(r.distributableSol).toBe(600_000_000n);
    expect(r.entries.find((e) => e.wallet === A)!.sol).toBe(600_000_000n);
    expect(r.entries.find((e) => e.wallet === B)!.sol).toBe(400_000_000n);
    expect(r.solPot).toBe(1_000_000_000n);
  });

  it("refuses carries larger than the pot", () => {
    expect(() => computeRound(inputs({ potSol: 1n, carriedIn: [{ wallet: B, sol: 2n, tokens: 0n, since: NOW }] }))).toThrow();
  });

  it("releases expired carries of wallets that stopped holding", () => {
    const r = computeRound(
      inputs({
        potSol: 1_000n,
        params: { minSolLamports: 1_000_000n, minTokensRaw: 1n, rentExemptMinLamports: 0n, carryExpiryMs: WEEK, maxRecipients: 10 },
        holders: [holder(A, [[1n, NOW]])],
        carriedIn: [{ wallet: B, sol: 500n, tokens: 0n, since: NOW - 2 * WEEK }],
      }),
    );
    expect(r.released.map((c) => c.wallet)).toEqual([B]);
    expect(r.distributableSol).toBe(1_000n);
  });

  it("holders with no lots (only transferred tokens) earn nothing", () => {
    const r = computeRound(inputs({ holders: [holder(A, []), holder(B, [[5n, NOW]])] }));
    expect(r.entries.map((e) => e.wallet)).toEqual([B]);
  });

  it("no eligible weight → nothing distributed, pot untouched", () => {
    const r = computeRound(inputs({ holders: [] }));
    expect(r.entries).toEqual([]);
    expect(r.solPot).toBe(0n);
    expect(toHex(r.merkleRoot)).toBe("0".repeat(64));
  });

  it("caps recipients at the on-chain capacity, carrying the smallest", () => {
    const r = computeRound(
      inputs({
        params: { minSolLamports: 1n, minTokensRaw: 1n, rentExemptMinLamports: 0n, carryExpiryMs: 0, maxRecipients: 2 },
        holders: [holder(A, [[10n, NOW]]), holder(B, [[30n, NOW]]), holder(C, [[20n, NOW]]), holder(D, [[40n, NOW]])],
      }),
    );
    expect(r.entries.map((e) => e.wallet).sort()).toEqual([B, D].sort());
    expect(r.carriedOut.map((c) => c.wallet).sort()).toEqual([A, C].sort());
    expect(r.entries.map((e) => e.index)).toEqual([0, 1]);
  });

  it("is deterministic regardless of input order", () => {
    const hs = [holder(A, [[10n, NOW - 5000]]), holder(B, [[30n, NOW - 1]]), holder(C, [[20n, NOW - WEEK]])];
    const r1 = computeRound(inputs({ holders: hs }));
    const r2 = computeRound(inputs({ holders: [...hs].reverse() }));
    expect(toHex(r1.merkleRoot)).toBe(toHex(r2.merkleRoot));
  });

  it("never pays more than the pot (property test)", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const wallets = [A, B, C, D];
    for (let i = 0; i < 300; i++) {
      const holders = wallets.map((w) =>
        holder(w, Array.from({ length: Math.floor(rand() * 4) }, () => [BigInt(1 + Math.floor(rand() * 1e12)), NOW - Math.floor(rand() * 2 * WEEK)] as [bigint, number]), {
          solBalance: rand() < 0.3 ? 0n : SOL,
          hasTokenAccount: rand() < 0.8,
        }),
      );
      const potSol = BigInt(Math.floor(rand() * 1e10));
      const carrySol = potSol / 10n;
      const r = computeRound(
        inputs({ potSol, potTokens: BigInt(Math.floor(rand() * 1e12)), holders, carriedIn: carrySol > 0n ? [{ wallet: A, sol: carrySol, tokens: 0n, since: NOW }] : [] }),
      );
      expect(r.solPot).toBeLessThanOrEqual(potSol);
      const owedAfter = r.carriedOut.reduce((s, c) => s + c.sol, 0n);
      expect(r.solPot + owedAfter).toBeLessThanOrEqual(potSol);
    }
  });
});

describe("snapshot verification", () => {
  const roundInputs = inputs({
    holders: [holder(A, [[1_000n, NOW - WEEK]]), holder(B, [[1_000n, NOW]], { solBalance: 0n })],
    carriedIn: [{ wallet: C, sol: 5n, tokens: 0n, since: NOW - 10 }],
  });

  it("round-trips inputs through JSON", () => {
    expect(roundInputsFromJson(roundInputsToJson(roundInputs))).toEqual({
      ...roundInputs,
      holders: [...roundInputs.holders].sort((a, b) => (a.wallet < b.wallet ? -1 : 1)),
    });
  });

  it("a published snapshot re-verifies, and tampering is detected", () => {
    const result = computeRound(roundInputs);
    const snapshot = JSON.parse(JSON.stringify(buildRoundSnapshot(roundInputs, result, NOW)));
    expect(verifyRoundSnapshot(snapshot, toHex(result.merkleRoot))).toEqual({ ok: true, problems: [] });

    const tampered = JSON.parse(JSON.stringify(snapshot));
    tampered.entries[0].solLamports = "1";
    expect(verifyRoundSnapshot(tampered).ok).toBe(false);

    const wrongInputs = JSON.parse(JSON.stringify(snapshot));
    // Pretend B's fresh lot was a week old: weights change, so the published entries no longer match.
    wrongInputs.inputs.holders.find((h: { wallet: string }) => h.wallet === B).lots[0].acquiredAt -= WEEK;
    expect(verifyRoundSnapshot(wrongInputs).ok).toBe(false);

    expect(verifyRoundSnapshot(snapshot, "00".repeat(32)).ok).toBe(false);
  });
});
