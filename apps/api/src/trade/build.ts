import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { PUMP_AMM_SDK } from "@pump-fun/pump-swap-sdk";
import { badRequest } from "../errors.js";
import type { VenueState } from "./chain.js";
import type { TradePlan } from "./quote.js";
import { pumpSdk } from "./sdk.js";

/** Trade instructions from the official SDK builders (ATA creation and WSOL handling included). */
export async function tradeInstructions(state: VenueState, plan: TradePlan, wallet: PublicKey): Promise<TransactionInstruction[]> {
  if (state.venue === "curve") {
    const common = {
      global: state.global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo,
      bondingCurve: state.bondingCurve,
      mint: state.mint,
      user: wallet,
      slippage: plan.slippagePct,
      tokenProgram: state.tokenProgram,
      quoteTokenProgram: state.quoteTokenProgram,
    };
    if (plan.side === "buy") {
      // buy_v2: exact tokens out, max cost = quote × (1 + slippage).
      return pumpSdk.PUMP_SDK.buyV2Instructions({
        ...common,
        associatedUserAccountInfo: state.associatedUserAccountInfo,
        amount: plan.expectedOut,
        quoteAmount: plan.amountIn,
      });
    }
    if (!state.associatedUserAccountInfo) throw badRequest("This wallet holds no tokens of this coin");
    // sell_v2: exact tokens in, min out = expected × (1 − slippage).
    return pumpSdk.PUMP_SDK.sellV2Instructions({ ...common, amount: plan.amountIn, quoteAmount: plan.expectedOut });
  }
  if (plan.side === "buy") return PUMP_AMM_SDK.buyQuoteInput(state.swap, plan.amountIn, plan.slippagePct);
  if (!state.swap.userBaseAccountInfo) throw badRequest("This wallet holds no tokens of this coin");
  return PUMP_AMM_SDK.sellBaseInput(state.swap, plan.amountIn, plan.slippagePct);
}

export function assembleTransaction(opts: {
  instructions: TransactionInstruction[];
  payer: PublicKey;
  blockhash: string;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
}): VersionedTransaction {
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnitLimit })];
  if (opts.computeUnitPriceMicroLamports > 0) budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.computeUnitPriceMicroLamports }));
  const message = new TransactionMessage({ payerKey: opts.payer, recentBlockhash: opts.blockhash, instructions: [...budget, ...opts.instructions] }).compileToV0Message();
  return new VersionedTransaction(message);
}
