import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { coinKeys, type CoinVaultAccount, type ConfigAccount } from "@holdfast/chain";

import { applySlippage, floorMinTokens, MIN_FLOOR_AFTER_PREPARE, planCrank, prepareCost, quoteBuy, type PlanOptions } from "../src/plan.js";
import { mergeCarries, planBatches } from "../src/payout/worker.js";
import type { CoinChainState, TreasuryAccounts } from "../src/state.js";

const NOW = 1_760_000_000;
const params: ConfigAccount["params"] = {
  defendCooldownSecs: 60,
  maxDefendsPerHour: 6,
  defendPriceToleranceBps: 300,
  twapWindowSecs: 600,
  twapMinSampleIntervalSecs: 40,
  twapMaxGapSecs: 120,
  athConfirmSecs: 0,
  maxBurnSlippageBps: 500,
  minRoundIntervalSecs: 60,
};
const opts: PlanOptions = {
  collectEverySecs: 120,
  defendSlippageBps: 300,
  curveFeeBpsEstimate: 200,
  ammFeeBpsEstimate: 100,
  burnThresholdLamports: 100_000_000n,
  burnEverySecs: 3_600,
  holdMintSet: true,
};

const VTOK = 1_073_000_000_000_000n;
const VSOL = 30_000_000_000n;
const SPOT = (VSOL * 10n ** 18n) / VTOK;

const READY: TreasuryAccounts = { tokenAccount: true, wsolAccount: true, volumeAccumulator: true };
const BARE: TreasuryAccounts = { tokenAccount: false, wsolAccount: false, volumeAccumulator: false };

function state(v: Partial<CoinVaultAccount> = {}, curve: { vsol?: bigint; complete?: boolean } = {}, pool = false, treasury = READY): CoinChainState {
  const mint = Keypair.generate().publicKey;
  const vsol = curve.vsol ?? VSOL;
  const vault: CoinVaultAccount = {
    mint,
    creator: PublicKey.default,
    triggerBps: 2500,
    tokenProgram: PublicKey.default,
    venue: "curve",
    bondingCurve: PublicKey.default,
    ammPool: null,
    athPrice: SPOT,
    floorPrice: (SPOT * 75n) / 100n,
    floorSol: 6_000_000_000n,
    holderSol: 0n,
    creatorSol: 0n,
    burnSol: 0n,
    holderTokens: 0n,
    lastDefendTs: 0,
    defendCount: 0n,
    hourWindowStart: 0,
    hourWindowDefends: 0,
    lastObservationTs: NOW - 40,
    observationCount: 20,
    roundId: 0n,
    roundOpen: false,
    lastRoundTs: 0,
    totalFees: 0n,
    totalDefendedSol: 0n,
    totalPaidSol: 0n,
    totalPaidTokens: 0n,
    totalBurnSol: 0n,
    totalCreatorClaimed: 0n,
    totalTreasuryRent: 0n,
    createdAt: NOW - 10_000,
    ...v,
  };
  return {
    coin: coinKeys(mint),
    vault,
    curve: {
      virtualTokenReserves: VTOK,
      virtualQuoteReserves: vsol,
      realTokenReserves: 0n,
      realQuoteReserves: 0n,
      tokenTotalSupply: 0n,
      complete: curve.complete ?? false,
      creator: PublicKey.default,
      solQuoted: true,
    },
    pool: pool
      ? { index: 0, creator: PublicKey.default, baseMint: mint, quoteMint: PublicKey.default, poolBaseTokenAccount: PublicKey.default, poolQuoteTokenAccount: PublicKey.default, coinCreator: PublicKey.default, virtualQuoteReserves: 0n, address: PublicKey.default, baseAmount: 1n, quoteAmount: 1n }
      : null,
    spot: (vsol * 10n ** 18n) / VTOK,
    priceAccounts: { priceAccount: PublicKey.default },
    treasury,
  };
}

const mem = (over: Partial<{ lastCollectAt: number; lastBurnAt: number }> = {}) => ({ lastCollectAt: NOW, lastBurnAt: NOW, ...over });
const kinds = (s: CoinChainState, m = mem(), o = opts) => planCrank(s, params, m, NOW, o).map((a) => a.kind);

