import { PRICE_SCALE, PUMP_TOKEN_DECIMALS, PUMP_TOTAL_SUPPLY_BASE_UNITS } from "./constants.js";

/**
 * Prices share the on-chain fixed-point representation: lamports per token base unit × 1e18
 * (`PRICE_SCALE`). Display helpers convert to SOL per whole token.
 */

/** Bonding curve spot price from virtual reserves. */
export function curvePriceFixed(virtualQuoteReserves: bigint, virtualTokenReserves: bigint): bigint {
  if (virtualTokenReserves <= 0n) return 0n;
  return (virtualQuoteReserves * PRICE_SCALE) / virtualTokenReserves;
}

/**
 * PumpSwap spot price: effective quote = pool quote token balance + Pool.virtual_quote_reserves
 * (signed i128; pump guarantees the sum is never negative).
 */
export function poolPriceFixed(poolQuoteAmount: bigint, virtualQuoteReserves: bigint, poolBaseAmount: bigint): bigint {
  const quote = poolQuoteAmount + virtualQuoteReserves;
  if (poolBaseAmount <= 0n || quote <= 0n) return 0n;
  return (quote * PRICE_SCALE) / poolBaseAmount;
}

/** floor = ATH × (1 − trigger). */
export function floorFromAth(athFixed: bigint, triggerBps: number): bigint {
  return (athFixed * BigInt(10_000 - triggerBps)) / 10_000n;
}

export function fixedToSolPerToken(priceFixed: bigint, decimals = PUMP_TOKEN_DECIMALS): number {
  // lamports/base × 10^decimals / 1e9 = SOL per whole token
  return (Number(priceFixed) / Number(PRICE_SCALE)) * 10 ** decimals / 1e9;
}

export function solPerTokenToFixed(price: number, decimals = PUMP_TOKEN_DECIMALS): bigint {
  const lamportsPerBase = (price * 1e9) / 10 ** decimals;
  return BigInt(Math.round(lamportsPerBase * 1e18));
}

/** Market cap in SOL for a price in SOL per whole token. */
export function marketCapSol(pricePerToken: number, supplyBaseUnits = PUMP_TOTAL_SUPPLY_BASE_UNITS, decimals = PUMP_TOKEN_DECIMALS): number {
  return pricePerToken * (Number(supplyBaseUnits) / 10 ** decimals);
}

/** Where `price` sits between floor (0) and ATH (1), clamped. */
export function floorToAthProgress(price: number, floor: number, ath: number): number {
  if (ath <= floor) return price >= ath ? 1 : 0;
  return Math.min(1, Math.max(0, (price - floor) / (ath - floor)));
}

/** Price of a trade in SOL per whole token. */
export function tradePrice(lamports: bigint, tokensRaw: bigint, decimals = PUMP_TOKEN_DECIMALS): number {
  if (tokensRaw === 0n) return 0;
  return Number(lamports) / 1e9 / (Number(tokensRaw) / 10 ** decimals);
}
