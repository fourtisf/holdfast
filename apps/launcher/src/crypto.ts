/**
 * Mint keypairs are generated once per launch and stored in `launches.mint_secret`, encrypted, so a
 * retry after a crash reuses the same mint (and therefore the same bonding curve / vault PDAs).
 *
 * key  = HKDF-SHA256(DEPOSIT_MASTER_SECRET, salt "holdfast:launcher:v1", info "holdfast:mint-secret:v1")
 *        (the deposit keys use salt "holdfast:deposit:v1" with the index as info, so the domains differ)
 * blob = "v1." ‖ base64url(iv[12] ‖ tag[16] ‖ AES-256-GCM(secretKey[64]))   AAD = launch id
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";

const SALT = Buffer.from("holdfast:launcher:v1");
const INFO = Buffer.from("holdfast:mint-secret:v1");
const PREFIX = "v1.";

export function mintSecretKey(masterSecret: Buffer): Buffer {
  if (masterSecret.length !== 32) throw new Error("master secret must be 32 bytes");
  return Buffer.from(hkdfSync("sha256", masterSecret, SALT, INFO, 32));
}

export function encryptMintSecret(key: Buffer, launchId: string, keypair: Keypair): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(launchId));
  const ct = Buffer.concat([cipher.update(Buffer.from(keypair.secretKey)), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
}

export function decryptMintSecret(key: Buffer, launchId: string, blob: string): Keypair {
  if (!blob.startsWith(PREFIX)) throw new Error("unsupported mint secret format");
  const raw = Buffer.from(blob.slice(PREFIX.length), "base64url");
  if (raw.length !== 12 + 16 + 64) throw new Error("malformed mint secret");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(launchId));
  decipher.setAuthTag(raw.subarray(12, 28));
  const secret = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  return Keypair.fromSecretKey(secret);
}
