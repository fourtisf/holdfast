import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchPlanFromEnv, type LaunchPlan } from "@holdfast/chain";
import { DEFAULT_MODERATION_LISTS, parseBlocklist, withExtraBlocked, type ModerationLists } from "@holdfast/core";

export interface ModerationConfig {
  lists: ModerationLists;
  /** Optional image classifier: POST image bytes, answers `{ "flagged": boolean }`. */
  imageWebhookUrl: string | null;
  /** Reject uploads when the classifier is unreachable (default: accept and log). */
  imageFailClosed: boolean;
  /** Distinct open reports that hide a coin until an admin looks (0 = never automatically). */
  autoHideReports: number;
  /** Salt of the reporter IP hash. */
  reportSalt: string;
}

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
  /** LAUNCHES_PAUSED: refuse new launches (no deposit addresses) until the launcher is live. */
  launchesPaused: boolean;
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
  /** Bearer token for /admin/*; null disables the admin API. */
  adminToken: string | null;
  moderation: ModerationConfig;
}

/**
 * Relative paths in .env are relative to where the services are started from: pnpm's INIT_CWD (the
 * directory `pnpm --filter … start` ran in, normally the repo root), else the process cwd.
 */
export function resolveFromLaunchDir(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.INIT_CWD ?? process.cwd(), path);
}

/** MODERATION_BLOCKLIST_FILE adds terms to the built-in list (one per line, # comments). */
export function moderationListsFromEnv(env: NodeJS.ProcessEnv, read: (path: string) => string = (p) => readFileSync(p, "utf8")): ModerationLists {
  const file = env.MODERATION_BLOCKLIST_FILE;
  return file ? withExtraBlocked(DEFAULT_MODERATION_LISTS, parseBlocklist(read(resolveFromLaunchDir(file, env)))) : DEFAULT_MODERATION_LISTS;
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
    metadataDir: resolveFromLaunchDir(env.METADATA_STORE ?? "./data/metadata", env),
    publicMetadataBaseUrl,
    rateLimitPerMinute: Number(env.API_RATE_LIMIT_PER_MINUTE ?? 600),
    statsIntervalMs: Number(env.API_STATS_INTERVAL_MS ?? 10_000),
    wsHeartbeatMs: Number(env.API_WS_HEARTBEAT_MS ?? 30_000),
    launchTtlMs: Number(env.LAUNCH_TTL_MS ?? 30 * 60_000),
    launchesPaused: env.LAUNCHES_PAUSED === "true" || env.LAUNCHES_PAUSED === "1",
    launchPlan: launchPlanFromEnv(env, { publicMetadataBaseUrl }),
    depositMasterSecret: env.DEPOSIT_MASTER_SECRET || null,
    trade: {
      computeUnitPriceMicroLamports: Number(env.TRADE_CU_PRICE_MICROLAMPORTS ?? 100_000),
      computeUnitLimitCurve: Number(env.TRADE_CU_LIMIT_CURVE ?? 250_000),
      computeUnitLimitAmm: Number(env.TRADE_CU_LIMIT_AMM ?? 300_000),
    },
    logLevel: env.LOG_LEVEL ?? "info",
    production: env.NODE_ENV === "production",
    adminToken: env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 24 ? env.ADMIN_TOKEN : null,
    moderation: {
      lists: moderationListsFromEnv(env),
      imageWebhookUrl: env.MODERATION_IMAGE_WEBHOOK_URL || null,
      imageFailClosed: env.MODERATION_IMAGE_FAIL_CLOSED === "true",
      autoHideReports: Number(env.MODERATION_AUTO_HIDE_REPORTS ?? 0),
      reportSalt: env.REPORT_SALT ?? env.DEPOSIT_MASTER_SECRET ?? "holdfast-reports",
    },
  };
}
