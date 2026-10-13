import type { CarryInput, Lot, RoundSnapshot, RoundSummary } from "@holdfast/core";
import type { Queryable } from "../db.js";
import { big, dec, json, lotId, ms, num, ts } from "../sql.js";

export type RoundStatus = RoundSummary["status"];
export type PayoutStatus = "pending" | "sent" | "confirmed" | "failed";

export interface RoundRow {
  mint: string;
  roundId: bigint;
  solPot: bigint;
  tokenPot: bigint;
  snapshotHash: string;
  snapshotAt: number;
  totalWeight: bigint;
  recipientCount: number;
  status: RoundStatus;
  openSig: string | null;
  closeSig: string | null;
  error: string | null;
  ts: number;
}

export interface PayoutRow {
  mint: string;
  roundId: bigint;
  idx: number;
  wallet: string;
  sol: bigint;
  tokens: bigint;
  sig: string | null;
  status: PayoutStatus;
}

const ROUND_COLUMNS =
  "mint, round_id, sol_pot, token_pot, snapshot_hash, snapshot_at, total_weight, recipient_count, status, open_sig, close_sig, error, ts";

function mapRound(r: Record<string, unknown>): RoundRow {
  return {
    mint: r.mint as string,
    roundId: big(r.round_id),
    solPot: big(r.sol_pot),
    tokenPot: big(r.token_pot),
    snapshotHash: r.snapshot_hash as string,
    snapshotAt: ms(r.snapshot_at),
    totalWeight: big(r.total_weight),
    recipientCount: num(r.recipient_count),
    status: r.status as RoundStatus,
    openSig: (r.open_sig as string | null) ?? null,
    closeSig: (r.close_sig as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    ts: ms(r.ts),
  };
}

function mapPayout(r: Record<string, unknown>): PayoutRow {
  return {
    mint: r.mint as string,
    roundId: big(r.round_id),
    idx: num(r.idx),
    wallet: r.wallet as string,
    sol: big(r.sol),
    tokens: big(r.tokens),
    sig: (r.sig as string | null) ?? null,
    status: r.status as PayoutStatus,
  };
}

/**
 * Store a computed round (public snapshot document + one pending payout per entry). Returns false
 * when the round already exists; the stored snapshot is immutable once written.
 */
export async function insertRound(q: Queryable, snapshot: RoundSnapshot, opts: { status?: RoundStatus; ts?: number } = {}): Promise<boolean> {
  const solPot = snapshot.entries.reduce((s, e) => s + BigInt(e.solLamports), 0n);
  const tokenPot = snapshot.entries.reduce((s, e) => s + BigInt(e.tokensRaw), 0n);
  const res = await q.query(
    `INSERT INTO payout_rounds (mint, round_id, sol_pot, token_pot, snapshot_hash, snapshot_at, total_weight, recipient_count,
       snapshot, status, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
     ON CONFLICT (mint, round_id) DO NOTHING RETURNING round_id`,
    [
      snapshot.mint,
      snapshot.roundId,
      dec(solPot),
      dec(tokenPot),
      snapshot.snapshotHash,
      ts(snapshot.snapshotAt),
      snapshot.totalWeight,
      snapshot.entries.length,
      json(snapshot),
      opts.status ?? snapshot.status,
      ts(opts.ts ?? snapshot.ts),
    ],
  );
  if (res.rows.length === 0) return false;
  if (snapshot.entries.length > 0) {
    await q.query(
      `INSERT INTO payouts (mint, round_id, idx, wallet, sol, tokens, sig, status)
       SELECT $1, $2, e.idx, e.wallet, e.sol, e.tokens, e.sig, CASE WHEN e.sig IS NULL THEN 'pending' ELSE 'confirmed' END
       FROM unnest($3::int[], $4::text[], $5::numeric[], $6::numeric[], $7::text[]) AS e(idx, wallet, sol, tokens, sig)`,
      [
        snapshot.mint,
        snapshot.roundId,
        snapshot.entries.map((e) => e.index),
        snapshot.entries.map((e) => e.wallet),
        snapshot.entries.map((e) => e.solLamports),
        snapshot.entries.map((e) => e.tokensRaw),
        snapshot.entries.map((e) => e.sig),
      ],
    );
  }
  return true;
}

export async function updateRoundStatus(
  q: Queryable,
  mint: string,
  roundId: bigint | number,
  status: RoundStatus,
  patch: { openSig?: string; closeSig?: string; error?: string | null } = {},
): Promise<boolean> {
  const res = await q.query(
    `UPDATE payout_rounds SET status = $3, open_sig = COALESCE($4, open_sig), close_sig = COALESCE($5, close_sig),
       error = CASE WHEN $6::boolean THEN $7 ELSE error END
     WHERE mint = $1 AND round_id = $2
       -- never move a closed round backwards (events may be indexed out of order)
       AND (status <> 'closed' OR $3 = 'closed')
     RETURNING round_id`,
    [mint, String(roundId), status, patch.openSig ?? null, patch.closeSig ?? null, patch.error !== undefined, patch.error ?? null],
  );
  return res.rows.length > 0;
}

export async function markPayout(
  q: Queryable,
  p: { mint: string; roundId: bigint | number; idx: number; status: PayoutStatus; sig?: string | null },
): Promise<boolean> {
  const res = await q.query(
    `UPDATE payouts SET status = $4, sig = COALESCE($5, sig) WHERE mint = $1 AND round_id = $2 AND idx = $3 RETURNING idx`,
    [p.mint, String(p.roundId), p.idx, p.status, p.sig ?? null],
  );
  return res.rows.length > 0;
}

export async function listRounds(q: Queryable, mint: string, limit: number): Promise<RoundRow[]> {
  const res = await q.query(`SELECT ${ROUND_COLUMNS} FROM payout_rounds WHERE mint = $1 ORDER BY round_id DESC LIMIT $2`, [mint, limit]);
  return res.rows.map(mapRound);
}

export async function getRound(q: Queryable, mint: string, roundId: bigint | number): Promise<(RoundRow & { snapshot: RoundSnapshot }) | null> {
  const res = await q.query(`SELECT ${ROUND_COLUMNS}, snapshot FROM payout_rounds WHERE mint = $1 AND round_id = $2`, [mint, String(roundId)]);
  const r = res.rows[0];
  if (!r) return null;
  const snapshot = (typeof r.snapshot === "string" ? JSON.parse(r.snapshot) : r.snapshot) as RoundSnapshot;
  return { ...mapRound(r), snapshot };
}

export async function getLatestRound(q: Queryable, mint: string): Promise<RoundRow | null> {
  return (await listRounds(q, mint, 1))[0] ?? null;
}

export async function listPayouts(q: Queryable, mint: string, roundId: bigint | number): Promise<PayoutRow[]> {
  const res = await q.query("SELECT * FROM payouts WHERE mint = $1 AND round_id = $2 ORDER BY idx", [mint, String(roundId)]);
  return res.rows.map(mapPayout);
}

// ---- carries -----------------------------------------------------------------------------------

export async function loadCarries(q: Queryable, mint: string): Promise<CarryInput[]> {
  const res = await q.query("SELECT wallet, sol, tokens, since FROM payout_carry WHERE mint = $1 ORDER BY wallet", [mint]);
  return res.rows.map((r) => ({ wallet: r.wallet as string, sol: big(r.sol), tokens: big(r.tokens), since: ms(r.since) }));
}

/** Replace the mint's carry book with a round's `carriedOut`. */
export async function saveCarries(q: Queryable, mint: string, carries: readonly CarryInput[]): Promise<void> {
  await q.query("DELETE FROM payout_carry WHERE mint = $1", [mint]);
  const kept = carries.filter((c) => c.sol > 0n || c.tokens > 0n);
  if (kept.length === 0) return;
  await q.query(
    `INSERT INTO payout_carry (mint, wallet, sol, tokens, since, updated_at)
     SELECT $1, c.wallet, c.sol, c.tokens, c.since, now()
     FROM unnest($2::text[], $3::numeric[], $4::numeric[], $5::timestamptz[]) AS c(wallet, sol, tokens, since)`,
    [mint, kept.map((c) => c.wallet), kept.map((c) => dec(c.sol)), kept.map((c) => dec(c.tokens)), kept.map((c) => ts(c.since))],
  );
}

export async function sumCarries(q: Queryable, mint: string): Promise<{ sol: bigint; tokens: bigint }> {
  const res = await q.query("SELECT COALESCE(sum(sol), 0) AS sol, COALESCE(sum(tokens), 0) AS tokens FROM payout_carry WHERE mint = $1", [mint]);
  return { sol: big(res.rows[0]?.sol), tokens: big(res.rows[0]?.tokens) };
}

export async function getCarry(q: Queryable, mint: string, wallet: string): Promise<CarryInput | null> {
  const res = await q.query("SELECT wallet, sol, tokens, since FROM payout_carry WHERE mint = $1 AND wallet = $2", [mint, wallet]);
  const r = res.rows[0];
  return r ? { wallet, sol: big(r.sol), tokens: big(r.tokens), since: ms(r.since) } : null;
}

// ---- eligibility ------------------------------------------------------------------------------

export interface EligibleHolder {
  wallet: string;
  /** Open lots, oldest first. */
  lots: Lot[];
}

/** Wallets with open purchase lots for `mint` (excluded addresses filtered out), for the payout worker. */
export async function loadEligibleHolders(q: Queryable, mint: string): Promise<EligibleHolder[]> {
  const res = await q.query(
    `SELECT l.wallet, l.id, l.amount_remaining, l.acquired_at FROM lots l
     WHERE l.mint = $1 AND l.amount_remaining > 0
       AND NOT EXISTS (SELECT 1 FROM excluded_wallets e WHERE e.address = l.wallet)
     ORDER BY l.wallet, l.acquired_at, l.id`,
    [mint],
  );
  const out: EligibleHolder[] = [];
  let current: EligibleHolder | null = null;
  for (const r of res.rows) {
    const wallet = r.wallet as string;
    if (!current || current.wallet !== wallet) {
      current = { wallet, lots: [] };
      out.push(current);
    }
    current.lots.push({ id: lotId(r.id), amount: big(r.amount_remaining), acquiredAt: ms(r.acquired_at) });
  }
  return out;
}

// ---- earnings (confirmed payouts) -------------------------------------------------------------

export interface Earnings {
  sol: bigint;
  tokens: bigint;
}

export async function earningsByWallet(q: Queryable, wallet: string): Promise<Map<string, Earnings>> {
  const res = await q.query(
    `SELECT mint, COALESCE(sum(sol), 0) AS sol, COALESCE(sum(tokens), 0) AS tokens FROM payouts
     WHERE wallet = $1 AND status = 'confirmed' GROUP BY mint`,
    [wallet],
  );
  return new Map(res.rows.map((r) => [r.mint as string, { sol: big(r.sol), tokens: big(r.tokens) }]));
}

export async function earningsByMint(q: Queryable, mint: string, wallets?: readonly string[]): Promise<Map<string, Earnings>> {
  const params: unknown[] = [mint];
  let filter = "";
  if (wallets) {
    params.push([...wallets]);
    filter = " AND wallet = ANY($2::text[])";
  }
  const res = await q.query(
    `SELECT wallet, COALESCE(sum(sol), 0) AS sol, COALESCE(sum(tokens), 0) AS tokens FROM payouts
     WHERE mint = $1 AND status = 'confirmed'${filter} GROUP BY wallet`,
    params,
  );
  return new Map(res.rows.map((r) => [r.wallet as string, { sol: big(r.sol), tokens: big(r.tokens) }]));
}

export interface WalletPayout {
  mint: string;
  roundId: bigint;
  sol: bigint;
  tokens: bigint;
  ts: number;
  sig: string | null;
}

export async function recentPayoutsForWallet(q: Queryable, wallet: string, limit: number): Promise<WalletPayout[]> {
  const res = await q.query(
    `SELECT p.mint, p.round_id, p.sol, p.tokens, p.sig, r.ts FROM payouts p
     JOIN payout_rounds r ON r.mint = p.mint AND r.round_id = p.round_id
     WHERE p.wallet = $1 AND p.status = 'confirmed' ORDER BY r.ts DESC, p.mint LIMIT $2`,
    [wallet, limit],
  );
  return res.rows.map((r) => ({
    mint: r.mint as string,
    roundId: big(r.round_id),
    sol: big(r.sol),
    tokens: big(r.tokens),
    ts: ms(r.ts),
    sig: (r.sig as string | null) ?? null,
  }));
}
