import type { Queryable } from "../db.js";
import { big, dec, ms, msOrNull, num, ts } from "../sql.js";

/** Mirror of the on-chain CoinVault. Amounts in lamports / token base units, prices fixed-point (×1e18). */
export interface VaultStateRow {
  mint: string;
  floorSol: bigint;
  holderSol: bigint;
  burnSol: bigint;
  holderTokens: bigint;
  ath: bigint;
  floor: bigint;
  defendCount: bigint;
  lastDefendTs: number | null;
  roundId: bigint;
  totalFees: bigint;
  totalDefended: bigint;
  totalPaidSol: bigint;
  totalPaidTokens: bigint;
  totalBurnedSol: bigint;
  slot: number;
  updatedAt: number;
}

export type VaultSnapshotInput = Omit<VaultStateRow, "updatedAt">;

export function mapVaultState(r: Record<string, unknown>): VaultStateRow {
  return {
    mint: r.mint as string,
    floorSol: big(r.floor_sol),
    holderSol: big(r.holder_sol),
    burnSol: big(r.burn_sol),
    holderTokens: big(r.holder_tokens),
    ath: big(r.ath),
    floor: big(r.floor),
    defendCount: big(r.defend_count),
    lastDefendTs: msOrNull(r.last_defend_ts),
    roundId: big(r.round_id),
    totalFees: big(r.total_fees),
    totalDefended: big(r.total_defended),
    totalPaidSol: big(r.total_paid_sol),
    totalPaidTokens: big(r.total_paid_tokens),
    totalBurnedSol: big(r.total_burned_sol),
    slot: num(r.slot),
    updatedAt: ms(r.updated_at),
  };
}

export async function getVaultState(q: Queryable, mint: string): Promise<VaultStateRow | null> {
  const res = await q.query("SELECT * FROM vault_state WHERE mint = $1", [mint]);
  return res.rows[0] ? mapVaultState(res.rows[0]) : null;
}

export async function ensureVaultState(q: Queryable, mint: string): Promise<void> {
  await q.query("INSERT INTO vault_state (mint) VALUES ($1) ON CONFLICT (mint) DO NOTHING", [mint]);
}

/** Replace the mirror with an authoritative account snapshot, unless a newer slot is stored. */
export async function upsertVaultState(q: Queryable, s: VaultSnapshotInput): Promise<boolean> {
  const res = await q.query(
    `INSERT INTO vault_state AS v (mint, floor_sol, holder_sol, burn_sol, holder_tokens, ath, floor, defend_count, last_defend_ts,
       round_id, total_fees, total_defended, total_paid_sol, total_paid_tokens, total_burned_sol, slot, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now())
     ON CONFLICT (mint) DO UPDATE SET
       floor_sol = EXCLUDED.floor_sol, holder_sol = EXCLUDED.holder_sol, burn_sol = EXCLUDED.burn_sol,
       holder_tokens = EXCLUDED.holder_tokens, ath = EXCLUDED.ath, floor = EXCLUDED.floor,
       defend_count = EXCLUDED.defend_count, last_defend_ts = EXCLUDED.last_defend_ts, round_id = EXCLUDED.round_id,
       total_fees = EXCLUDED.total_fees, total_defended = EXCLUDED.total_defended,
       total_paid_sol = EXCLUDED.total_paid_sol, total_paid_tokens = EXCLUDED.total_paid_tokens,
       total_burned_sol = EXCLUDED.total_burned_sol, slot = EXCLUDED.slot, updated_at = now()
     WHERE v.slot <= EXCLUDED.slot
     RETURNING mint`,
    [
      s.mint,
      dec(s.floorSol),
      dec(s.holderSol),
      dec(s.burnSol),
      dec(s.holderTokens),
      dec(s.ath),
      dec(s.floor),
      dec(s.defendCount),
      s.lastDefendTs === null ? null : ts(s.lastDefendTs),
      dec(s.roundId),
      dec(s.totalFees),
      dec(s.totalDefended),
      dec(s.totalPaidSol),
      dec(s.totalPaidTokens),
      dec(s.totalBurnedSol),
      s.slot,
    ],
  );
  return res.rows.length > 0;
}

/**
 * Incremental update from vault events, used when no account snapshot is available (and as the
 * best estimate until the next one). Bucket deltas may be negative; ATH/floor only ratchet up.
 */
export interface VaultDelta {
  floorSol?: bigint;
  holderSol?: bigint;
  burnSol?: bigint;
  holderTokens?: bigint;
  totalFees?: bigint;
  totalDefended?: bigint;
  totalPaidSol?: bigint;
  totalPaidTokens?: bigint;
  totalBurnedSol?: bigint;
  defends?: number;
  lastDefendTs?: number;
  ath?: bigint;
  floor?: bigint;
  roundId?: bigint;
}

