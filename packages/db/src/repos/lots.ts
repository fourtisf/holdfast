import type { Lot, LotConsumption, WalletLedger } from "@holdfast/core";
import type { Queryable } from "../db.js";
import { big, dec, lotId, ms, num, ts } from "../sql.js";

export interface NewLot {
  wallet: string;
  mint: string;
  amount: bigint;
  acquiredAt: number;
  sourceSig: string;
  sourceIx: number;
}

export interface WalletBalanceRow {
  mint: string;
  wallet: string;
  balance: bigint;
  untracked: bigint;
  updatedSlot: number;
}

function mapLot(r: Record<string, unknown>): Lot {
  return { id: lotId(r.id), amount: big(r.amount_remaining), acquiredAt: ms(r.acquired_at) };
}

const OPEN_LOTS_ORDER = "acquired_at ASC, id ASC";

export async function loadOpenLots(q: Queryable, mint: string, wallet: string): Promise<Lot[]> {
  const res = await q.query(
    `SELECT id, amount_remaining, acquired_at FROM lots
     WHERE mint = $1 AND wallet = $2 AND amount_remaining > 0 ORDER BY ${OPEN_LOTS_ORDER}`,
    [mint, wallet],
  );
  return res.rows.map(mapLot);
}

/**
 * Current ledger (balance mirror + open lots) for one wallet. `forUpdate` row-locks the balance so
 * concurrent indexer workers serialize on the same wallet.
 */
export async function loadLedger(q: Queryable, mint: string, wallet: string, opts: { forUpdate?: boolean } = {}): Promise<WalletLedger> {
  const bal = await q.query(
    `SELECT balance, untracked FROM wallet_balances WHERE mint = $1 AND wallet = $2${opts.forUpdate ? " FOR UPDATE" : ""}`,
    [mint, wallet],
  );
  const lots = await loadOpenLots(q, mint, wallet);
  const row = bal.rows[0];
  return { balance: row ? big(row.balance) : 0n, untracked: row ? big(row.untracked) : 0n, lots };
}

/** Returns the new lot id, or null when this (sig, ix, wallet) lot already exists. */
export async function insertLot(q: Queryable, lot: NewLot): Promise<string | null> {
  if (lot.amount <= 0n) throw new Error("lot amount must be positive");
  const res = await q.query<{ id: string }>(
    `INSERT INTO lots (wallet, mint, amount_initial, amount_remaining, acquired_at, source_sig, source_ix)
     VALUES ($1, $2, $3, $3, $4, $5, $6)
     ON CONFLICT (source_sig, source_ix, wallet) DO NOTHING RETURNING id`,
    [lot.wallet, lot.mint, dec(lot.amount), ts(lot.acquiredAt), lot.sourceSig, lot.sourceIx],
  );
  return res.rows[0] ? lotId(res.rows[0].id) : null;
}

/** Subtract consumed amounts (from core `applyDecrease`) from their lots, never below zero. */
export async function applyLotConsumptions(q: Queryable, consumptions: readonly LotConsumption[]): Promise<void> {
  const byLot = new Map<string, bigint>();
  for (const c of consumptions) {
    const id = BigInt(c.lotId).toString();
    byLot.set(id, (byLot.get(id) ?? 0n) + c.amount);
  }
  if (byLot.size === 0) return;
  await q.query(
    `UPDATE lots AS l SET amount_remaining = GREATEST(l.amount_remaining - c.amount, 0)
     FROM unnest($1::bigint[], $2::numeric[]) AS c(id, amount)
     WHERE l.id = c.id`,
    [[...byLot.keys()], [...byLot.values()].map(dec)],
  );
}

export async function getWalletBalance(q: Queryable, mint: string, wallet: string): Promise<WalletBalanceRow | null> {
  const res = await q.query("SELECT mint, wallet, balance, untracked, updated_slot FROM wallet_balances WHERE mint = $1 AND wallet = $2", [
    mint,
    wallet,
  ]);
  return res.rows[0] ? mapBalance(res.rows[0]) : null;
}

function mapBalance(r: Record<string, unknown>): WalletBalanceRow {
  return {
    mint: r.mint as string,
    wallet: r.wallet as string,
    balance: big(r.balance),
    untracked: big(r.untracked),
    updatedSlot: num(r.updated_slot),
  };
}

export async function upsertWalletBalance(
  q: Queryable,
  row: { mint: string; wallet: string; balance: bigint; untracked: bigint; slot: number },
): Promise<void> {
  await q.query(
    `INSERT INTO wallet_balances (mint, wallet, balance, untracked, updated_slot) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (mint, wallet) DO UPDATE SET balance = EXCLUDED.balance, untracked = EXCLUDED.untracked,
       updated_slot = GREATEST(wallet_balances.updated_slot, EXCLUDED.updated_slot)`,
    [row.mint, row.wallet, dec(row.balance), dec(row.untracked), row.slot],
  );
}

