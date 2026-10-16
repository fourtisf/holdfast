import { PublicKey } from "@solana/web3.js";

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A base58 Solana address: 32–44 base58 characters that decode to exactly 32 bytes. */
export function isValidAddress(value: string): boolean {
  if (!BASE58_ADDRESS.test(value)) return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}
