import bs58 from "bs58";
import type { ParsedTx, TokenBalance, TxInstruction } from "../tx.js";

/**
 * Helius webhook payloads (an array of transactions per delivery).
 * - raw webhooks: each item is the JSON-RPC `getTransaction` result (encoding `json`).
 * - enhanced webhooks: Helius' parsed format; no logs and only balance changes, so Holdfast vault
 *   events (log based) are not visible and token balances are deltas. Prefer raw webhooks.
 */

interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

interface RawCompiledInstruction {
  programIdIndex: number;
  accounts: number[];
  data: string;
}

export interface RawTransactionJson {
  slot: number;
  blockTime?: number | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: (string | { pubkey: string; signer?: boolean })[];
      header?: { numRequiredSignatures: number };
      instructions: RawCompiledInstruction[];
    };
  };
  meta: {
    err: unknown;
    logMessages?: string[] | null;
    innerInstructions?: { index: number; instructions: RawCompiledInstruction[] }[] | null;
    preTokenBalances?: RawTokenBalance[] | null;
    postTokenBalances?: RawTokenBalance[] | null;
    preBalances?: number[];
    postBalances?: number[];
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  } | null;
}

export interface EnhancedTransactionJson {
  signature: string;
  slot: number;
  timestamp?: number | null;
  feePayer?: string;
  transactionError?: unknown;
  instructions?: {
    programId: string;
    accounts?: string[];
    data?: string;
    innerInstructions?: { programId: string; accounts?: string[]; data?: string }[];
  }[];
  accountData?: {
    account: string;
    nativeBalanceChange?: number;
    tokenBalanceChanges?: {
      mint: string;
      tokenAccount: string;
      userAccount: string;
      rawTokenAmount: { tokenAmount: string; decimals: number };
    }[];
  }[];
}

export function isRawTransactionJson(v: unknown): v is RawTransactionJson {
  const o = v as RawTransactionJson | null;
  return !!o && typeof o === "object" && typeof o.slot === "number" && !!o.transaction?.message && "meta" in o;
}

export function isEnhancedTransactionJson(v: unknown): v is EnhancedTransactionJson {
  const o = v as EnhancedTransactionJson | null;
  return !!o && typeof o === "object" && typeof o.signature === "string" && typeof o.slot === "number" && !("transaction" in o);
}

const decode58 = (data: string | undefined) => (data ? bs58.decode(data) : new Uint8Array());

function mapRawBalances(list: RawTokenBalance[] | null | undefined, keys: readonly string[]): TokenBalance[] {
  return (list ?? []).map((b) => ({
    accountIndex: b.accountIndex,
    account: keys[b.accountIndex] ?? "",
    mint: b.mint,
    owner: b.owner ?? null,
    amount: BigInt(b.uiTokenAmount.amount),
    decimals: b.uiTokenAmount.decimals,
  }));
}

/** Raw webhook item / JSON-RPC getTransaction result → ParsedTx. */
export function fromRawTransactionJson(raw: RawTransactionJson): ParsedTx {
  const msg = raw.transaction.message;
  const staticKeys = msg.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const loaded = raw.meta?.loadedAddresses;
  const keys = [...staticKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  const signerCount =
    msg.header?.numRequiredSignatures ?? msg.accountKeys.filter((k) => typeof k !== "string" && k.signer).length;
  const mapIx = (ix: RawCompiledInstruction): TxInstruction => ({
    programId: keys[ix.programIdIndex] ?? "",
    accounts: ix.accounts.map((i) => keys[i] ?? ""),
    data: decode58(ix.data),
  });
  return {
    signature: raw.transaction.signatures[0] ?? "",
    slot: raw.slot,
    blockTime: typeof raw.blockTime === "number" ? raw.blockTime * 1000 : null,
    err: raw.meta?.err ?? null,
    accountKeys: keys,
    signers: keys.slice(0, signerCount),
    logMessages: raw.meta?.logMessages ?? null,
    instructions: msg.instructions.map(mapIx),
    innerInstructions: (raw.meta?.innerInstructions ?? []).map((g) => ({ index: g.index, instructions: g.instructions.map(mapIx) })),
    preTokenBalances: mapRawBalances(raw.meta?.preTokenBalances, keys),
    postTokenBalances: mapRawBalances(raw.meta?.postTokenBalances, keys),
    preBalances: (raw.meta?.preBalances ?? []).map((n) => BigInt(n)),
    postBalances: (raw.meta?.postBalances ?? []).map((n) => BigInt(n)),
  };
}

/** Enhanced webhook item → ParsedTx with delta-only token balances and no logs. */
export function fromEnhancedTransactionJson(tx: EnhancedTransactionJson): ParsedTx {
  const keys: string[] = [];
  const index = new Map<string, number>();
  const keyIndex = (k: string) => {
    let i = index.get(k);
    if (i === undefined) {
      i = keys.length;
      keys.push(k);
      index.set(k, i);
    }
    return i;
  };
  if (tx.feePayer) keyIndex(tx.feePayer);

  const instructions: TxInstruction[] = [];
  const innerInstructions: ParsedTx["innerInstructions"] = [];
  (tx.instructions ?? []).forEach((ix, i) => {
    instructions.push({ programId: ix.programId, accounts: ix.accounts ?? [], data: decode58(ix.data) });
    for (const a of ix.accounts ?? []) keyIndex(a);
    const inner = (ix.innerInstructions ?? []).map((c) => ({ programId: c.programId, accounts: c.accounts ?? [], data: decode58(c.data) }));
    if (inner.length) innerInstructions.push({ index: i, instructions: inner });
  });

  const pre: TokenBalance[] = [];
  const post: TokenBalance[] = [];
  for (const acc of tx.accountData ?? []) {
    for (const change of acc.tokenBalanceChanges ?? []) {
      const delta = BigInt(change.rawTokenAmount.tokenAmount);
      const accountIndex = keyIndex(change.tokenAccount);
      const base = { accountIndex, account: change.tokenAccount, mint: change.mint, owner: change.userAccount, decimals: change.rawTokenAmount.decimals };
      pre.push({ ...base, amount: delta < 0n ? -delta : 0n });
      post.push({ ...base, amount: delta > 0n ? delta : 0n });
    }
  }
  return {
    signature: tx.signature,
    slot: tx.slot,
    blockTime: typeof tx.timestamp === "number" ? tx.timestamp * 1000 : null,
    err: tx.transactionError ?? null,
    accountKeys: keys,
    signers: tx.feePayer ? [tx.feePayer] : [],
    logMessages: null,
    instructions,
    innerInstructions,
    preTokenBalances: pre,
    postTokenBalances: post,
    preBalances: [],
    postBalances: [],
    tokenBalanceMode: "delta",
  };
}

/** Normalize one item of a Helius webhook delivery (raw or enhanced). */
export function fromHeliusPayloadItem(item: unknown): ParsedTx {
  if (isRawTransactionJson(item)) return fromRawTransactionJson(item);
  if (isEnhancedTransactionJson(item)) return fromEnhancedTransactionJson(item);
  throw new Error("unrecognized Helius webhook item");
}
