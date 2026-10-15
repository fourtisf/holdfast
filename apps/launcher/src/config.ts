/** Environment configuration (root .env.example). Secrets are loaded here and never logged. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { HOLDFAST_PROGRAM_ID, launchPlanFromEnv, parseMasterSecret } from "@holdfast/chain";
import { DEFAULT_MODERATION_LISTS, parseBlocklist, withExtraBlocked } from "@holdfast/core";

import { assertUriFits, normalizeBaseUrl } from "./metadata.js";
import { LocalMetadataStorage, PinataMetadataStorage, type MetadataStorage } from "./storage.js";
import { DEFAULT_SETTINGS, type LauncherSettings } from "./worker.js";

export interface LauncherConfig {
  databaseUrl: string;
  rpcUrl: string;
  holdfastProgramId: string;
  pollIntervalMs: number;
  migrate: boolean;
  logLevel: string;
  settings: LauncherSettings;
  storage: MetadataStorage;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
}

function int(name: string, v: string | undefined, fallback: number, min = 0): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be an integer ≥ ${min}, got ${v}`);
  return n;
}

/** Relative .env paths resolve against pnpm's INIT_CWD (where `pnpm … start` ran), else the cwd. */
export function resolveFromLaunchDir(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.INIT_CWD ?? process.cwd(), path);
}

/** Solana CLI keypair: a JSON array of 64 numbers, inline or in a file. */
export function loadKeypair(source: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): Keypair {
  const text = source.trim().startsWith("[") ? source : read(resolveFromLaunchDir(source));
  let bytes: unknown;
  try {
    bytes = JSON.parse(text);
  } catch {
    throw new Error("LAUNCHER_KEYPAIR is not a JSON keypair file");
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new Error("LAUNCHER_KEYPAIR must hold a 64-byte secret key (JSON array)");
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, read?: (path: string) => string): LauncherConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!env.DEPOSIT_MASTER_SECRET) throw new Error("DEPOSIT_MASTER_SECRET is required");
  if (!env.LAUNCHER_KEYPAIR) throw new Error("LAUNCHER_KEYPAIR is required");
  if (env.HOLDFAST_PROGRAM_ID && env.HOLDFAST_PROGRAM_ID !== HOLDFAST_PROGRAM_ID.toBase58()) {
    throw new Error(`HOLDFAST_PROGRAM_ID changed after @holdfast/chain was loaded (${HOLDFAST_PROGRAM_ID.toBase58()})`);
  }

  const store = env.METADATA_STORE ?? "./data/metadata";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(store)) throw new Error("METADATA_STORE must be a local directory (bucket URLs are not supported by the launcher)");
  const publicBaseUrl = normalizeBaseUrl(env.PUBLIC_METADATA_BASE_URL ?? "http://localhost:4000/metadata");
  assertUriFits(publicBaseUrl);
  const siteUrl = (env.PUBLIC_SITE_URL ?? new URL(publicBaseUrl).origin).replace(/\/+$/, "");
  // Same parser as the API's quotes, so the launcher waits for exactly what users were asked to send.
  const plan = launchPlanFromEnv(env, { publicMetadataBaseUrl: publicBaseUrl });
  let lookupTable: PublicKey | null = null;
  if (env.LAUNCHER_LOOKUP_TABLE) {
    try {
      lookupTable = new PublicKey(env.LAUNCHER_LOOKUP_TABLE);
    } catch {
      throw new Error("LAUNCHER_LOOKUP_TABLE is not a valid address");
    }
  }

  const settings: LauncherSettings = {
    ...DEFAULT_SETTINGS,
    masterSecret: parseMasterSecret(env.DEPOSIT_MASTER_SECRET),
    launcher: loadKeypair(env.LAUNCHER_KEYPAIR, read),
    metadata: { storeDir: resolveFromLaunchDir(store, env), publicBaseUrl, siteUrl },
    metadataLocation: plan.metadata,
    lookupTable,
    atomicAttempts: int("LAUNCHER_ATOMIC_ATTEMPTS", env.LAUNCHER_ATOMIC_ATTEMPTS, DEFAULT_SETTINGS.atomicAttempts),
    moderation: env.MODERATION_BLOCKLIST_FILE
      ? withExtraBlocked(DEFAULT_MODERATION_LISTS, parseBlocklist((read ?? ((p: string) => readFileSync(p, "utf8")))(resolveFromLaunchDir(env.MODERATION_BLOCKLIST_FILE, env))))
      : DEFAULT_MODERATION_LISTS,
    priority: plan.priority,
    walletPriorityMicroLamports: BigInt(int("LAUNCHER_WALLET_PRIORITY_MICROLAMPORTS", env.LAUNCHER_WALLET_PRIORITY_MICROLAMPORTS, Number(DEFAULT_SETTINGS.walletPriorityMicroLamports))),
    devBuySlippageBps: plan.devBuySlippageBps,
    closeDepositAccumulator: plan.closeDepositAccumulator,
    maxAttempts: int("LAUNCHER_MAX_ATTEMPTS", env.LAUNCHER_MAX_ATTEMPTS, DEFAULT_SETTINGS.maxAttempts, 1),
    retryBaseMs: int("LAUNCHER_RETRY_BASE_MS", env.LAUNCHER_RETRY_BASE_MS, DEFAULT_SETTINGS.retryBaseMs),
    inFlightGuardMs: int("LAUNCHER_IN_FLIGHT_GUARD_MS", env.LAUNCHER_IN_FLIGHT_GUARD_MS, DEFAULT_SETTINGS.inFlightGuardMs),
  };

  let storage: MetadataStorage;
  if (plan.metadata.kind === "pinata") {
    if (!env.PINATA_JWT) throw new Error("METADATA_STORAGE=pinata needs PINATA_JWT");
    storage = new PinataMetadataStorage(settings.metadata, { jwt: env.PINATA_JWT, gatewayUrl: plan.metadata.gatewayUrl });
  } else {
    storage = new LocalMetadataStorage(settings.metadata);
  }

  return {
    databaseUrl,
    rpcUrl: env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    holdfastProgramId: HOLDFAST_PROGRAM_ID.toBase58(),
    pollIntervalMs: int("LAUNCHER_POLL_INTERVAL_MS", env.LAUNCHER_POLL_INTERVAL_MS, 3_000, 100),
    migrate: bool(env.LAUNCHER_MIGRATE, true),
    logLevel: env.LOG_LEVEL ?? "info",
    settings,
    storage,
  };
}

/** RPC URLs often carry an API key in the query string or path. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.length > 1 ? "/…" : ""}`;
  } catch {
    return "<invalid url>";
  }
}
