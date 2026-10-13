import type { InvokedInstruction } from "@holdfast/chain";

/**
 * Normalized transaction the indexer works on, independent of where it came from (RPC
 * `getTransaction`, `getParsedTransaction`, Helius webhooks). See `adapters/`.
 */

export interface TxInstruction {
  programId: string;
  accounts: string[];
  /** Raw instruction data (empty for instructions the source only delivers pre-parsed). */
  data: Uint8Array;
}

export interface TxInnerInstructions {
  /** Index of the top-level instruction these were invoked from. */
  index: number;
  instructions: TxInstruction[];
}

export interface TokenBalance {
  accountIndex: number;
  /** Token account address. */
  account: string;
  mint: string;
  /** Token account owner (wallet or PDA); null when the source does not report it. */
  owner: string | null;
  /** Raw amount in base units. */
  amount: bigint;
  decimals: number;
}

export interface ParsedTx {
  signature: string;
  slot: number;
  /** Block time in unix ms; null when unknown. */
  blockTime: number | null;
  /** On-chain error; failed transactions change no balances and are skipped. */
  err: unknown | null;
  /** Static keys followed by lookup-table writable then readonly keys (the order indexes refer to). */
  accountKeys: string[];
  signers: string[];
  /** Null when the source carries no logs (Helius enhanced payloads). */
  logMessages: string[] | null;
  instructions: TxInstruction[];
  innerInstructions: TxInnerInstructions[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
  preBalances: bigint[];
  postBalances: bigint[];
  /**
   * `absolute` (default): pre/post token balances are real balances. `delta`: only post − pre per
   * account is meaningful (sources that report balance changes only), so gap detection is skipped.
   */
  tokenBalanceMode?: "absolute" | "delta";
}

/** Top-level and inner instructions in execution order, tagged with their top-level index. */
export function invokedInstructions(tx: ParsedTx): InvokedInstruction[] {
  const inner = new Map<number, TxInstruction[]>();
  for (const group of tx.innerInstructions) inner.set(group.index, [...(inner.get(group.index) ?? []), ...group.instructions]);
  const out: InvokedInstruction[] = [];
  tx.instructions.forEach((ix, i) => {
    out.push({ programId: ix.programId, data: ix.data, outerIndex: i });
    for (const child of inner.get(i) ?? []) out.push({ programId: child.programId, data: child.data, outerIndex: i });
  });
  return out;
}

/** Every mint whose token balances appear in the transaction. */
export function tokenMints(tx: ParsedTx): Set<string> {
  const mints = new Set<string>();
  for (const b of tx.preTokenBalances) mints.add(b.mint);
  for (const b of tx.postTokenBalances) mints.add(b.mint);
  return mints;
}
