/** Environment configuration (root .env.example, "telegram notifier" section). The bot token is never logged. */
import { isAbsolute, resolve } from "node:path";

import type { Cluster } from "./format.js";

export interface NotifierConfig {
  botToken: string;
  /** Bot API base URL; a self-hosted Bot API server can stand in for api.telegram.org. */
  telegramApiUrl: string;
  databaseUrl: string;
  /** Web app origin for coin links, without a trailing slash. */
  webUrl: string;
  /** Explorer links (Solscan) point at this cluster. */
  cluster: Cluster;
  /** /healthz + /metrics; 0 disables. */
  opsPort: number;
  milestoneIntervalMs: number;
  /** getUpdates long-poll timeout. */
  pollTimeoutSec: number;
  /** On startup, re-check rounds, defences and graduations of this window (missed while down). */
  catchUpMs: number;
  /** Run the migrations at startup (NOTIFIER_MIGRATE=0 skips them). */
  migrate: boolean;
  logLevel: string;
}

const CLUSTERS: readonly Cluster[] = ["mainnet-beta", "devnet", "testnet", "localnet"];

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 0): number {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${key} must be an integer ≥ ${min}, got ${v}`);
  return n;
}

/** `NOTIFIER_OPS_PORT=9104` style settings; "0" disables the ops server. */
export function opsPort(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const n = int(env, key, fallback);
  if (n > 65_535) throw new Error(`${key} must be a port number (0 disables)`);
  return n;
}

/** Relative paths resolve against pnpm's INIT_CWD (where `pnpm … start` ran), else the cwd, like the other services. */
export function resolveFromLaunchDir(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.INIT_CWD ?? process.cwd(), path);
}

/** `pglite://./data/pg` → an absolute PGlite directory; other URLs are returned unchanged. */
export function resolveDatabaseUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!url.startsWith("pglite:")) return url;
  const dir = url.replace(/^pglite:(\/\/)?/, "");
  if (dir === "" || dir === "memory" || isAbsolute(dir)) return url;
  return `pglite://${resolveFromLaunchDir(dir, env)}`;
}

function cluster(env: NodeJS.ProcessEnv): Cluster {
  const v = (env.SOLANA_CLUSTER ?? "").trim();
  if (v === "") return "mainnet-beta";
  if (v === "mainnet") return "mainnet-beta";
  if (!(CLUSTERS as readonly string[]).includes(v)) throw new Error(`SOLANA_CLUSTER must be one of ${CLUSTERS.join(", ")}, got ${v}`);
  return v as Cluster;
}

function webUrl(env: NodeJS.ProcessEnv): string {
  const v = (env.WEB_URL || env.PUBLIC_SITE_URL || "http://localhost:3000").trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error(`WEB_URL must be an absolute http(s) URL, got ${v}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`WEB_URL must be an absolute http(s) URL, got ${v}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NotifierConfig {
  const botToken = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required (create a bot with @BotFather)");
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error("TELEGRAM_BOT_TOKEN does not look like a bot token (<id>:<secret>)");
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return {
    botToken,
    telegramApiUrl: (env.TELEGRAM_API_URL || "https://api.telegram.org").replace(/\/+$/, ""),
    databaseUrl: resolveDatabaseUrl(databaseUrl, env),
    webUrl: webUrl(env),
    cluster: cluster(env),
    opsPort: opsPort(env, "NOTIFIER_OPS_PORT", 9104),
    milestoneIntervalMs: int(env, "NOTIFIER_MILESTONE_INTERVAL_MS", 10 * 60_000, 1_000),
    pollTimeoutSec: int(env, "NOTIFIER_POLL_TIMEOUT_SECS", 30, 1),
    catchUpMs: int(env, "NOTIFIER_CATCHUP_MS", 15 * 60_000),
    migrate: env.NOTIFIER_MIGRATE !== "0",
    logLevel: env.LOG_LEVEL || "info",
  };
}
