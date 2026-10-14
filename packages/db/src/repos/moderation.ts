import type { ReportReason } from "@holdfast/core";
import type { Queryable } from "../db.js";
import { ms, msOrNull, num } from "../sql.js";

export interface ReportRow {
  id: number;
  targetType: "coin" | "comment";
  targetId: string;
  mint: string;
  reason: ReportReason;
  details: string;
  createdAt: number;
  resolvedAt: number | null;
  resolution: string | null;
}

function mapReport(r: Record<string, unknown>): ReportRow {
  return {
    id: num(r.id),
    targetType: r.target_type as ReportRow["targetType"],
    targetId: r.target_id as string,
    mint: r.mint as string,
    reason: r.reason as ReportReason,
    details: (r.details as string) ?? "",
    createdAt: ms(r.created_at),
    resolvedAt: msOrNull(r.resolved_at),
    resolution: (r.resolution as string | null) ?? null,
  };
}

/** Records a report; returns false when this reporter already reported the target. */
export async function insertReport(
  q: Queryable,
  r: { targetType: "coin" | "comment"; targetId: string; mint: string; reason: ReportReason; details?: string; reporterHash: string },
): Promise<boolean> {
  const res = await q.query(
    `INSERT INTO reports (target_type, target_id, mint, reason, details, reporter_hash) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (target_type, target_id, reporter_hash) DO NOTHING`,
    [r.targetType, r.targetId, r.mint, r.reason, r.details ?? "", r.reporterHash],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Distinct open reports against a target (auto-hide threshold). */
export async function countOpenReports(q: Queryable, targetType: "coin" | "comment", targetId: string): Promise<number> {
  const res = await q.query<{ n: string }>("SELECT count(*) AS n FROM reports WHERE target_type = $1 AND target_id = $2 AND resolved_at IS NULL", [targetType, targetId]);
  return num(res.rows[0]?.n);
}

export async function listReports(q: Queryable, opts: { open?: boolean; limit: number; offset?: number }): Promise<ReportRow[]> {
  const res = await q.query(
    `SELECT * FROM reports ${opts.open === false ? "" : "WHERE resolved_at IS NULL"} ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`,
    [opts.limit, opts.offset ?? 0],
  );
  return res.rows.map(mapReport);
}

/** Resolves every open report of a target (or one report by id). Returns how many changed. */
export async function resolveReports(q: Queryable, where: { id: number } | { targetType: "coin" | "comment"; targetId: string }, resolution: string): Promise<number> {
  const res =
    "id" in where
      ? await q.query("UPDATE reports SET resolved_at = now(), resolution = $2 WHERE id = $1 AND resolved_at IS NULL", [where.id, resolution])
      : await q.query("UPDATE reports SET resolved_at = now(), resolution = $3 WHERE target_type = $1 AND target_id = $2 AND resolved_at IS NULL", [
          where.targetType,
          where.targetId,
          resolution,
        ]);
  return res.rowCount ?? 0;
}

export async function setCoinHidden(q: Queryable, mint: string, hidden: boolean, reason: string | null): Promise<boolean> {
  const res = await q.query(
    hidden
      ? "UPDATE coins SET hidden = true, hidden_reason = $2, hidden_at = now() WHERE mint = $1"
      : "UPDATE coins SET hidden = false, hidden_reason = NULL, hidden_at = NULL, needs_review = false WHERE mint = $1",
    hidden ? [mint, reason] : [mint],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function setCoinNeedsReview(q: Queryable, mint: string, needsReview: boolean): Promise<void> {
  await q.query("UPDATE coins SET needs_review = $2 WHERE mint = $1", [mint, needsReview]);
}

export interface ModeratedCoin {
  mint: string;
  name: string;
  ticker: string;
  hidden: boolean;
  hiddenReason: string | null;
  hiddenAt: number | null;
  needsReview: boolean;
  openReports: number;
  createdAt: number;
}

/** Coins an admin should look at: hidden, flagged for review, or reported. */
export async function listModeratedCoins(q: Queryable, limit: number): Promise<ModeratedCoin[]> {
  const res = await q.query(
    `SELECT c.mint, c.name, c.ticker, c.hidden, c.hidden_reason, c.hidden_at, c.needs_review, c.created_at,
            (SELECT count(*) FROM reports r WHERE r.target_type = 'coin' AND r.target_id = c.mint AND r.resolved_at IS NULL) AS open_reports
       FROM coins c
      WHERE c.hidden OR c.needs_review OR EXISTS (SELECT 1 FROM reports r WHERE r.target_type = 'coin' AND r.target_id = c.mint AND r.resolved_at IS NULL)
      ORDER BY open_reports DESC, c.created_at DESC LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({
    mint: r.mint as string,
    name: r.name as string,
    ticker: r.ticker as string,
    hidden: Boolean(r.hidden),
    hiddenReason: (r.hidden_reason as string | null) ?? null,
    hiddenAt: msOrNull(r.hidden_at),
    needsReview: Boolean(r.needs_review),
    openReports: num(r.open_reports),
    createdAt: ms(r.created_at),
  }));
}

export async function blockImage(q: Queryable, sha256: string, reason: string): Promise<void> {
  await q.query("INSERT INTO blocked_images (sha256, reason) VALUES ($1, $2) ON CONFLICT (sha256) DO NOTHING", [sha256, reason]);
}

export async function isImageBlocked(q: Queryable, sha256: string): Promise<boolean> {
  const res = await q.query("SELECT 1 FROM blocked_images WHERE sha256 = $1", [sha256]);
  return res.rows.length > 0;
}

export interface ModerationLogRow {
  id: number;
  action: string;
  target: string;
  actor: string;
  reason: string;
  createdAt: number;
}

export async function logModeration(q: Queryable, e: { action: string; target: string; actor: string; reason?: string }): Promise<void> {
  await q.query("INSERT INTO moderation_log (action, target, actor, reason) VALUES ($1, $2, $3, $4)", [e.action, e.target, e.actor, e.reason ?? ""]);
}

export async function listModerationLog(q: Queryable, limit: number): Promise<ModerationLogRow[]> {
  const res = await q.query("SELECT * FROM moderation_log ORDER BY created_at DESC, id DESC LIMIT $1", [limit]);
  return res.rows.map((r) => ({ id: num(r.id), action: r.action as string, target: r.target as string, actor: r.actor as string, reason: (r.reason as string) ?? "", createdAt: ms(r.created_at) }));
}