/** Persist a ledger produced by core lot functions: consumptions, new lots and the balance mirror. */
export async function saveLedger(
  q: Queryable,
  change: {
    mint: string;
    wallet: string;
    ledger: WalletLedger;
    consumed: readonly LotConsumption[];
    newLots: readonly NewLot[];
    slot: number;
  },
): Promise<void> {
  await applyLotConsumptions(q, change.consumed);
  for (const lot of change.newLots) await insertLot(q, lot);
  await upsertWalletBalance(q, {
    mint: change.mint,
    wallet: change.wallet,
    balance: change.ledger.balance,
    untracked: change.ledger.untracked,
    slot: change.slot,
  });
}

/** Wallets (not excluded) holding a positive balance or an open lot of `mint`. */
export interface HolderBookEntry {
  wallet: string;
  balance: bigint;
  untracked: bigint;
  lots: Lot[];
}

export async function loadHolderBook(q: Queryable, mint: string): Promise<HolderBookEntry[]> {
  const balances = await q.query(
    `SELECT wallet, balance, untracked FROM wallet_balances wb
     WHERE wb.mint = $1 AND wb.balance > 0
       AND NOT EXISTS (SELECT 1 FROM excluded_wallets e WHERE e.address = wb.wallet)`,
    [mint],
  );
  const lots = await q.query(
    `SELECT wallet, id, amount_remaining, acquired_at FROM lots l
     WHERE l.mint = $1 AND l.amount_remaining > 0
       AND NOT EXISTS (SELECT 1 FROM excluded_wallets e WHERE e.address = l.wallet)
     ORDER BY wallet, ${OPEN_LOTS_ORDER}`,
    [mint],
  );
  const book = new Map<string, HolderBookEntry>();
  for (const r of balances.rows) {
    book.set(r.wallet as string, { wallet: r.wallet as string, balance: big(r.balance), untracked: big(r.untracked), lots: [] });
  }
  for (const r of lots.rows) {
    const wallet = r.wallet as string;
    let entry = book.get(wallet);
    if (!entry) {
      entry = { wallet, balance: 0n, untracked: 0n, lots: [] };
      book.set(wallet, entry);
    }
    entry.lots.push(mapLot(r));
  }
  return [...book.values()];
}

/** Every position of one wallet: mint → balance, untracked and open lots. */
export async function loadWalletBook(q: Queryable, wallet: string): Promise<Map<string, Omit<HolderBookEntry, "wallet">>> {
  const balances = await q.query("SELECT mint, balance, untracked FROM wallet_balances WHERE wallet = $1", [wallet]);
  const lots = await q.query(
    `SELECT mint, id, amount_remaining, acquired_at FROM lots WHERE wallet = $1 AND amount_remaining > 0 ORDER BY mint, ${OPEN_LOTS_ORDER}`,
    [wallet],
  );
  const out = new Map<string, Omit<HolderBookEntry, "wallet">>();
  for (const r of balances.rows) out.set(r.mint as string, { balance: big(r.balance), untracked: big(r.untracked), lots: [] });
  for (const r of lots.rows) {
    const mint = r.mint as string;
    let entry = out.get(mint);
    if (!entry) {
      entry = { balance: 0n, untracked: 0n, lots: [] };
      out.set(mint, entry);
    }
    entry.lots.push(mapLot(r));
  }
  return out;
}

export async function countHolders(q: Queryable, mint: string): Promise<number> {
  const res = await q.query<{ n: string }>(
    `SELECT count(*) AS n FROM wallet_balances wb WHERE wb.mint = $1 AND wb.balance > 0
       AND NOT EXISTS (SELECT 1 FROM excluded_wallets e WHERE e.address = wb.wallet)`,
    [mint],
  );
  return num(res.rows[0]?.n);
}

// ---- token accounts (indexer continuity tracking) ----------------------------------------------

export interface TokenAccountRow {
  address: string;
  mint: string;
  owner: string;
  amount: bigint;
  slot: number;
}

export async function getTokenAccounts(q: Queryable, addresses: readonly string[]): Promise<Map<string, TokenAccountRow>> {
  if (addresses.length === 0) return new Map();
  const res = await q.query("SELECT address, mint, owner, amount, slot FROM token_accounts WHERE address = ANY($1::text[]) FOR UPDATE", [
    [...new Set(addresses)],
  ]);
  return new Map(
    res.rows.map((r) => [
      r.address as string,
      { address: r.address as string, mint: r.mint as string, owner: r.owner as string, amount: big(r.amount), slot: num(r.slot) },
    ]),
  );
}

export async function upsertTokenAccount(q: Queryable, row: TokenAccountRow): Promise<void> {
  await q.query(
    `INSERT INTO token_accounts (address, mint, owner, amount, slot, updated_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (address) DO UPDATE SET owner = EXCLUDED.owner, amount = EXCLUDED.amount, slot = EXCLUDED.slot, updated_at = now()`,
    [row.address, row.mint, row.owner, dec(row.amount), row.slot],
  );
}
