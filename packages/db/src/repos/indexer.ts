import type { Queryable } from "../db.js";
import { num } from "../sql.js";

/** Claim a signature for processing. False when it was processed before (idempotency guard). */
export async function markProcessed(q: Queryable, sig: string, slot: number): Promise<boolean> {
  const res = await q.query("INSERT INTO processed_txs (sig, slot) VALUES ($1, $2) ON CONFLICT (sig) DO NOTHING RETURNING sig", [sig, slot]);
  return res.rows.length > 0;
}

export async function isProcessed(q: Queryable, sig: string): Promise<boolean> {
  const res = await q.query("SELECT 1 FROM processed_txs WHERE sig = $1", [sig]);
  return res.rows.length > 0;
}

/** The subset of `sigs` not processed yet, in input order. */
export async function filterUnprocessed(q: Queryable, sigs: readonly string[]): Promise<string[]> {
  if (sigs.length === 0) return [];
  const res = await q.query<{ sig: string }>("SELECT sig FROM processed_txs WHERE sig = ANY($1::text[])", [[...new Set(sigs)]]);
  const done = new Set(res.rows.map((r) => r.sig));
  return sigs.filter((s) => !done.has(s));
}

export interface Cursor {
  name: string;
  lastSig: string | null;
  lastSlot: number;
}

export async function getCursor(q: Queryable, name: string): Promise<Cursor | null> {
  const res = await q.query("SELECT name, last_sig, last_slot FROM indexer_cursors WHERE name = $1", [name]);
  const r = res.rows[0];
  return r ? { name, lastSig: (r.last_sig as string | null) ?? null, lastSlot: num(r.last_slot) } : null;
}

export async function setCursor(q: Queryable, name: string, lastSig: string, lastSlot: number): Promise<void> {
  await q.query(
    `INSERT INTO indexer_cursors (name, last_sig, last_slot, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (name) DO UPDATE SET last_sig = EXCLUDED.last_sig, last_slot = EXCLUDED.last_slot, updated_at = now()`,
    [name, lastSig, lastSlot],
  );
}
