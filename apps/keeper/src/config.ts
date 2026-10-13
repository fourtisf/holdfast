import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { RENT_EXEMPT_MIN_LAMPORTS } from "@holdfast/core";

export interface KeeperConfig {
  databaseUrl: string;
  rpcUrl: string;
  keeperKeypairPath: string;
  /** Crank tick per coin. Must be ≥ the on-chain TWAP min sample interval. */
  tickMs: number;
  coinConcurrency: number;
  /** Claim pump.fun creator fees and run `collect_fees` this often. */
  collectEverySecs: number;
  /** Slippage on top of the venue quote for defend `min_tokens_out` (the on-chain floor cap still applies). */
  defendSlippageBps: number;
  /** Conservative fee assumptions used for off-chain quotes (pump.fun fees are tiered by market cap). */
  curveFeeBpsEstimate: number;
  ammFeeBpsEstimate: number;
  /** Random delay before sending a defend, to make buybacks harder to front-run (spec §7.2). */
  defendJitterMs: number;
  burnThresholdLamports: bigint;
  burnSlippageBps: number;
  burnEverySecs: number;
  priorityMicroLamports: number;
  payout: PayoutConfig;
}

export interface PayoutConfig {
  minSolLamports: bigint;
  minTokensRaw: bigint;
  rentExemptMinLamports: bigint;
  carryExpiryMs: number;
  maxRecipients: number;
  coinConcurrency: number;
  /** Run `collect_fees` right before computing each round so the pot is fresh. */
  collectBeforeRound: boolean;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return n;
}

function bigintEnv(env: NodeJS.ProcessEnv, key: string, fallback: bigint): bigint {
  const v = env[key];
  return v === undefined || v === "" ? fallback : BigInt(v);
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is required`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    rpcUrl: required(env, "SOLANA_RPC_URL"),
    keeperKeypairPath: required(env, "KEEPER_KEYPAIR"),
    tickMs: int(env, "KEEPER_TICK_MS", 30_000),
    coinConcurrency: int(env, "KEEPER_COIN_CONCURRENCY", 8),
    collectEverySecs: int(env, "KEEPER_COLLECT_EVERY_SECS", 120),
    defendSlippageBps: int(env, "KEEPER_DEFEND_SLIPPAGE_BPS", 300),
    curveFeeBpsEstimate: int(env, "KEEPER_CURVE_FEE_BPS_ESTIMATE", 200),
    ammFeeBpsEstimate: int(env, "KEEPER_AMM_FEE_BPS_ESTIMATE", 100),
    defendJitterMs: int(env, "KEEPER_DEFEND_JITTER_MS", 4_000),
    burnThresholdLamports: bigintEnv(env, "KEEPER_BURN_THRESHOLD_LAMPORTS", 100_000_000n),
    burnSlippageBps: int(env, "KEEPER_BURN_SLIPPAGE_BPS", 400),
    burnEverySecs: int(env, "KEEPER_BURN_EVERY_SECS", 3_600),
    priorityMicroLamports: int(env, "KEEPER_PRIORITY_MICROLAMPORTS", 50_000),
    payout: {
      minSolLamports: bigintEnv(env, "PAYOUT_MIN_SOL_LAMPORTS", 20_000n),
      minTokensRaw: bigintEnv(env, "PAYOUT_MIN_TOKENS_RAW", 1_000n),
      rentExemptMinLamports: RENT_EXEMPT_MIN_LAMPORTS,
      carryExpiryMs: int(env, "PAYOUT_CARRY_EXPIRY_MS", 30 * 24 * 3600 * 1000),
      maxRecipients: int(env, "PAYOUT_MAX_RECIPIENTS", 1_024),
      coinConcurrency: int(env, "PAYOUT_COIN_CONCURRENCY", 4),
      collectBeforeRound: (env.PAYOUT_COLLECT_BEFORE_ROUND ?? "true") !== "false",
    },
  };
}

export function loadKeypair(path: string): Keypair {
  const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}
