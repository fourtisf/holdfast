/**
 * `pnpm --filter @holdfast/launcher cost [devBuySol] [--atomic] [--ipfs] [--rpc]`: prints the launch
 * cost breakdown for a typical coin (12-byte name, 5-byte ticker) with mainnet/devnet rent (or the
 * cluster's, with SOLANA_RPC_URL + --rpc). The launch plan comes from the same environment variables
 * the launcher and API read; --atomic / --ipfs override LAUNCHER_LOOKUP_TABLE / METADATA_STORAGE.
 */
import { Connection } from "@solana/web3.js";
import { LAUNCH_FEE_LAMPORTS } from "@holdfast/core";

import { computeLaunchCost, DEFAULT_RENT, formatSol, launchCostOptions, launchPlanFromEnv, rentFromChain, type CostItem } from "@holdfast/chain";

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const devBuySol = Number(args[0] ?? "0");
const env = { ...process.env };
if (flags.has("--atomic")) env.LAUNCHER_LOOKUP_TABLE = env.LAUNCHER_LOOKUP_TABLE || "11111111111111111111111111111111";
if (flags.has("--ipfs")) env.METADATA_STORAGE = "pinata";
const plan = launchPlanFromEnv(env, { publicMetadataBaseUrl: "https://api.holdfast.fun/metadata" });
const rent = flags.has("--rpc")
  ? await rentFromChain(async (len) => BigInt(await new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com").getMinimumBalanceForRentExemption(len)))
  : DEFAULT_RENT;

const cost = computeLaunchCost(rent, launchCostOptions(plan, { nameBytes: 12, symbolBytes: 5, devBuyLamports: BigInt(Math.round(devBuySol * 1e9)) }));
const row = (i: CostItem) => `  ${formatSol(i.lamports).padStart(12)}  ${i.label}${i.bytes !== undefined ? ` [${i.bytes} B]` : ""}`;
console.log(`mode ${plan.mode}, metadata ${plan.metadata.kind}`);
console.log(`consumed by every launch:\n${cost.items.map(row).join("\n")}`);
console.log(`  ${formatSol(cost.consumed).padStart(12)}  TOTAL (spec: ${formatSol(LAUNCH_FEE_LAMPORTS)}${cost.exceedsSpecFee ? ", EXCEEDED" : ""})`);
console.log(`float (refunded):\n${cost.float.map(row).join("\n")}`);
if (cost.devBuy.lamports > 0n) {
  console.log(`dev buy ${formatSol(cost.devBuy.lamports)} SOL, extra cost:\n${cost.devBuy.items.map(row).join("\n")}`);
  console.log(`dev buy float (refunded):\n${cost.devBuy.float.map(row).join("\n")}`);
}
console.log(`required deposit: ${formatSol(cost.requiredLamports)} SOL`);
