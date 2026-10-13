import { hkdfSync } from "node:crypto";
import { Keypair } from "@solana/web3.js";

/**
 * Per-launch deposit addresses. Each launch gets index `n` from a DB sequence and its keypair is
 * HKDF-SHA256(master secret, salt = "holdfast:deposit:v1", info = n as u64 LE). Only the 32-byte
 * master secret has to be stored (and backed up); any deposit key can be re-derived for refunds.
 */
const SALT = Buffer.from("holdfast:deposit:v1");

export function parseMasterSecret(hex: string): Buffer {
  const clean = hex.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error("DEPOSIT_MASTER_SECRET must be 32 bytes of hex");
  return Buffer.from(clean, "hex");
}

export function deriveDepositKeypair(masterSecret: Buffer, index: bigint): Keypair {
  if (masterSecret.length !== 32) throw new Error("master secret must be 32 bytes");
  if (index < 0n) throw new Error("index must be non-negative");
  const info = Buffer.alloc(8);
  info.writeBigUInt64LE(index);
  const seed = Buffer.from(hkdfSync("sha256", masterSecret, SALT, info, 32));
  return Keypair.fromSeed(seed);
}
