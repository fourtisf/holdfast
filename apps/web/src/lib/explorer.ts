import type { Cluster } from "./config";

function clusterQuery(cluster: Cluster): string {
  if (cluster === "mainnet-beta") return "";
  if (cluster === "localnet") return `?cluster=custom&customUrl=${encodeURIComponent("http://127.0.0.1:8899")}`;
  return `?cluster=${cluster}`;
}

export function explorerTxUrl(signature: string, cluster: Cluster): string {
  return `https://explorer.solana.com/tx/${signature}${clusterQuery(cluster)}`;
}

export function explorerAddressUrl(address: string, cluster: Cluster): string {
  return `https://explorer.solana.com/address/${address}${clusterQuery(cluster)}`;
}

/** Third-party coin pages. pump.fun and DexScreener index mainnet only. */
export function coinLinks(mint: string, cluster: Cluster): { label: string; href: string }[] {
  const solscan = `https://solscan.io/token/${mint}${cluster === "mainnet-beta" ? "" : `?cluster=${cluster === "localnet" ? "custom" : cluster}`}`;
  if (cluster !== "mainnet-beta") return [{ label: "Solscan", href: solscan }];
  return [
    { label: "pump.fun", href: `https://pump.fun/coin/${mint}` },
    { label: "DexScreener", href: `https://dexscreener.com/solana/${mint}` },
    { label: "Solscan", href: solscan },
  ];
}
