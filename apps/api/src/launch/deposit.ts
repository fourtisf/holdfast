import { deriveDepositKeypair, parseMasterSecret } from "@holdfast/chain";

/**
 * Deposit addresses come from `@holdfast/chain`'s HKDF derivation (master secret + launch index),
 * the same one the launcher uses to re-derive the keypair for sweeping and refunds.
 */
export type DepositAllocator = (index: bigint) => Promise<string>;

export function hkdfDepositAllocator(masterSecretHex: string): DepositAllocator {
  const secret = parseMasterSecret(masterSecretHex);
  return async (index) => deriveDepositKeypair(secret, index).publicKey.toBase58();
}
