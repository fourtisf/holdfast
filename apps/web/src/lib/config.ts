export type Cluster = "devnet" | "mainnet-beta" | "testnet" | "localnet";

function parseCluster(value: string | undefined): Cluster {
  return value === "mainnet-beta" || value === "testnet" || value === "localnet" ? value : "devnet";
}

export const USE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS === "1";
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
/** The API's WebSocket; unset, it is derived from the API URL (https://site/api → wss://site/api/ws). */
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL || `${API_URL.replace(/^http/, "ws")}/ws`;
export const SOLANA_CLUSTER: Cluster = parseCluster(process.env.NEXT_PUBLIC_SOLANA_CLUSTER);
export const CLUSTER_LABEL = SOLANA_CLUSTER === "mainnet-beta" ? "mainnet" : SOLANA_CLUSTER;

/** Official X account, linked from the nav, the announcement bar and the sidebar. */
export const X_URL = process.env.NEXT_PUBLIC_X_URL || "https://x.com/moatpad";
export const X_HANDLE = `@${X_URL.replace(/\/+$/, "").split("/").pop() || "moatpad"}`;
/** Official Telegram channel, linked next to the X account. */
export const TELEGRAM_URL = process.env.NEXT_PUBLIC_TELEGRAM_URL || "https://t.me/MOATPAD";
/** Username of the Moatpad Telegram bot (launches, buy bot, alerts); empty hides the bot links. */
export const TELEGRAM_BOT = (process.env.NEXT_PUBLIC_TELEGRAM_BOT || "").trim().replace(/^@/, "");

/** Telegram ignores a start payload longer than 64 characters or with anything but A-Z, a-z, 0-9, _ and -. */
const START_PAYLOAD = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Deep link into the bot: a private chat that runs `/start <payload>`, or (group) the "add to a group"
 * picker that runs it in the chosen group. Null when no bot is configured or Telegram would drop the payload.
 */
export function botUrl(payload?: string, group = false): string | null {
  if (!TELEGRAM_BOT) return null;
  const base = `https://t.me/${TELEGRAM_BOT}`;
  if (payload === undefined) return base;
  if (!START_PAYLOAD.test(payload)) return null;
  return `${base}?${group ? "startgroup" : "start"}=${payload}`;
}
/** The official $MOATPAD contract address (pump.fun), shown in the announcement bar; NEXT_PUBLIC_MOAT_CA overrides it. */
export const MOAT_CA = (process.env.NEXT_PUBLIC_MOAT_CA || "4qLdhoVDiAkXVXqU4D3rSPp6pMMnJzRJr38do55Hpump").trim();

const DEFAULT_RPC: Record<Cluster, string> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
};

export const SOLANA_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || DEFAULT_RPC[SOLANA_CLUSTER];
