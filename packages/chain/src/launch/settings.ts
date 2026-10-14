/**
 * Launch settings shared by the API (quotes) and the launcher (what it waits for), read from the
 * same environment variables so both always agree on the price of a launch.
 */
import { DEFAULT_COMPUTE_UNITS, DEFAULT_PRIORITY, type LaunchCostOptions, type LaunchMode, type PriorityConfig } from "./cost.js";
import { PUMP_MAX_URI_BYTES, utf8Len } from "./sizes.js";

/** Where the pump.fun metadata JSON (and the image it points at) is stored. */
export type MetadataStorageKind = "local" | "pinata";

/** CIDv1 base32 (`bafy…`): what we pin with, so every metadata URI has the same length. */
export const IPFS_CID_V1_LENGTH = 59;

export interface MetadataLocation {
  kind: MetadataStorageKind;
  /** local: base URL the API serves METADATA_STORE under, e.g. https://api.holdfast.fun/metadata */
  publicBaseUrl: string;
  /** pinata: public IPFS gateway used in URIs, e.g. https://ipfs.io */
  gatewayUrl: string;
}

export const DEFAULT_IPFS_GATEWAY = "https://ipfs.io";

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/** Byte length of every metadata URI the launcher generates for `loc`. */
export function metadataUriBytes(loc: MetadataLocation): number {
  // local: `<base>/<sha256 hex>.json`; ipfs: `<gateway>/ipfs/<cid v1>`
  return loc.kind === "local" ? utf8Len(trimSlash(loc.publicBaseUrl)) + 1 + 64 + 5 : utf8Len(trimSlash(loc.gatewayUrl)) + "/ipfs/".length + IPFS_CID_V1_LENGTH;
}

export interface LaunchPlan {
  mode: LaunchMode;
  metadata: MetadataLocation;
  priority: PriorityConfig;
  devBuySlippageBps: number;
  closeDepositAccumulator: boolean;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
}

function int(name: string, v: string | undefined, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in [${min}, ${max}], got ${v}`);
  return n;
}

/**
 * METADATA_STORAGE (local | pinata), PUBLIC_METADATA_BASE_URL, IPFS_GATEWAY_URL,
 * LAUNCHER_LOOKUP_TABLE (set → atomic launches), LAUNCHER_PRIORITY_FEE_MICROLAMPORTS,
 * LAUNCHER_DEV_BUY_SLIPPAGE_BPS, LAUNCHER_CLOSE_DEPOSIT_ACCUMULATOR.
 */
export function launchPlanFromEnv(env: Record<string, string | undefined>, defaults: { publicMetadataBaseUrl: string }): LaunchPlan {
  const kind = (env.METADATA_STORAGE ?? "local").toLowerCase();
  if (kind !== "local" && kind !== "pinata") throw new Error(`METADATA_STORAGE must be "local" or "pinata", got ${env.METADATA_STORAGE}`);
  const metadata: MetadataLocation = {
    kind,
    publicBaseUrl: trimSlash(env.PUBLIC_METADATA_BASE_URL ?? defaults.publicMetadataBaseUrl),
    gatewayUrl: trimSlash(env.IPFS_GATEWAY_URL ?? DEFAULT_IPFS_GATEWAY),
  };
  const uriBytes = metadataUriBytes(metadata);
  if (uriBytes > PUMP_MAX_URI_BYTES) throw new Error(`metadata URIs would be ${uriBytes} bytes (pump.fun max ${PUMP_MAX_URI_BYTES}); shorten the base URL`);
  return {
    mode: env.LAUNCHER_LOOKUP_TABLE ? "atomic" : "split",
    metadata,
    priority: {
      microLamports: BigInt(int("LAUNCHER_PRIORITY_FEE_MICROLAMPORTS", env.LAUNCHER_PRIORITY_FEE_MICROLAMPORTS, Number(DEFAULT_PRIORITY.microLamports))),
      units: DEFAULT_COMPUTE_UNITS,
    },
    devBuySlippageBps: int("LAUNCHER_DEV_BUY_SLIPPAGE_BPS", env.LAUNCHER_DEV_BUY_SLIPPAGE_BPS, 500, 0, 5_000),
    closeDepositAccumulator: bool(env.LAUNCHER_CLOSE_DEPOSIT_ACCUMULATOR, true),
  };
}

/** `computeLaunchCost` options for a plan and one launch's name / ticker byte lengths. */
export function launchCostOptions(plan: LaunchPlan, launch: { nameBytes: number; symbolBytes: number; devBuyLamports: bigint }): LaunchCostOptions {
  return {
    mode: plan.mode,
    nameBytes: launch.nameBytes,
    symbolBytes: launch.symbolBytes,
    uriBytes: metadataUriBytes(plan.metadata),
    priority: plan.priority,
    devBuyLamports: launch.devBuyLamports,
    closeDepositAccumulator: plan.closeDepositAccumulator,
    devBuySlippageBps: plan.devBuySlippageBps,
  };
}
