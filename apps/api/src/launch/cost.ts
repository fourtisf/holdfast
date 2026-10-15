import { DEFAULT_RENT, PUMP_MAX_NAME_BYTES, PUMP_MAX_SYMBOL_BYTES, computeLaunchCost, launchCostOptions, rentFromChain, utf8Len, type LaunchCost, type LaunchPlan, type RentFn } from "@holdfast/chain";
import { LAUNCH_FEE_LAMPORTS, type LaunchQuote } from "@holdfast/core";
import { lamportsToSol, solToLamports } from "../format.js";

/** The launcher's launch plan (atomic or split flow, metadata storage, priority fee, slippage). */
export type LaunchCostSettings = LaunchPlan;

let rent: RentFn = DEFAULT_RENT;

/**
 * Quotes with the cluster's own rent, as the launcher does (mainnet lowered it below DEFAULT_RENT), so the quoted
 * deposit is what the launcher waits for. Until it is loaded, or if it fails, DEFAULT_RENT is used.
 */
export async function loadClusterRent(getMinimumBalance: (dataLen: number) => Promise<bigint>): Promise<void> {
  rent = await rentFromChain(getMinimumBalance);
}

/** The launcher's cost model (packages/chain/src/launch), so quoted deposits are exactly what it waits for. */
export function launchCost(s: LaunchCostSettings, req: { name?: string; ticker?: string; devBuySol?: number }): LaunchCost {
  return computeLaunchCost(
    rent,
    launchCostOptions(s, {
      nameBytes: req.name ? Math.min(utf8Len(req.name.trim()), PUMP_MAX_NAME_BYTES) : PUMP_MAX_NAME_BYTES,
      symbolBytes: req.ticker ? Math.min(utf8Len(req.ticker.trim()), PUMP_MAX_SYMBOL_BYTES) : PUMP_MAX_SYMBOL_BYTES,
      devBuyLamports: solToLamports(req.devBuySol ?? 0),
    }),
  );
}

export function toLaunchQuote(cost: LaunchCost): LaunchQuote {
  return {
    launchFeeSol: lamportsToSol(cost.launchFee),
    devBuySol: lamportsToSol(cost.devBuy.lamports),
    devBuyExtraSol: lamportsToSol(cost.devBuy.consumed + cost.devBuy.floatTotal),
    requiredSol: lamportsToSol(cost.requiredLamports),
    requiredLamports: cost.requiredLamports.toString(),
    specFeeSol: lamportsToSol(LAUNCH_FEE_LAMPORTS),
    exceedsSpecFee: cost.exceedsSpecFee,
  };
}
