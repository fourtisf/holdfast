import type { Queryable } from "../db.js";

export type ExclusionReason =
  | "vault"
  | "treasury"
  | "bonding_curve"
  | "pool"
  | "pool_authority"
  | "launcher"
  | "deposit"
  | "program"
  | (string & {});

export interface ExcludedWallet {
  address: string;
  reason: ExclusionReason;
}

/** Idempotent; an existing address keeps its first reason. */
export async function addExcluded(q: Queryable, entries: readonly ExcludedWallet[]): Promise<void> {
  if (entries.length === 0) return;
  await q.query(
    `INSERT INTO excluded_wallets (address, reason)
     SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT (address) DO NOTHING`,
    [entries.map((e) => e.address), entries.map((e) => e.reason)],
  );
}

/** The subset of `addresses` that is excluded. */
export async function filterExcluded(q: Queryable, addresses: readonly string[]): Promise<Set<string>> {
  if (addresses.length === 0) return new Set();
  const res = await q.query<{ address: string }>("SELECT address FROM excluded_wallets WHERE address = ANY($1::text[])", [
    [...new Set(addresses)],
  ]);
  return new Set(res.rows.map((r) => r.address));
}

export async function isExcluded(q: Queryable, address: string): Promise<boolean> {
  return (await filterExcluded(q, [address])).has(address);
}

export async function listExcluded(q: Queryable): Promise<ExcludedWallet[]> {
  const res = await q.query<ExcludedWallet>("SELECT address, reason FROM excluded_wallets ORDER BY address");
  return res.rows;
}
