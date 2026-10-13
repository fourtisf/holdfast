import { curvePriceFixed, poolPriceFixed, tradePrice } from "@holdfast/core";
import type { AmmBuyEvent, AmmSellEvent, CurveTradeEvent, PostCompleteBuyEvent } from "./events.js";

/**
 * Prices derived from trade events. Fixed-point values use @holdfast/core's PRICE_SCALE
 * (lamports per base unit × 1e18); `tradePrice` gives SOL per whole token.
 */

/** Bonding-curve spot price after the trade (TradeEvent reserves are post-trade). */
export function curveSpotAfter(e: CurveTradeEvent): bigint {
  return curvePriceFixed(e.virtualSolReserves, e.virtualTokenReserves);
}

/**
 * PumpSwap spot price after the trade, priced on effective quote reserves
 * (`pool quote balance + virtual_quote_reserves`, signed). The event reports the reserves the
 * trade was priced on; the LP fee stays in the pool, protocol/creator fees do not count as liquidity.
 */
export function ammSpotAfter(e: AmmBuyEvent | AmmSellEvent): bigint {
  if (e.type === "amm_buy") {
    const base = e.poolBaseTokenReserves - e.baseAmountOut;
    const quote = e.poolQuoteTokenReserves + e.quoteAmountInWithLpFee;
    return poolPriceFixed(quote, e.virtualQuoteReserves, base);
  }
  const base = e.poolBaseTokenReserves + e.baseAmountIn;
  const quote = e.poolQuoteTokenReserves - e.quoteAmountOutWithoutLpFee;
  return poolPriceFixed(quote, e.virtualQuoteReserves, base);
}

/** Spot price the trade was executed against (before it), PumpSwap. */
export function ammSpotBefore(e: AmmBuyEvent | AmmSellEvent): bigint {
  return poolPriceFixed(e.poolQuoteTokenReserves, e.virtualQuoteReserves, e.poolBaseTokenReserves);
}

/** Pool spot after a synthetic-migration buy (the reserves the pool opens with). */
export function postCompleteSpotAfter(e: PostCompleteBuyEvent): bigint {
  return poolPriceFixed(e.poolQuoteReservesAfter, 0n, e.poolBaseReservesAfter);
}

export interface TradeAmounts {
  isBuy: boolean;
  /** Lamports exchanged with the curve/pool, fees excluded. */
  sol: bigint;
  tokens: bigint;
  /** SOL per whole token. */
  price: number;
}

/** Normalized amounts of a swap event: price = sol / tokens. */
export function tradeAmounts(e: CurveTradeEvent | PostCompleteBuyEvent | AmmBuyEvent | AmmSellEvent, decimals = 6): TradeAmounts {
  switch (e.type) {
    case "curve_trade":
      return { isBuy: e.isBuy, sol: e.solAmount, tokens: e.tokenAmount, price: tradePrice(e.solAmount, e.tokenAmount, decimals) };
    case "post_complete_buy":
      return { isBuy: true, sol: e.quoteIn, tokens: e.baseOut, price: tradePrice(e.quoteIn, e.baseOut, decimals) };
    case "amm_buy":
      return { isBuy: true, sol: e.quoteAmountIn, tokens: e.baseAmountOut, price: tradePrice(e.quoteAmountIn, e.baseAmountOut, decimals) };
    case "amm_sell":
      return { isBuy: false, sol: e.quoteAmountOut, tokens: e.baseAmountIn, price: tradePrice(e.quoteAmountOut, e.baseAmountIn, decimals) };
  }
}
