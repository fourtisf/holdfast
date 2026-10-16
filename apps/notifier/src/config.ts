/** Environment configuration (root .env.example, "telegram notifier" section). The bot token is never logged. */
import { isAbsolute, resolve } from "node:path";

import { PRIVATE_REPLIES_PER_MINUTE, PRIVATE_REPLY_BURST } from "./bot.js";
import type { Cluster } from "./format.js";

export interface NotifierConfig {
  botToken: string;
  /** Bot API base URL; a self-hosted Bot API server can stand in for api.telegram.org. */
  telegramApiUrl: string;
  databaseUrl: string;
  /** Web app origin for coin links, without a trailing slash. */
  webUrl: string;
  /** The API the bot launches and reads through (inside compose: http://api:4000). */
  apiUrl: string;
  /**
   * INTERNAL_API_TOKEN, also set on the API: launch calls then carry it with the Telegram user's id and
   * are rate limited per user instead of all sharing the notifier's IP. Null: unset.
   */
  internalApiToken: string | null;
  /** Channel or group that gets every $MOATPAD burn (e.g. -1001234567890); null = none. */
  burnChatId: number | null;
  /** The official $MOATPAD mint, linked from /burns. */
  moatCa: string;
  /** Explorer links (Solscan) point at this cluster. */
  cluster: Cluster;
  /** /healthz + /metrics; 0 disables. */
  opsPort: number;
  milestoneIntervalMs: number;
  /** getUpdates long-poll timeout. */
  pollTimeoutSec: number;
  /**
   * Reply budget of one private chat: replies a minute, and at most `burst` within any 3 seconds
   * (NOTIFIER_PRIVATE_REPLIES_PER_MINUTE, NOTIFIER_PRIVATE_REPLY_BURST). The defaults stay well under Telegram's
   * limit of about one message a second per chat.
   */
  privateReplies: { perMinute: number; burst: number };
  /** On startup and after a database reconnect, re-check rounds, defences, graduations, bot launches, burns and fresh buys of this window. */
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

/** Optional shared secret with the API; when set, at least 24 characters (`openssl rand -hex 32`). */
function internalToken(env: NodeJS.ProcessEnv): string | null {
  const v = (env.INTERNAL_API_TOKEN ?? "").trim();
  if (v === "") return null;
  if (v.length < 24) throw new Error("INTERNAL_API_TOKEN must be at least 24 characters (generate one with: openssl rand -hex 32)");
  return v;
}

/** A Telegram chat id (channels and supergroups are negative). */
function chatId(env: NodeJS.ProcessEnv, key: string): number | null {
  const v = (env[key] ?? "").trim();
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n === 0) throw new Error(`${key} must be a Telegram chat id like -1001234567890, got ${v}`);
  return n;
}

/**
 * TELEGRAM_API_URL: an absolute http(s) URL. Anything else would make every request URL unparsable, and
 * Node's fetch error repeats the whole URL, bot token included. The value itself is not echoed either.
 */
function telegramApiUrl(env: NodeJS.ProcessEnv): string {
  const v = (env.TELEGRAM_API_URL || "https://api.telegram.org").trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error("TELEGRAM_API_URL must be an absolute http(s) URL, like http://127.0.0.1:8081");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("TELEGRAM_API_URL must be an absolute http(s) URL, like http://127.0.0.1:8081");
  return v;
}

/**
 * The bot the website's Telegram links open (NEXT_PUBLIC_TELEGRAM_BOT, same .env) when it is not `actual`
 * (this bot, from getMe); null when it matches or is not set.
 */
export function botUsernameMismatch(env: NodeJS.ProcessEnv, actual: string | undefined): string | null {
  const expected = (env.NEXT_PUBLIC_TELEGRAM_BOT ?? "").trim().replace(/^@/, "");
  if (!expected || !actual) return null;
  return expected.toLowerCase() === actual.toLowerCase() ? null : expected;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NotifierConfig {
  const botToken = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required (create a bot with @BotFather)");
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error("TELEGRAM_BOT_TOKEN does not look like a bot token (<id>:<secret>)");
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return {
    botToken,
    telegramApiUrl: telegramApiUrl(env),
    databaseUrl: resolveDatabaseUrl(databaseUrl, env),
    webUrl: webUrl(env),
    apiUrl: (env.API_INTERNAL_URL || env.NEXT_PUBLIC_API_URL || "http://localhost:4000").trim().replace(/\/+$/, ""),
    internalApiToken: internalToken(env),
    burnChatId: chatId(env, "NOTIFIER_BURN_CHAT_ID"),
    moatCa: (env.MOAT_CA || env.NEXT_PUBLIC_MOAT_CA || "4qLdhoVDiAkXVXqU4D3rSPp6pMMnJzRJr38do55Hpump").trim(),
    cluster: cluster(env),
    opsPort: opsPort(env, "NOTIFIER_OPS_PORT", 9104),
    milestoneIntervalMs: int(env, "NOTIFIER_MILESTONE_INTERVAL_MS", 10 * 60_000, 1_000),
    pollTimeoutSec: int(env, "NOTIFIER_POLL_TIMEOUT_SECS", 30, 1),
    privateReplies: {
      perMinute: int(env, "NOTIFIER_PRIVATE_REPLIES_PER_MINUTE", PRIVATE_REPLIES_PER_MINUTE, 1),
      burst: int(env, "NOTIFIER_PRIVATE_REPLY_BURST", PRIVATE_REPLY_BURST, 1),
    },
    catchUpMs: int(env, "NOTIFIER_CATCHUP_MS", 15 * 60_000),
    migrate: env.NOTIFIER_MIGRATE !== "0",
    logLevel: env.LOG_LEVEL || "info",
  };
}
