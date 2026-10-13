import { DEFAULT_COMPUTE_UNITS, DEFAULT_RENT, PUMP_MAX_NAME_BYTES, PUMP_MAX_SYMBOL_BYTES, computeLaunchCost, utf8Len, type LaunchCost } from "@holdfast/chain";
import { LAUNCH_FEE_LAMPORTS, type LaunchQuote } from "@holdfast/core";
import { lamportsToSol, solToLamports } from "../format.js";

export interface LaunchCostSettings {
  publicMetadataBaseUrl: string;
  /** Must match the launcher's LAUNCHER_PRIORITY_FEE_MICROLAMPORTS / LAUNCHER_DEV_BUY_SLIPPAGE_BPS. */
  priorityMicroLamports: number;
  devBuySlippageBps: number;
}

/** The launcher's cost model (packages/chain/src/launch), so quoted deposits are exactly what it waits for. */
export function launchCost(s: LaunchCostSettings, req: { name?: string; ticker?: string; devBuySol?: number }): LaunchCost {
  return computeLaunchCost(DEFAULT_RENT, {
    nameBytes: req.name ? utf8Len(req.name.trim()) : PUMP_MAX_NAME_BYTES,
    symbolBytes: req.ticker ? utf8Len(req.ticker.trim()) : PUMP_MAX_SYMBOL_BYTES,
    // metadata URIs are `<base>/<sha256 hex>.json`
    uriBytes: utf8Len(s.publicMetadataBaseUrl.replace(/\/+$/, "")) + 1 + 64 + 5,
    devBuyLamports: solToLamports(req.devBuySol ?? 0),
    priority: { microLamports: BigInt(s.priorityMicroLamports), units: DEFAULT_COMPUTE_UNITS },
    devBuySlippageBps: s.devBuySlippageBps,
  });
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
