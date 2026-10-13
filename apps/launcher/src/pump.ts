/**
 * pump.fun SDK access. `@pump-fun/pump-sdk` is loaded through `require` (same reason as
 * `@holdfast/chain` pump/idl.ts: its ESM build imports named exports from CommonJS anchor, which
 * Node's ESM loader rejects); the types come from the package's declarations.
 */
import { createRequire } from "node:module";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import BN from "bn.js";
import type * as PumpSdkModule from "@pump-fun/pump-sdk";
import { associatedTokenAddress } from "@holdfast/chain";
import type { BondingCurve, FeeConfig, Global } from "@pump-fun/pump-sdk";

import type { LaunchChain } from "./chain.js";

const require = createRequire(import.meta.url);
export const pump = require("@pump-fun/pump-sdk") as typeof PumpSdkModule;
export const PUMP_SDK = pump.PUMP_SDK;

export type { BondingCurve, FeeConfig, Global };

/** Offline anchor program (no RPC is ever made through it): used for its coder only. */
let offlineProgram: ReturnType<typeof pump.getPumpProgram> | null = null;
export function pumpProgram(): ReturnType<typeof pump.getPumpProgram> {
  offlineProgram ??= pump.getPumpProgram(new Connection("http://127.0.0.1:1"));
  return offlineProgram;
}

/** `discriminator ‖ borsh(value)` for a pump account (camelCase field names, as the SDK decodes them). */
export function encodePumpAccount(name: "global" | "feeConfig" | "bondingCurve" | "userVolumeAccumulator", value: unknown): Buffer {
  const layouts = (pumpProgram().coder.accounts as unknown as {
    accountLayouts: Map<string, { discriminator: number[]; layout: { encode(v: unknown, b: Buffer): number } }>;
  }).accountLayouts;
  const entry = layouts.get(name);
  if (!entry) throw new Error(`pump IDL has no account ${name}`);
  const buf = Buffer.alloc(8192);
  const len = entry.layout.encode(value, buf);
  return Buffer.concat([Buffer.from(entry.discriminator), buf.subarray(0, len)]);
}

function asInfo(data: Buffer, owner: PublicKey): AccountInfo<Buffer> {
  return { data, owner, lamports: 0, executable: false };
}

/** Everything the dev-buy quote needs, read fresh right before tx C is built. */
export interface PumpBuyState {
  global: Global;
  feeConfig: FeeConfig;
  bondingCurve: BondingCurve;
  mintSupply: BN;
  /** Balance of the curve's base token account (prices a buy that would cross into the pool-to-be). */
  curveBaseTokenBalance: BN;
}

export async function readPumpBuyState(chain: LaunchChain, mint: PublicKey, tokenProgram: PublicKey): Promise<PumpBuyState> {
  const curveKey = pump.bondingCurvePda(mint);
  const curveAta = associatedTokenAddress(curveKey, mint, tokenProgram);
  const [global, feeConfig, curve, mintInfo, curveToken] = await Promise.all([
    chain.getAccountInfo(pump.GLOBAL_PDA),
    chain.getAccountInfo(pump.PUMP_FEE_CONFIG_PDA),
    chain.getAccountInfo(curveKey),
    chain.getAccountInfo(mint),
    chain.getAccountInfo(curveAta),
  ]);
  if (!global) throw new Error("pump Global account not found");
  if (!feeConfig) throw new Error("pump FeeConfig account not found");
  if (!curve) throw new Error(`bonding curve of ${mint.toBase58()} not found`);
  if (!mintInfo || mintInfo.data.length < 82) throw new Error(`mint ${mint.toBase58()} not found`);
  if (!curveToken || curveToken.data.length < 72) throw new Error(`curve token account of ${mint.toBase58()} not found`);
  return {
    global: PUMP_SDK.decodeGlobal(asInfo(global.data, pump.PUMP_PROGRAM_ID)),
    feeConfig: PUMP_SDK.decodeFeeConfig(asInfo(feeConfig.data, pump.PUMP_FEE_PROGRAM_ID)),
    bondingCurve: PUMP_SDK.decodeBondingCurve(asInfo(curve.data, pump.PUMP_PROGRAM_ID)),
    mintSupply: new BN(mintInfo.data.readBigUInt64LE(36).toString()),
    curveBaseTokenBalance: new BN(curveToken.data.readBigUInt64LE(64).toString()),
  };
}

export interface DevBuyQuote {
  /** Exact token amount bought (and transferred on to the sender). */
  tokens: bigint;
  /** SOL the buy costs at the quoted state, fees included. */
  cost: bigint;
  /** `max_sol_cost` sent: cost + slippage, capped by what the deposit can spend. */
  maxSolCost: bigint;
}

/**
 * Quote a `buy_v3` that spends about `spend` lamports: tokens = what `spend` buys (exact-in quote),
 * cost = what those tokens cost (exact-out quote, ≤ spend), max = cost × (1 + slippage) ≤ `budget`.
 */
export function quoteDevBuy(state: PumpBuyState, spend: bigint, budget: bigint, slippageBps: number): DevBuyQuote {
  const common = {
    global: state.global,
    feeConfig: state.feeConfig,
    mintSupply: state.mintSupply,
    bondingCurve: state.bondingCurve,
    curveBaseTokenBalance: state.curveBaseTokenBalance,
  };
  if (state.bondingCurve.complete) throw new Error("bonding curve is complete");
  const tokens = BigInt(pump.getBuyV3TokenAmountFromQuoteAmount({ ...common, amount: new BN(spend.toString()) }).toString());
  if (tokens <= 0n) throw new Error(`dev buy of ${spend} lamports buys no tokens`);
  const cost = BigInt(pump.getBuyV3QuoteAmountFromTokenAmount({ ...common, amount: new BN(tokens.toString()) }).toString());
  const withSlippage = (cost * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
  const maxSolCost = withSlippage < budget ? withSlippage : budget;
  if (maxSolCost < cost) throw new Error(`deposit cannot cover the dev buy (cost ${cost}, budget ${budget})`);
  return { tokens, cost, maxSolCost };
}
