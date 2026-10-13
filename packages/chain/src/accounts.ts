/**
 * Raw decoders for pump.fun accounts, mirroring programs/holdfast-vault/src/venue.rs byte for byte so
 * off-chain services read prices exactly the way the vault program does.
 */
import { PublicKey } from "@solana/web3.js";
import { curvePriceFixed, poolPriceFixed } from "@holdfast/core";

import { WSOL_MINT } from "./constants.js";

const BONDING_CURVE_DISCRIMINATOR = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);
const POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);

export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: PublicKey;
  /** Quoted in SOL (legacy accounts without a quote mint, the zero key, or WSOL). */
  solQuoted: boolean;
}

export function decodeBondingCurve(data: Buffer): BondingCurveState {
  if (data.length < 81 || !data.subarray(0, 8).equals(BONDING_CURVE_DISCRIMINATOR)) throw new Error("not a pump BondingCurve");
  const quote = data.length >= 115 ? data.subarray(83, 115) : null;
  return {
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualQuoteReserves: data.readBigUInt64LE(16),
    realTokenReserves: data.readBigUInt64LE(24),
    realQuoteReserves: data.readBigUInt64LE(32),
    tokenTotalSupply: data.readBigUInt64LE(40),
    complete: data[48] !== 0,
    creator: new PublicKey(data.subarray(49, 81)),
    solQuoted: !quote || quote.every((b) => b === 0) || quote.equals(WSOL_MINT.toBuffer()),
  };
}

export function bondingCurveSpot(curve: BondingCurveState): bigint {
  return curvePriceFixed(curve.virtualQuoteReserves, curve.virtualTokenReserves);
}

export interface PoolState {
  index: number;
  creator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  coinCreator: PublicKey;
  /** Signed; effective quote reserves = quote vault balance + this. */
  virtualQuoteReserves: bigint;
}

function readI128LE(data: Buffer, offset: number): bigint {
  const lo = data.readBigUInt64LE(offset);
  const hi = data.readBigInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

export function decodePool(data: Buffer): PoolState {
  if (data.length < 243 || !data.subarray(0, 8).equals(POOL_DISCRIMINATOR)) throw new Error("not a PumpSwap Pool");
  return {
    index: data.readUInt16LE(9),
    creator: new PublicKey(data.subarray(11, 43)),
    baseMint: new PublicKey(data.subarray(43, 75)),
    quoteMint: new PublicKey(data.subarray(75, 107)),
    poolBaseTokenAccount: new PublicKey(data.subarray(139, 171)),
    poolQuoteTokenAccount: new PublicKey(data.subarray(171, 203)),
    coinCreator: new PublicKey(data.subarray(211, 243)),
    virtualQuoteReserves: data.length >= 261 ? readI128LE(data, 245) : 0n,
  };
}

export function poolSpot(pool: PoolState, baseAmount: bigint, quoteAmount: bigint): bigint {
  return poolPriceFixed(quoteAmount, pool.virtualQuoteReserves, baseAmount);
}

export interface TokenAccountState {
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
  initialized: boolean;
}

/** SPL Token / Token-2022 base layout. */
export function decodeTokenAccount(data: Buffer): TokenAccountState {
  if (data.length < 165) throw new Error("not a token account");
  return {
    mint: new PublicKey(data.subarray(0, 32)),
    owner: new PublicKey(data.subarray(32, 64)),
    amount: data.readBigUInt64LE(64),
    initialized: data[108] === 1,
  };
}

export function decodeMintSupply(data: Buffer): { supply: bigint; decimals: number } {
  if (data.length < 82) throw new Error("not a mint");
  return { supply: data.readBigUInt64LE(36), decimals: data[44]! };
}
