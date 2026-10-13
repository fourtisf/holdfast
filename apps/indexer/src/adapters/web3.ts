import bs58 from "bs58";
import type {
  ParsedInstruction,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
  PublicKey,
  TokenBalance as Web3TokenBalance,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import type { ParsedTx, TokenBalance, TxInstruction } from "../tx.js";

/** Adapters from @solana/web3.js `getTransaction` / `getParsedTransaction` responses. */

export function mapTokenBalances(list: readonly Web3TokenBalance[] | null | undefined, accountKeys: readonly string[]): TokenBalance[] {
  return (list ?? []).map((b) => ({
    accountIndex: b.accountIndex,
    account: accountKeys[b.accountIndex] ?? "",
    mint: b.mint,
    owner: b.owner ?? null,
    amount: BigInt(b.uiTokenAmount.amount),
    decimals: b.uiTokenAmount.decimals,
  }));
}

const toBig = (list: readonly number[] | null | undefined) => (list ?? []).map((n) => BigInt(n));
const blockTimeMs = (t: number | null | undefined) => (typeof t === "number" ? t * 1000 : null);

/** `connection.getTransaction(sig, { maxSupportedTransactionVersion })`. */
export function fromVersionedTransactionResponse(res: VersionedTransactionResponse): ParsedTx {
  const message = res.transaction.message;
  const meta = res.meta;
  const loaded = meta?.loadedAddresses;
  const keys = (
    "addressTableLookups" in message && message.addressTableLookups.length > 0 && loaded
      ? message.getAccountKeys({ accountKeysFromLookups: loaded })
      : message.getAccountKeys()
  )
    .keySegments()
    .flat()
    .map((k: PublicKey) => k.toBase58());

  const instructions: TxInstruction[] = message.compiledInstructions.map((ix) => ({
    programId: keys[ix.programIdIndex] ?? "",
    accounts: ix.accountKeyIndexes.map((i) => keys[i] ?? ""),
    data: Uint8Array.from(ix.data),
  }));
  const innerInstructions = (meta?.innerInstructions ?? []).map((group) => ({
    index: group.index,
    instructions: group.instructions.map((ix) => ({
      programId: keys[ix.programIdIndex] ?? "",
      accounts: ix.accounts.map((i) => keys[i] ?? ""),
      data: bs58.decode(ix.data),
    })),
  }));

  return {
    signature: res.transaction.signatures[0] ?? "",
    slot: res.slot,
    blockTime: blockTimeMs(res.blockTime),
    err: meta?.err ?? null,
    accountKeys: keys,
    signers: keys.slice(0, message.header.numRequiredSignatures),
    logMessages: meta?.logMessages ?? null,
    instructions,
    innerInstructions,
    preTokenBalances: mapTokenBalances(meta?.preTokenBalances, keys),
    postTokenBalances: mapTokenBalances(meta?.postTokenBalances, keys),
    preBalances: toBig(meta?.preBalances),
    postBalances: toBig(meta?.postBalances),
  };
}

function mapParsedInstruction(ix: ParsedInstruction | PartiallyDecodedInstruction): TxInstruction {
  if ("data" in ix) {
    return { programId: ix.programId.toBase58(), accounts: ix.accounts.map((a) => a.toBase58()), data: bs58.decode(ix.data) };
  }
  // Instructions of programs the RPC knows (spl-token, system, ...) arrive pre-parsed without raw data.
  return { programId: ix.programId.toBase58(), accounts: [], data: new Uint8Array() };
}

/** `connection.getParsedTransaction(sig, { maxSupportedTransactionVersion })`. */
export function fromParsedTransactionWithMeta(res: ParsedTransactionWithMeta): ParsedTx {
  const keys = res.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const meta = res.meta;
  return {
    signature: res.transaction.signatures[0] ?? "",
    slot: res.slot,
    blockTime: blockTimeMs(res.blockTime),
    err: meta?.err ?? null,
    accountKeys: keys,
    signers: res.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey.toBase58()),
    logMessages: meta?.logMessages ?? null,
    instructions: res.transaction.message.instructions.map(mapParsedInstruction),
    innerInstructions: (meta?.innerInstructions ?? []).map((g) => ({ index: g.index, instructions: g.instructions.map(mapParsedInstruction) })),
    preTokenBalances: mapTokenBalances(meta?.preTokenBalances, keys),
    postTokenBalances: mapTokenBalances(meta?.postTokenBalances, keys),
    preBalances: toBig(meta?.preBalances),
    postBalances: toBig(meta?.postBalances),
  };
}
