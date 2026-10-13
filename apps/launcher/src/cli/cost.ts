/**
 * `pnpm --filter @holdfast/launcher cost [devBuySol] [metadataBaseUrl]`: prints the launch cost
 * breakdown with mainnet/devnet rent (or the cluster's, with SOLANA_RPC_URL + --rpc).
 */
import { Connection } from "@solana/web3.js";
import { LAUNCH_FEE_LAMPORTS } from "@holdfast/core";

import { computeLaunchCost, DEFAULT_PRIORITY, DEFAULT_RENT, formatSol, rentFromChain, type CostItem } from "../cost.js";
import { metadataUriLength } from "../metadata.js";

const args = process.argv.slice(2).filter((a) => a !== "--rpc");
const devBuySol = Number(args[0] ?? "0");
const base = args[1] ?? process.env.PUBLIC_METADATA_BASE_URL ?? "https://api.holdfast.fun/metadata";
const rent = process.argv.includes("--rpc")
  ? await rentFromChain(async (len) => BigInt(await new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com").getMinimumBalanceForRentExemption(len)))
  : DEFAULT_RENT;

const cost = computeLaunchCost(rent, {
  nameBytes: 12,
  symbolBytes: 5,
  uriBytes: metadataUriLength(base),
  priority: DEFAULT_PRIORITY,
  devBuyLamports: BigInt(Math.round(devBuySol * 1e9)),
});
const row = (i: CostItem) => `  ${formatSol(i.lamports).padStart(12)}  ${i.label}${i.bytes !== undefined ? ` [${i.bytes} B]` : ""}`;
console.log(`consumed by every launch:\n${cost.items.map(row).join("\n")}`);
console.log(`  ${formatSol(cost.consumed).padStart(12)}  TOTAL (spec: ${formatSol(LAUNCH_FEE_LAMPORTS)}${cost.exceedsSpecFee ? ", EXCEEDED" : ""})`);
console.log(`float (refunded):\n${cost.float.map(row).join("\n")}`);
if (cost.devBuy.lamports > 0n) {
  console.log(`dev buy ${formatSol(cost.devBuy.lamports)} SOL, extra cost:\n${cost.devBuy.items.map(row).join("\n")}`);
  console.log(`dev buy float (refunded):\n${cost.devBuy.float.map(row).join("\n")}`);
}
console.log(`required deposit: ${formatSol(cost.requiredLamports)} SOL`);
