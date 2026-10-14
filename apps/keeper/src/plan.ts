import { DEFEND_STEP_BPS, PRICE_SCALE } from "@holdfast/core";
import { DEFAULT_RENT, PUMP_USER_VOLUME_ACCUMULATOR_SIZE, SPL_TOKEN_ACCOUNT_SIZE, TOKEN_2022_ATA_SIZE, type ConfigAccount } from "@holdfast/chain";

import { treasuryReady, type CoinChainState, type TreasuryAccounts } from "./state.js";

/** Mirrors programs/holdfast-vault/src/constants.rs. */
export const MIN_DEFEND_LAMPORTS = 1_000_000n;
export const MIN_BURN_LAMPORTS = 10_000_000n;
/** `prepare_treasury` leaves at least one minimum buyback step in the floor bucket. */
export const MIN_FLOOR_AFTER_PREPARE = (MIN_DEFEND_LAMPORTS * 10_000n) / BigInt(DEFEND_STEP_BPS);

/** Rent `prepare_treasury` takes from the floor bucket for the accounts still missing. */
export function prepareCost(t: TreasuryAccounts, rent = DEFAULT_RENT): bigint {
  return (
    (t.tokenAccount ? 0n : rent(TOKEN_2022_ATA_SIZE)) +
    (t.wsolAccount ? 0n : rent(SPL_TOKEN_ACCOUNT_SIZE)) +
    (t.volumeAccumulator ? 0n : rent(PUMP_USER_VOLUME_ACCUMULATOR_SIZE))
  );
}

export type CrankAction =
  | { kind: "graduate" }
  | { kind: "update_ath" }
  | { kind: "collect" }
  | { kind: "prepare" }
  | { kind: "defend"; budget: bigint; minTokensOut: bigint }
  | { kind: "burn" };

export interface CrankMemory {
  /** unix seconds of the last fee collection / burn this keeper sent for the coin. */
  lastCollectAt: number;
  lastBurnAt: number;
}

export interface PlanOptions {
  collectEverySecs: number;
  defendSlippageBps: number;
  curveFeeBpsEstimate: number;
  ammFeeBpsEstimate: number;
  burnThresholdLamports: bigint;
  burnEverySecs: number;
  holdMintSet: boolean;
}

/** Constant-product quote with the fee taken from the input (pump.fun buy_exact_sol_in / PumpSwap buy_exact_quote_in). */
export function quoteBuy(spendable: bigint, quoteReserve: bigint, baseReserve: bigint, feeBps: number): bigint {
  if (spendable <= 0n || quoteReserve <= 0n || baseReserve <= 0n) return 0n;
  const net = (spendable * 10_000n) / BigInt(10_000 + feeBps);
  return (net * baseReserve) / (quoteReserve + net);
}

export function applySlippage(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

/** Fewest tokens the program will accept for `lamports` at the floor cap (programs/.../math.rs). */
export function floorMinTokens(lamports: bigint, floorPrice: bigint, toleranceBps: number): bigint {
  const maxPrice = (floorPrice * BigInt(10_000 + toleranceBps)) / 10_000n;
  if (maxPrice === 0n) return 0n;
  return (lamports * PRICE_SCALE + maxPrice - 1n) / maxPrice;
}

/** Decides what to crank for one coin right now. Pure: all inputs are explicit. */
export function planCrank(s: CoinChainState, params: ConfigAccount["params"], memory: CrankMemory, nowSec: number, o: PlanOptions): CrankAction[] {
  const actions: CrankAction[] = [];
  const v = s.vault;

  if (v.venue === "curve" && s.curve.complete) {
    // Curve reserves are frozen once complete; nothing to sample or buy until the pool is live.
    if (s.pool) actions.push({ kind: "graduate" });
    return actions;
  }

  if (nowSec - memory.lastCollectAt >= o.collectEverySecs) actions.push({ kind: "collect" });

  if (v.observationCount === 0 || nowSec - v.lastObservationTs >= params.twapMinSampleIntervalSecs) {
    actions.push({ kind: "update_ath" });
  }

  // The treasury's token accounts and volume accumulator are created once the coin's own floor bucket
  // can pay for them (and still fund a buyback); buybacks and burns need them.
  const ready = treasuryReady(s.treasury);
  if (!ready && v.floorSol > prepareCost(s.treasury) + MIN_FLOOR_AFTER_PREPARE) actions.push({ kind: "prepare" });
  const canBuy = ready || actions.some((a) => a.kind === "prepare");

  const budget = (v.floorSol * BigInt(DEFEND_STEP_BPS)) / 10_000n;
  const cooledDown = v.defendCount === 0n || nowSec - v.lastDefendTs >= params.defendCooldownSecs;
  const windowDefends = nowSec - v.hourWindowStart >= 3_600 ? 0 : v.hourWindowDefends;
  if (canBuy && v.floorPrice > 0n && s.spot <= v.floorPrice && budget >= MIN_DEFEND_LAMPORTS && cooledDown && windowDefends < params.maxDefendsPerHour) {
    const expected =
      v.venue === "amm" && s.pool
        ? quoteBuy(budget, s.pool.quoteAmount + s.pool.virtualQuoteReserves, s.pool.baseAmount, o.ammFeeBpsEstimate)
        : quoteBuy(budget, s.curve.virtualQuoteReserves, s.curve.virtualTokenReserves, o.curveFeeBpsEstimate);
    // If the market cannot fill at the floor cap the program would reject it anyway: skip.
    if (expected >= floorMinTokens(budget, v.floorPrice, params.defendPriceToleranceBps)) {
      actions.push({ kind: "defend", budget, minTokensOut: applySlippage(expected, o.defendSlippageBps) });
    }
  }

  if (canBuy && o.holdMintSet && v.burnSol >= o.burnThresholdLamports && v.burnSol >= MIN_BURN_LAMPORTS && nowSec - memory.lastBurnAt >= o.burnEverySecs) {
    actions.push({ kind: "burn" });
  }
  return actions;
}
