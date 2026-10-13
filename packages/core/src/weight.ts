import { WEIGHT_MAX_PPM, WEIGHT_MIN_PPM, WEIGHT_RAMP_SECONDS } from "./constants.js";

/**
 * weight = 0.1 + 0.9 × min(hours_held, 168) / 168, in parts per million (exact integer math).
 * Ages are in seconds so the weight rises continuously instead of hour by hour. Negative ages
 * (clock skew between a lot timestamp and the snapshot) count as zero.
 */
export function weightPpm(ageSeconds: bigint): bigint {
  const age = ageSeconds < 0n ? 0n : ageSeconds > WEIGHT_RAMP_SECONDS ? WEIGHT_RAMP_SECONDS : ageSeconds;
  return WEIGHT_MIN_PPM + ((WEIGHT_MAX_PPM - WEIGHT_MIN_PPM) * age) / WEIGHT_RAMP_SECONDS;
}

/** Weight for a lot acquired at `acquiredAtMs`, evaluated at `atMs`. */
export function lotWeightPpm(acquiredAtMs: number, atMs: number): bigint {
  return weightPpm(BigInt(Math.floor((atMs - acquiredAtMs) / 1000)));
}

/** Display helper: weight as a float multiplier between 0.1 and 1.0. */
export function weightMultiplier(acquiredAtMs: number, atMs: number): number {
  return Number(lotWeightPpm(acquiredAtMs, atMs)) / 1_000_000;
}

export interface WeightedLot {
  amount: bigint;
  acquiredAt: number;
}

/** Σ(lot.amount × weight_ppm(lot.age)). Divide by 1e6 for weighted tokens. */
export function weightedAmount(lots: readonly WeightedLot[], atMs: number): bigint {
  let total = 0n;
  for (const lot of lots) total += lot.amount * lotWeightPpm(lot.acquiredAt, atMs);
  return total;
}