export async function applyVaultDelta(q: Queryable, mint: string, d: VaultDelta): Promise<void> {
  await ensureVaultState(q, mint);
  await q.query(
    `UPDATE vault_state SET
       floor_sol = GREATEST(floor_sol + $2, 0), holder_sol = GREATEST(holder_sol + $3, 0), burn_sol = GREATEST(burn_sol + $4, 0),
       holder_tokens = GREATEST(holder_tokens + $5, 0), total_fees = total_fees + $6, total_defended = total_defended + $7,
       total_paid_sol = total_paid_sol + $8, total_paid_tokens = total_paid_tokens + $9, total_burned_sol = total_burned_sol + $10,
       defend_count = defend_count + $11,
       last_defend_ts = CASE WHEN $12::timestamptz IS NULL THEN last_defend_ts ELSE GREATEST(last_defend_ts, $12::timestamptz) END,
       ath = GREATEST(ath, $13), floor = GREATEST(floor, $14), round_id = GREATEST(round_id, $15),
       updated_at = now()
     WHERE mint = $1`,
    [
      mint,
      dec(d.floorSol ?? 0n),
      dec(d.holderSol ?? 0n),
      dec(d.burnSol ?? 0n),
      dec(d.holderTokens ?? 0n),
      dec(d.totalFees ?? 0n),
      dec(d.totalDefended ?? 0n),
      dec(d.totalPaidSol ?? 0n),
      dec(d.totalPaidTokens ?? 0n),
      dec(d.totalBurnedSol ?? 0n),
      d.defends ?? 0,
      d.lastDefendTs === undefined ? null : ts(d.lastDefendTs),
      dec(d.ath ?? 0n),
      dec(d.floor ?? 0n),
      dec(d.roundId ?? 0n),
    ],
  );
}

// ---- floor history ------------------------------------------------------------------------------

export interface FloorPoint {
  ts: number;
  ath: bigint;
  floor: bigint;
}

export async function insertFloorPoint(q: Queryable, mint: string, p: FloorPoint): Promise<void> {
  await q.query(
    `INSERT INTO floor_history (mint, ts, ath, floor) VALUES ($1, $2, $3, $4)
     ON CONFLICT (mint, ts) DO UPDATE SET ath = GREATEST(floor_history.ath, EXCLUDED.ath), floor = GREATEST(floor_history.floor, EXCLUDED.floor)`,
    [mint, ts(p.ts), dec(p.ath), dec(p.floor)],
  );
}

/** Points in [from, to] plus the last point before `from`, so a step line starts at the right level. */
export async function listFloorHistory(q: Queryable, mint: string, opts: { from?: number; to?: number } = {}): Promise<FloorPoint[]> {
  const map = (r: Record<string, unknown>): FloorPoint => ({ ts: ms(r.ts), ath: big(r.ath), floor: big(r.floor) });
  const params: unknown[] = [mint];
  const conds = ["mint = $1"];
  if (opts.from !== undefined) {
    params.push(ts(opts.from));
    conds.push(`ts >= $${params.length}`);
  }
  if (opts.to !== undefined) {
    params.push(ts(opts.to));
    conds.push(`ts <= $${params.length}`);
  }
  const inRange = await q.query(`SELECT ts, ath, floor FROM floor_history WHERE ${conds.join(" AND ")} ORDER BY ts ASC`, params);
  const points = inRange.rows.map(map);
  if (opts.from !== undefined) {
    const prev = await q.query("SELECT ts, ath, floor FROM floor_history WHERE mint = $1 AND ts < $2 ORDER BY ts DESC LIMIT 1", [
      mint,
      ts(opts.from),
    ]);
    if (prev.rows[0]) points.unshift(map(prev.rows[0]));
  }
  return points;
}

// ---- defends ------------------------------------------------------------------------------------

export interface DefendRow {
  sig: string;
  mint: string;
  solSpent: bigint;
  tokensBought: bigint;
  price: number;
  ts: number;
}

export async function insertDefend(q: Queryable, d: DefendRow): Promise<boolean> {
  const res = await q.query(
    `INSERT INTO defends (sig, mint, sol_spent, tokens_bought, price, ts) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (sig, mint) DO NOTHING RETURNING sig`,
    [d.sig, d.mint, dec(d.solSpent), dec(d.tokensBought), d.price, ts(d.ts)],
  );
  return res.rows.length > 0;
}

export async function listDefends(q: Queryable, mint: string, opts: { limit: number; from?: number; to?: number }): Promise<DefendRow[]> {
  const params: unknown[] = [mint, opts.limit];
  const conds = ["mint = $1"];
  if (opts.from !== undefined) {
    params.push(ts(opts.from));
    conds.push(`ts >= $${params.length}`);
  }
  if (opts.to !== undefined) {
    params.push(ts(opts.to));
    conds.push(`ts <= $${params.length}`);
  }
  const res = await q.query(
    `SELECT sig, mint, sol_spent, tokens_bought, price, ts FROM defends WHERE ${conds.join(" AND ")} ORDER BY ts DESC, sig DESC LIMIT $2`,
    params,
  );
  return res.rows.map((r) => ({
    sig: r.sig as string,
    mint: r.mint as string,
    solSpent: big(r.sol_spent),
    tokensBought: big(r.tokens_bought),
    price: num(r.price),
    ts: ms(r.ts),
  }));
}

export async function countDefendsSince(q: Queryable, sinceMs: number): Promise<number> {
  const res = await q.query<{ n: string }>("SELECT count(*) AS n FROM defends WHERE ts >= $1", [ts(sinceMs)]);
  return num(res.rows[0]?.n);
}
