export type Cluster = "devnet" | "mainnet-beta" | "testnet" | "localnet";

function parseCluster(value: string | undefined): Cluster {
  return value === "mainnet-beta" || value === "testnet" || value === "localnet" ? value : "devnet";
}

export const USE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS === "1";
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000/ws";
export const SOLANA_CLUSTER: Cluster = parseCluster(process.env.NEXT_PUBLIC_SOLANA_CLUSTER);
export const CLUSTER_LABEL = SOLANA_CLUSTER === "mainnet-beta" ? "mainnet" : SOLANA_CLUSTER;

/** Official X account, linked from the nav, the announcement bar and the sidebar. */
export const X_URL = process.env.NEXT_PUBLIC_X_URL || "https://x.com/moatpad";
export const X_HANDLE = `@${X_URL.replace(/\/+$/, "").split("/").pop() || "moatpad"}`;
/** Official Telegram channel, linked next to the X account. */
export const TELEGRAM_URL = process.env.NEXT_PUBLIC_TELEGRAM_URL || "https://t.me/MOATPAD";
/** The official $MOATPAD contract address (pump.fun), shown in the announcement bar; NEXT_PUBLIC_MOAT_CA overrides it. */
export const MOAT_CA = (process.env.NEXT_PUBLIC_MOAT_CA || "4qLdhoVDiAkXVXqU4D3rSPp6pMMnJzRJr38do55Hpump").trim();

const DEFAULT_RPC: Record<Cluster, string> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
};

export const SOLANA_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || DEFAULT_RPC[SOLANA_CLUSTER];
