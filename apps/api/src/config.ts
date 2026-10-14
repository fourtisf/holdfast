import { resolve } from "node:path";
import { launchPlanFromEnv, type LaunchPlan } from "@holdfast/chain";

export interface ApiConfig {
  databaseUrl: string;
  port: number;
  host: string;
  rpcUrl: string;
  /** `*` or a comma-separated list of origins. */
  corsOrigin: string;
  metadataDir: string;
  publicMetadataBaseUrl: string;
  /** Requests per minute per IP; 0 disables rate limiting. */
  rateLimitPerMinute: number;
  statsIntervalMs: number;
  wsHeartbeatMs: number;
  launchTtlMs: number;
  /** Parsed from the launcher's own variables, so quotes match what it charges. */
  launchPlan: LaunchPlan;
  depositMasterSecret: string | null;
  trade: {
    computeUnitPriceMicroLamports: number;
    computeUnitLimitCurve: number;
    computeUnitLimitAmm: number;
  };
  logLevel: string;
  production: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const port = Number(env.API_PORT ?? env.PORT ?? 4000);
  const publicMetadataBaseUrl = (env.PUBLIC_METADATA_BASE_URL ?? `http://localhost:${port}/metadata`).replace(/\/+$/, "");
  return {
    databaseUrl: env.DATABASE_URL ?? "",
    port,
    host: env.API_HOST ?? "0.0.0.0",
    rpcUrl: env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    corsOrigin: env.CORS_ORIGIN ?? "http://localhost:3000",
    metadataDir: resolve(env.METADATA_STORE ?? "./data/metadata"),
    publicMetadataBaseUrl,
    rateLimitPerMinute: Number(env.API_RATE_LIMIT_PER_MINUTE ?? 600),
    statsIntervalMs: Number(env.API_STATS_INTERVAL_MS ?? 10_000),
    wsHeartbeatMs: Number(env.API_WS_HEARTBEAT_MS ?? 30_000),
    launchTtlMs: Number(env.LAUNCH_TTL_MS ?? 30 * 60_000),
    launchPlan: launchPlanFromEnv(env, { publicMetadataBaseUrl }),
    depositMasterSecret: env.DEPOSIT_MASTER_SECRET || null,
    trade: {
      computeUnitPriceMicroLamports: Number(env.TRADE_CU_PRICE_MICROLAMPORTS ?? 100_000),
      computeUnitLimitCurve: Number(env.TRADE_CU_LIMIT_CURVE ?? 250_000),
      computeUnitLimitAmm: Number(env.TRADE_CU_LIMIT_AMM ?? 300_000),
    },
    logLevel: env.LOG_LEVEL ?? "info",
    production: env.NODE_ENV === "production",
  };
}
