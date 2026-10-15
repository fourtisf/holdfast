import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
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
  /** Sweep a coin's platform share to the treasury once it holds this much (lamports), at most every N seconds. */
  platformSweepThresholdLamports: bigint;
  platformSweepEverySecs: number;
  priorityMicroLamports: number;
  routinePriorityMicroLamports: number;
  /** Where the keeper forwards SOL above `reserveLamports` (the platform's revenue when it is the platform treasury). */
  profitWallet: PublicKey | null;
  reserveLamports: bigint;
  payout: PayoutConfig;
}

export interface PayoutConfig {
  minSolLamports: bigint;
  minTokensRaw: bigint;
  rentExemptMinLamports: bigint;
  carryExpiryMs: number;
  maxRecipients: number;
  coinConcurrency: number;
  /** Compute-unit price of payout transactions (not time critical, so cheap by default). */
  priorityMicroLamports: number;
  /** Most a round may spend on fees, relative to what it pays (bps). Rounds above wait for a bigger pot. */
  maxFeeBps: number;
  /** Below this keeper balance no new round is opened (an open round must always be closable). */
  keeperMinBalanceLamports: bigint;
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
    collectEverySecs: int(env, "KEEPER_COLLECT_EVERY_SECS", 600),
    defendSlippageBps: int(env, "KEEPER_DEFEND_SLIPPAGE_BPS", 300),
    curveFeeBpsEstimate: int(env, "KEEPER_CURVE_FEE_BPS_ESTIMATE", 200),
    ammFeeBpsEstimate: int(env, "KEEPER_AMM_FEE_BPS_ESTIMATE", 100),
    defendJitterMs: int(env, "KEEPER_DEFEND_JITTER_MS", 4_000),
    burnThresholdLamports: bigintEnv(env, "KEEPER_BURN_THRESHOLD_LAMPORTS", 100_000_000n),
    burnSlippageBps: int(env, "KEEPER_BURN_SLIPPAGE_BPS", 400),
    burnEverySecs: int(env, "KEEPER_BURN_EVERY_SECS", 3_600),
    platformSweepThresholdLamports: bigintEnv(env, "KEEPER_PLATFORM_SWEEP_LAMPORTS", 10_000_000n),
    platformSweepEverySecs: int(env, "KEEPER_PLATFORM_SWEEP_EVERY_SECS", 3_600),
    priorityMicroLamports: int(env, "KEEPER_PRIORITY_MICROLAMPORTS", 50_000),
    routinePriorityMicroLamports: int(env, "KEEPER_ROUTINE_PRIORITY_MICROLAMPORTS", 10_000),
    profitWallet: env.KEEPER_PROFIT_WALLET ? new PublicKey(env.KEEPER_PROFIT_WALLET) : null,
    reserveLamports: bigintEnv(env, "KEEPER_RESERVE_LAMPORTS", 300_000_000n),
    payout: {
      minSolLamports: bigintEnv(env, "PAYOUT_MIN_SOL_LAMPORTS", 20_000n),
      minTokensRaw: bigintEnv(env, "PAYOUT_MIN_TOKENS_RAW", 1_000n),
      rentExemptMinLamports: RENT_EXEMPT_MIN_LAMPORTS,
      carryExpiryMs: int(env, "PAYOUT_CARRY_EXPIRY_MS", 30 * 24 * 3600 * 1000),
      maxRecipients: int(env, "PAYOUT_MAX_RECIPIENTS", 1_024),
      coinConcurrency: int(env, "PAYOUT_COIN_CONCURRENCY", 4),
      priorityMicroLamports: int(env, "PAYOUT_PRIORITY_MICROLAMPORTS", 1_000),
      maxFeeBps: int(env, "PAYOUT_MAX_FEE_BPS", 200),
      keeperMinBalanceLamports: bigintEnv(env, "KEEPER_MIN_BALANCE_LAMPORTS", 5_000_000n),
    },
  };
}

export function loadKeypair(path: string): Keypair {
  // Relative to where `pnpm … start` ran (INIT_CWD, normally the repo root), like the other services.
  const bytes = JSON.parse(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), path), "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}
