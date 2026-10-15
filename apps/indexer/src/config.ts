import type { ReductionOrder } from "@holdfast/core";

export interface IndexerConfig {
  databaseUrl: string;
  rpcUrl: string;
  /** RPC WebSocket for live ingestion; null derives it from rpcUrl (https → wss). */
  wsUrl: string | null;
  /** Index transactions pushed over the RPC WebSocket as they confirm (the poller backs it up). */
  live: boolean;
  /** Abort RPC requests after this long (one stuck request must not stall ingestion). */
  rpcTimeoutMs: number;
  /** Addresses the poller lists at the same time (each is one RPC call). */
  pollConcurrency: number;
  holdfastProgramId: string;
  heliusWebhookSecret: string | null;
  port: number;
  host: string;
  poll: boolean;
  pollIntervalMs: number;
  maxSupportedTransactionVersion: number;
  reductionOrder: ReductionOrder;
  /** Launcher hot wallet(s): on-curve, so they must be excluded explicitly. */
  launcherAddresses: string[];
  migrate: boolean;
  logLevel: string;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
}

export function reductionOrderFrom(v: string | undefined): ReductionOrder {
  const order = (v ?? "fifo").toLowerCase();
  if (order !== "fifo" && order !== "lifo") throw new Error(`LOT_REDUCTION_ORDER must be fifo or lifo, got ${v}`);
  return order;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return {
    databaseUrl,
    rpcUrl: env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    wsUrl: env.SOLANA_WS_URL || null,
    live: bool(env.INDEXER_LIVE, true),
    rpcTimeoutMs: Number(env.INDEXER_RPC_TIMEOUT_MS || 20_000),
    pollConcurrency: Math.max(1, Number(env.INDEXER_POLL_CONCURRENCY || 2)),
    holdfastProgramId: env.HOLDFAST_PROGRAM_ID ?? "8pVgMgwxbhPuKLwsP7z9sa6ADs7L3KWYAbhBGnrtgSmN",
    heliusWebhookSecret: env.HELIUS_WEBHOOK_SECRET || null,
    port: Number(env.INDEXER_PORT ?? 4100),
    host: env.INDEXER_HOST ?? "0.0.0.0",
    poll: bool(env.INDEXER_POLL, true),
    pollIntervalMs: Number(env.INDEXER_POLL_INTERVAL_MS ?? 3000),
    maxSupportedTransactionVersion: Number(env.INDEXER_MAX_TX_VERSION ?? 0),
    reductionOrder: reductionOrderFrom(env.LOT_REDUCTION_ORDER),
    launcherAddresses: (env.LAUNCHER_ADDRESS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    migrate: bool(env.INDEXER_MIGRATE, true),
    logLevel: env.LOG_LEVEL ?? "info",
  };
}

/**
 * The RPC WebSocket for live ingestion. A SOLANA_WS_URL on another host than SOLANA_RPC_URL is most likely
 * left over (the public endpoint after the RPC moved to a paid provider), so it is replaced by the one
 * derived from the RPC URL (https → wss, same host and key), with a warning.
 */
export function resolveWsUrl(rpcUrl: string, wsUrl: string | null): { url: string; ignored: string | null } {
  const derived = rpcUrl.replace(/^http/, "ws");
  if (!wsUrl) return { url: derived, ignored: null };
  try {
    if (new URL(wsUrl).host !== new URL(rpcUrl).host) return { url: derived, ignored: new URL(wsUrl).host };
  } catch {
    return { url: derived, ignored: "invalid URL" };
  }
  return { url: wsUrl, ignored: null };
}
