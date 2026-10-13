/**
 * Who funded a deposit address: System `transfer` / `transferWithSeed` instructions (top level or
 * inner, so exchange withdrawals routed through a program count too) whose destination is the
 * address. Pure functions over `getParsedTransaction` results.
 */
import type { ParsedInstruction, ParsedTransactionWithMeta, PartiallyDecodedInstruction } from "@solana/web3.js";

import type { FundingInfo } from "./chain.js";

export interface IncomingTransfer {
  source: string;
  lamports: bigint;
  signature: string;
  blockTime: number | null;
  slot: number;
}

type AnyIx = ParsedInstruction | PartiallyDecodedInstruction;

function isParsed(ix: AnyIx): ix is ParsedInstruction {
  return "parsed" in ix;
}

export function incomingTransfers(tx: ParsedTransactionWithMeta | null, address: string): IncomingTransfer[] {
  if (!tx || !tx.meta || tx.meta.err) return [];
  const signature = tx.transaction.signatures[0] ?? "";
  const base = { signature, blockTime: tx.blockTime ?? null, slot: tx.slot };
  const all: AnyIx[] = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((i) => i.instructions)];
  const out: IncomingTransfer[] = [];
  for (const ix of all) {
    if (!isParsed(ix) || ix.program !== "system") continue;
    const parsed = ix.parsed as { type?: string; info?: Record<string, unknown> } | null;
    if (!parsed || (parsed.type !== "transfer" && parsed.type !== "transferWithSeed")) continue;
    const info = parsed.info ?? {};
    const source = typeof info.source === "string" ? info.source : null;
    if (info.destination !== address || !source || source === address) continue;
    const lamports = BigInt(String(info.lamports ?? 0));
    if (lamports > 0n) out.push({ ...base, source, lamports });
  }
  if (out.length > 0) return out;

  // Credited by an instruction we cannot parse: attribute the balance increase to the fee payer.
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const idx = keys.indexOf(address);
  const payer = keys[0];
  if (idx < 0 || !payer || payer === address) return [];
  const delta = BigInt(tx.meta.postBalances[idx] ?? 0) - BigInt(tx.meta.preBalances[idx] ?? 0);
  return delta > 0n ? [{ ...base, source: payer, lamports: delta }] : [];
}

/** The largest contributor (ties: the most recent one), with its most recent transfer. */
export function pickFunding(transfers: readonly IncomingTransfer[]): FundingInfo | null {
  const bySource = new Map<string, { total: bigint; latest: IncomingTransfer }>();
  for (const t of transfers) {
    const cur = bySource.get(t.source);
    if (!cur) bySource.set(t.source, { total: t.lamports, latest: t });
    else {
      cur.total += t.lamports;
      if (t.slot > cur.latest.slot) cur.latest = t;
    }
  }
  let best: { source: string; total: bigint; latest: IncomingTransfer } | null = null;
  for (const [source, v] of bySource) {
    if (!best || v.total > best.total || (v.total === best.total && v.latest.slot > best.latest.slot)) best = { source, ...v };
  }
  if (!best) return null;
  return { sender: best.source, signature: best.latest.signature, lamports: best.total, blockTime: best.latest.blockTime };
}
