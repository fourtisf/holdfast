/**
 * Everything the launcher needs from Solana, behind an interface so the state machine runs offline
 * against an in-memory fake in tests (test/fakeChain.ts) and against RPC in production (web3Chain.ts).
 */
import type { PublicKey, Signer, Transaction } from "@solana/web3.js";

export interface RecentBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface FundingInfo {
  /** Source wallet of the funding transfer(s); refunds go here. */
  sender: string;
  /** Most recent funding transfer from `sender`. */
  signature: string;
  /** Total lamports `sender` transferred to the address (in the transactions inspected). */
  lamports: bigint;
  /** Block time (unix seconds) of `signature`, when known. */
  blockTime: number | null;
}

export interface AccountSnapshot {
  lamports: bigint;
  owner: string;
  data: Buffer;
}

export interface LaunchChain {
  getBalance(address: PublicKey): Promise<bigint>;
  /** Who funded `address` (System transfers into it), from its signature history. */
  findFundingSender(address: PublicKey): Promise<FundingInfo | null>;
  accountExists(address: PublicKey): Promise<boolean>;
  getAccountInfo(address: PublicKey): Promise<AccountSnapshot | null>;
  getMinimumBalanceForRentExemption(dataLength: number): Promise<bigint>;
  latestBlockhash(): Promise<RecentBlockhash>;
  /**
   * Sign `tx` with `signers` (fee payer and recent blockhash already set), broadcast it and wait
   * for confirmation until the blockhash's `lastValidBlockHeight`. Resolves with the signature;
   * rejects with a `TxError`.
   */
  sendAndConfirm(tx: Transaction, signers: Signer[]): Promise<string>;
}

/**
 * - `rejected`: refused before broadcast (preflight / simulation); never lands.
 * - `failed`: landed with an error; its effects were rolled back (the fee was paid).
 * - `expired`: block height passed `lastValidBlockHeight` without confirmation; can never land.
 * - `unknown`: the outcome could not be determined (RPC errors while confirming); it may still land.
 */
export type TxOutcome = "rejected" | "failed" | "expired" | "unknown";

export class TxError extends Error {
  override readonly name = "TxError";
  constructor(
    message: string,
    readonly outcome: TxOutcome,
    readonly signature: string | null,
    readonly logs: readonly string[] = [],
  ) {
    super(message);
  }
}
