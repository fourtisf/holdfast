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
