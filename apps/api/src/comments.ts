import { createPublicKey, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { decodeSignature } from "@holdfast/core";

/** DER SubjectPublicKeyInfo header of a raw 32-byte ed25519 key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Is `signature` (base58) the wallet's ed25519 signature over the UTF-8 `message` (`signMessage`)? */
export function verifyWalletSignature(wallet: string, message: string, signature: string): boolean {
  try {
    const sig = decodeSignature(signature);
    if (sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(new PublicKey(wallet).toBytes())]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}
