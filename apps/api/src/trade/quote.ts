import BN from "bn.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { buyQuoteInput, sellBaseInput } from "@pump-fun/pump-swap-sdk";
import type { TradeQuote } from "@holdfast/core";
import { badRequest } from "../errors.js";
import { solToLamports, tokensToRaw } from "../format.js";
import type { AmmVenue, CurveVenue, VenueState } from "./chain.js";
import { pumpSdk } from "./sdk.js";

/**
 * Offline quote math with the SDKs' own quote functions. Buys are exact-output (the SDK flow:
 * tokens = f(SOL), max cost = SOL × (1 + slippage)), so `minOut` equals `expectedOut`; sells
 * are exact-input with `minOut` = expected SOL × (1 − slippage).
 */

export interface QuoteInput {
  side: "buy" | "sell";
  /** buy: SOL to spend; sell: whole tokens. */
  amount: number;
  slippageBps: number;
}

/** What the builder needs to turn a quote into instructions. */
export interface TradePlan {
  venue: "curve" | "pumpswap";
  side: "buy" | "sell";
  /** Lamports in (buys) or token base units in (sells). */
  amountIn: BN;
  /** Tokens out (buys) or lamports out (sells), before slippage. */
  expectedOut: BN;
  slippagePct: number;
}

const toNum = (v: BN) => Number(v.toString());
const pct = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);

function curveFeeBps(v: CurveVenue): number {
  const { protocolFeeBps, creatorFeeBps } = pumpSdk.computeFeesBps({
    global: v.global,
    feeConfig: v.feeConfig,
    mintSupply: v.mintSupply,
    virtualQuoteReserves: v.bondingCurve.virtualQuoteReserves,
    virtualTokenReserves: v.bondingCurve.virtualTokenReserves,
    quoteMint: v.bondingCurve.quoteMint,
    creatorFeeBps: v.bondingCurve.creatorFeeBps,
  });
  const creator = PublicKey.default.equals(v.bondingCurve.creator) ? 0 : toNum(creatorFeeBps);
  return toNum(protocolFeeBps) + creator;
}

function quoteCurve(v: CurveVenue, input: QuoteInput, decimals: number): { quote: TradeQuote; plan: TradePlan } {
  const { bondingCurve: bc } = v;
  const slippagePct = input.slippageBps / 100;
  const spot = toNum(bc.virtualQuoteReserves) / toNum(bc.virtualTokenReserves);
  if (input.side === "buy") {
    const lamports = new BN(solToLamports(input.amount).toString());
    const tokens = pumpSdk.getBuyTokenAmountFromSolAmount({
      global: v.global,
      feeConfig: v.feeConfig,
      mintSupply: v.mintSupply,
      bondingCurve: bc,
      amount: lamports,
      quoteMint: NATIVE_MINT,
    });
    if (tokens.isZero()) throw badRequest("Amount too small");
    const netIn = toNum(lamports) * (10_000 / (10_000 + curveFeeBps(v)));
    const out = toNum(tokens) / 10 ** decimals;
    return {
      quote: {
        side: "buy",
        expectedOut: out,
        minOut: out,
        priceImpactPct: pct((netIn / toNum(tokens) / spot - 1) * 100),
        feeSol: (toNum(lamports) - netIn) / 1e9,
        venue: "curve",
      },
      plan: { venue: "curve", side: "buy", amountIn: lamports, expectedOut: tokens, slippagePct },
    };
  }
  const tokensIn = new BN(tokensToRaw(input.amount, decimals).toString());
  const solOut = pumpSdk.getSellSolAmountFromTokenAmount({ global: v.global, feeConfig: v.feeConfig, mintSupply: v.mintSupply, bondingCurve: bc, amount: tokensIn });
  if (solOut.lten(0)) throw badRequest("Amount too small");
  const gross = tokensIn.mul(bc.virtualQuoteReserves).div(bc.virtualTokenReserves.add(tokensIn));
  const out = toNum(solOut) / 1e9;
  return {
    quote: {
      side: "sell",
      expectedOut: out,
      minOut: out * (1 - slippagePct / 100),
      priceImpactPct: pct((1 - toNum(gross) / toNum(tokensIn) / spot) * 100),
      feeSol: toNum(gross.sub(solOut)) / 1e9,
      venue: "curve",
    },
    plan: { venue: "curve", side: "sell", amountIn: tokensIn, expectedOut: solOut, slippagePct },
  };
}

function quoteAmm(v: AmmVenue, input: QuoteInput, decimals: number): { quote: TradeQuote; plan: TradePlan } {
  const s = v.swap;
  const slippagePct = input.slippageBps / 100;
  const common = {
    slippage: slippagePct,
    baseReserve: s.poolBaseAmount,
    quoteReserve: s.poolQuoteAmount,
    virtualQuoteReserves: s.pool.virtualQuoteReserves,
    globalConfig: s.globalConfig,
    baseMintAccount: s.baseMintAccount,
    baseMint: s.baseMint,
    coinCreator: s.pool.coinCreator,
    creator: s.pool.creator,
    feeConfig: s.feeConfig,
    quoteMint: s.pool.quoteMint,
    isMayhemMode: s.pool.isMayhemMode,
    creatorFeeBps: s.pool.creatorFeeBps,
  };
  // Effective quote reserves: vault balance + signed virtual_quote_reserves.
  const spot = toNum(s.poolQuoteAmount.add(s.pool.virtualQuoteReserves)) / toNum(s.poolBaseAmount);
  if (input.side === "buy") {
    const lamports = new BN(solToLamports(input.amount).toString());
    const r = buyQuoteInput({ ...common, quote: lamports });
    if (r.base.lten(0)) throw badRequest("Amount too small");
    const out = toNum(r.base) / 10 ** decimals;
    return {
      quote: {
        side: "buy",
        expectedOut: out,
        minOut: out,
        priceImpactPct: pct((toNum(r.internalQuoteWithoutFees) / toNum(r.base) / spot - 1) * 100),
        feeSol: toNum(lamports.sub(r.internalQuoteWithoutFees)) / 1e9,
        venue: "pumpswap",
      },
      plan: { venue: "pumpswap", side: "buy", amountIn: lamports, expectedOut: r.base, slippagePct },
    };
  }
  const base = new BN(tokensToRaw(input.amount, decimals).toString());
  const r = sellBaseInput({ ...common, base, feeBucketsTotal: s.pool.protocolFees.add(s.pool.creatorFees) });
  if (r.uiQuote.lten(0)) throw badRequest("Amount too small");
  return {
    quote: {
      side: "sell",
      expectedOut: toNum(r.uiQuote) / 1e9,
      minOut: toNum(r.minQuote) / 1e9,
      priceImpactPct: pct((1 - toNum(r.internalQuoteAmountOut) / toNum(base) / spot) * 100),
      feeSol: toNum(r.internalQuoteAmountOut.sub(r.uiQuote)) / 1e9,
      venue: "pumpswap",
    },
    plan: { venue: "pumpswap", side: "sell", amountIn: base, expectedOut: r.uiQuote, slippagePct },
  };
}

export function quoteTrade(state: VenueState, input: QuoteInput, decimals: number): { quote: TradeQuote; plan: TradePlan } {
  return state.venue === "curve" ? quoteCurve(state, input, decimals) : quoteAmm(state, input, decimals);
}