describe("planCrank", () => {
  it("samples the TWAP on the min interval and collects fees periodically", () => {
    expect(kinds(state())).toEqual(["update_ath"]);
    expect(kinds(state({ lastObservationTs: NOW - 10 }))).toEqual([]);
    expect(kinds(state({ lastObservationTs: NOW - 10 }), mem({ lastCollectAt: NOW - 120 }))).toEqual(["collect"]);
    expect(kinds(state({ observationCount: 0, lastObservationTs: 0 }))).toEqual(["update_ath"]);
  });

  it("defends only below the floor, respecting cooldown, hourly cap and minimum budget", () => {
    const below = { vsol: (VSOL * 70n) / 100n };
    expect(kinds(state({ lastObservationTs: NOW }, below))).toEqual(["defend"]);
    expect(kinds(state({ lastObservationTs: NOW }, { vsol: (VSOL * 80n) / 100n }))).toEqual([]);
    expect(kinds(state({ lastObservationTs: NOW, floorPrice: 0n }, below))).toEqual([]);
    expect(kinds(state({ lastObservationTs: NOW, defendCount: 1n, lastDefendTs: NOW - 30 }, below))).toEqual([]);
    expect(kinds(state({ lastObservationTs: NOW, defendCount: 1n, lastDefendTs: NOW - 60 }, below))).toEqual(["defend"]);
    expect(kinds(state({ lastObservationTs: NOW, hourWindowStart: NOW - 100, hourWindowDefends: 6, defendCount: 6n, lastDefendTs: NOW - 90 }, below))).toEqual([]);
    expect(kinds(state({ lastObservationTs: NOW, hourWindowStart: NOW - 3_600, hourWindowDefends: 6, defendCount: 6n, lastDefendTs: NOW - 90 }, below))).toEqual(["defend"]);
    expect(kinds(state({ lastObservationTs: NOW, floorSol: 5_000_000n }, below))).toEqual([]);
  });

  it("sets min_tokens_out from the curve quote minus slippage", () => {
    const s = state({ lastObservationTs: NOW }, { vsol: (VSOL * 70n) / 100n });
    const [defend] = planCrank(s, params, mem(), NOW, opts);
    expect(defend?.kind).toBe("defend");
    if (defend?.kind !== "defend") return;
    expect(defend.budget).toBe(600_000_000n);
    const expected = quoteBuy(600_000_000n, s.curve.virtualQuoteReserves, VTOK, 200);
    expect(defend.minTokensOut).toBe(applySlippage(expected, 300));
    expect(expected).toBeGreaterThanOrEqual(floorMinTokens(600_000_000n, s.vault.floorPrice, 300));
  });

  it("graduates a completed curve once the pool exists, and does nothing else meanwhile", () => {
    expect(kinds(state({}, { complete: true }), mem({ lastCollectAt: 0 }))).toEqual([]);
    expect(kinds(state({}, { complete: true }, true), mem({ lastCollectAt: 0 }))).toEqual(["graduate"]);
  });

  it("prepares the treasury's accounts once the floor bucket can pay for them, before any buyback", () => {
    const below = { vsol: (VSOL * 70n) / 100n };
    const cost = prepareCost(BARE);
    expect(cost).toBe(2_074_080n + 2_039_280n + 1_844_400n);
    // not enough in the floor bucket yet: nothing to buy with either
    expect(kinds(state({ lastObservationTs: NOW, floorSol: cost + MIN_FLOOR_AFTER_PREPARE }, below, false, BARE))).toEqual([]);
    // enough: prepare first, then defend in the same pass
    expect(kinds(state({ lastObservationTs: NOW, floorSol: 6_000_000_000n }, below, false, BARE))).toEqual(["prepare", "defend"]);
    // proactively, even above the floor
    expect(kinds(state({ lastObservationTs: NOW, floorSol: 6_000_000_000n }, {}, false, BARE))).toEqual(["prepare"]);
    // after graduation only PumpSwap's accumulator is missing
    const amm: TreasuryAccounts = { ...READY, volumeAccumulator: false };
    expect(prepareCost(amm)).toBe(1_844_400n);
    expect(kinds(state({ lastObservationTs: NOW }, {}, false, amm))).toEqual(["prepare"]);
    // a missing account blocks the burn until it can be prepared
    expect(kinds(state({ lastObservationTs: NOW, floorSol: 0n, burnSol: 200_000_000n }, {}, false, BARE), mem({ lastBurnAt: 0 }))).toEqual([]);
  });

  it("burns the burn bucket above the threshold, at most once per interval", () => {
    const s = state({ lastObservationTs: NOW, burnSol: 200_000_000n });
    expect(kinds(s, mem({ lastBurnAt: 0 }))).toEqual(["burn"]);
    expect(kinds(s, mem({ lastBurnAt: NOW - 60 }))).toEqual([]);
    expect(kinds(s, mem({ lastBurnAt: 0 }), { ...opts, holdMintSet: false })).toEqual([]);
    expect(kinds(state({ lastObservationTs: NOW, burnSol: 50_000_000n }), mem({ lastBurnAt: 0 }))).toEqual([]);
  });
});

describe("payout batching", () => {
  const ix = (n: number) => new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.alloc(n * 100) });

  it("packs greedily under the size limit and the per-batch cap", () => {
    const entries = Array.from({ length: 25 }, (_, i) => i);
    const fits = (ixs: TransactionInstruction[]) => ixs[0]!.data.length <= 700;
    const batches = planBatches(entries, (b) => ix(b.length), fits, 12);
    expect(batches.map((b) => b.length)).toEqual([7, 7, 7, 4]);
    expect(planBatches(entries, (b) => ix(b.length), () => true, 12).map((b) => b.length)).toEqual([12, 12, 1]);
  });

  it("merges failed payouts into the carry book", () => {
    const merged = mergeCarries([{ wallet: "b", sol: 5n, tokens: 0n, since: 1 }], [{ index: 0, wallet: "b", sol: 10n, tokens: 3n }, { index: 1, wallet: "a", sol: 7n, tokens: 0n }], 99);
    expect(merged).toEqual([
      { wallet: "a", sol: 7n, tokens: 0n, since: 99 },
      { wallet: "b", sol: 15n, tokens: 3n, since: 1 },
    ]);
  });
});
