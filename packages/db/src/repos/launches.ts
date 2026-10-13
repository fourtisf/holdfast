import type { LaunchRequest, LaunchStatusKind } from "@holdfast/core";
import type { Queryable } from "../db.js";
import { big, dec, json, ms, num, ts } from "../sql.js";

export interface LaunchRow {
  id: string;
  status: LaunchStatusKind;
  form: LaunchRequest;
  depositAddress: string;
  depositIndex: bigint;
  requiredLamports: bigint;
  devBuyLamports: bigint;
  receivedLamports: bigint;
  sender: string | null;
  depositSig: string | null;
  mint: string | null;
  mintSecret: string | null;
  createSig: string | null;
  refundSig: string | null;
  error: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface NewLaunch {
  id: string;
  form: LaunchRequest;
  depositAddress: string;
  depositIndex: bigint;
  requiredLamports: bigint;
  devBuyLamports: bigint;
  expiresAt: number;
}

function mapLaunch(r: Record<string, unknown>): LaunchRow {
  return {
    id: r.id as string,
    status: r.status as LaunchStatusKind,
    form: (typeof r.form === "string" ? JSON.parse(r.form) : r.form) as LaunchRequest,
    depositAddress: r.deposit_address as string,
    depositIndex: big(r.deposit_index),
    requiredLamports: big(r.required_lamports),
    devBuyLamports: big(r.dev_buy_lamports),
    receivedLamports: big(r.received_lamports),
    sender: (r.sender as string | null) ?? null,
    depositSig: (r.deposit_sig as string | null) ?? null,
    mint: (r.mint as string | null) ?? null,
    mintSecret: (r.mint_secret as string | null) ?? null,
    createSig: (r.create_sig as string | null) ?? null,
    refundSig: (r.refund_sig as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    attempts: num(r.attempts),
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
    expiresAt: ms(r.expires_at),
  };
}

/** Next HKDF derivation index for a deposit keypair. */
export async function nextDepositIndex(q: Queryable): Promise<bigint> {
  const res = await q.query<{ n: string }>("SELECT nextval('launch_deposit_index_seq') AS n");
  return big(res.rows[0]?.n);
}

export async function insertLaunch(q: Queryable, l: NewLaunch): Promise<LaunchRow> {
  const res = await q.query(
    `INSERT INTO launches (id, status, form, deposit_address, deposit_index, required_lamports, dev_buy_lamports, expires_at)
     VALUES ($1, 'awaiting_deposit', $2::jsonb, $3, $4, $5, $6, $7) RETURNING *`,
    [l.id, json(l.form), l.depositAddress, dec(l.depositIndex), dec(l.requiredLamports), dec(l.devBuyLamports), ts(l.expiresAt)],
  );
  return mapLaunch(res.rows[0]!);
}

export async function getLaunch(q: Queryable, id: string): Promise<LaunchRow | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const res = await q.query("SELECT * FROM launches WHERE id = $1", [id]);
  return res.rows[0] ? mapLaunch(res.rows[0]) : null;
}

export async function getLaunchByDepositAddress(q: Queryable, address: string): Promise<LaunchRow | null> {
  const res = await q.query("SELECT * FROM launches WHERE deposit_address = $1", [address]);
  return res.rows[0] ? mapLaunch(res.rows[0]) : null;
}

export interface LaunchPatch {
  receivedLamports?: bigint;
  sender?: string;
  depositSig?: string;
  mint?: string;
  mintSecret?: string;
  createSig?: string;
  refundSig?: string;
  error?: string | null;
  incrementAttempts?: boolean;
}

/** Move a launch to `status`; with `from`, only when it is currently in one of those states. */
export async function updateLaunchStatus(
  q: Queryable,
  id: string,
  status: LaunchStatusKind,
  patch: LaunchPatch = {},
  from?: readonly LaunchStatusKind[],
): Promise<LaunchRow | null> {
  const params: unknown[] = [
    id,
    status,
    patch.receivedLamports === undefined ? null : dec(patch.receivedLamports),
    patch.sender ?? null,
    patch.depositSig ?? null,
    patch.mint ?? null,
    patch.mintSecret ?? null,
    patch.createSig ?? null,
    patch.refundSig ?? null,
    patch.error !== undefined,
    patch.error ?? null,
    patch.incrementAttempts ? 1 : 0,
  ];
  let guard = "";
  if (from) {
    params.push([...from]);
    guard = ` AND status = ANY($${params.length}::text[])`;
  }
  const res = await q.query(
    `UPDATE launches SET status = $2,
       received_lamports = COALESCE($3::numeric, received_lamports),
       sender = COALESCE($4, sender), deposit_sig = COALESCE($5, deposit_sig), mint = COALESCE($6, mint),
       mint_secret = COALESCE($7, mint_secret), create_sig = COALESCE($8, create_sig), refund_sig = COALESCE($9, refund_sig),
       error = CASE WHEN $10::boolean THEN $11 ELSE error END,
       attempts = attempts + $12, updated_at = now()
     WHERE id = $1${guard} RETURNING *`,
    params,
  );
  return res.rows[0] ? mapLaunch(res.rows[0]) : null;
}

export const PENDING_LAUNCH_STATUSES: readonly LaunchStatusKind[] = ["awaiting_deposit", "deposit_received", "creating", "refunding"];

export async function listPendingLaunches(
  q: Queryable,
  opts: { statuses?: readonly LaunchStatusKind[]; limit?: number } = {},
): Promise<LaunchRow[]> {
  const res = await q.query("SELECT * FROM launches WHERE status = ANY($1::text[]) ORDER BY created_at ASC LIMIT $2", [
    [...(opts.statuses ?? PENDING_LAUNCH_STATUSES)],
    opts.limit ?? 500,
  ]);
  return res.rows.map(mapLaunch);
}

/** awaiting_deposit launches past their deadline → expired. Returns the rows that changed. */
export async function expireLaunches(q: Queryable, nowMs: number): Promise<LaunchRow[]> {
  const res = await q.query(
    `UPDATE launches SET status = 'expired', updated_at = now()
     WHERE status = 'awaiting_deposit' AND expires_at < $1 RETURNING *`,
    [ts(nowMs)],
  );
  return res.rows.map(mapLaunch);
}
