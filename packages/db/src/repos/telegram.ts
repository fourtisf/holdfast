import type { Queryable } from "../db.js";
import { big, dec, ms, num, ts } from "../sql.js";

/** Telegram launch bot and group buy bot state (apps/notifier), and the $MOATPAD burns it announces. */

export interface TgDraft {
  chatId: number;
  userId: number;
  step: string;
  data: Record<string, unknown>;
  updatedAt: number;
}

/** jsonb comes back parsed from pg and as text from some drivers. */
function parseData(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object") return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

export async function getDraft(q: Queryable, chatId: number): Promise<TgDraft | null> {
  const res = await q.query("SELECT * FROM tg_drafts WHERE chat_id = $1", [String(chatId)]);
  const r = res.rows[0];
  if (!r) return null;
  return { chatId: num(r.chat_id), userId: num(r.user_id), step: r.step as string, data: parseData(r.data), updatedAt: ms(r.updated_at) };
}

export async function saveDraft(q: Queryable, d: { chatId: number; userId: number; step: string; data: Record<string, unknown> }): Promise<void> {
  await q.query(
    `INSERT INTO tg_drafts (chat_id, user_id, step, data, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (chat_id) DO UPDATE SET user_id = EXCLUDED.user_id, step = EXCLUDED.step, data = EXCLUDED.data, updated_at = now()`,
    [String(d.chatId), String(d.userId), d.step, JSON.stringify(d.data)],
  );
}

export async function deleteDraft(q: Queryable, chatId: number): Promise<boolean> {
  const res = await q.query("DELETE FROM tg_drafts WHERE chat_id = $1 RETURNING chat_id", [String(chatId)]);
  return res.rows.length > 0;
}

export async function addTgLaunch(q: Queryable, launchId: string, chatId: number): Promise<void> {
  await q.query("INSERT INTO tg_launches (launch_id, chat_id) VALUES ($1, $2) ON CONFLICT (launch_id) DO NOTHING", [launchId, String(chatId)]);
}

/** The chat that started launch `launchId` from Telegram, if any. */
export async function chatForLaunch(q: Queryable, launchId: string): Promise<number | null> {
  const res = await q.query("SELECT chat_id FROM tg_launches WHERE launch_id = $1", [launchId]);
  return res.rows[0] ? num(res.rows[0].chat_id) : null;
}

/**
 * A basic group upgraded to a supergroup gets a new chat id: move everything the bot keeps for
 * `fromChatId` (buy bot, subscriptions, launch draft, launch progress, sent-message claims) to
 * `toChatId`. Where the new chat already has a row with the same key, the new chat's row is kept and
 * the old one dropped. Idempotent: running it again finishes an interrupted move.
 */
export async function moveTelegramChat(q: Queryable, fromChatId: number, toChatId: number): Promise<void> {
  if (fromChatId === toChatId) return;
  const ids = [String(fromChatId), String(toChatId)];
  // One row per chat.
  for (const table of ["tg_buybots", "tg_drafts"]) {
    await q.query(`DELETE FROM ${table} WHERE chat_id = $1 AND EXISTS (SELECT 1 FROM ${table} WHERE chat_id = $2)`, ids);
    await q.query(`UPDATE ${table} SET chat_id = $2 WHERE chat_id = $1`, ids);
  }
  // Keyed by chat and something else: keep the new chat's copy of a duplicate.
  await q.query(
    "DELETE FROM tg_subscriptions o WHERE o.chat_id = $1 AND EXISTS (SELECT 1 FROM tg_subscriptions n WHERE n.chat_id = $2 AND n.kind = o.kind AND n.target = o.target)",
    ids,
  );
  await q.query("UPDATE tg_subscriptions SET chat_id = $2 WHERE chat_id = $1", ids);
  await q.query("DELETE FROM tg_sent o WHERE o.chat_id = $1 AND EXISTS (SELECT 1 FROM tg_sent n WHERE n.chat_id = $2 AND n.event_key = o.event_key)", ids);
  await q.query("UPDATE tg_sent SET chat_id = $2 WHERE chat_id = $1", ids);
  await q.query("UPDATE tg_launches SET chat_id = $2 WHERE chat_id = $1", ids);
}

export interface TgBuybot {
  chatId: number;
  mint: string;
  minLamports: bigint;
  createdAt: number;
}

function mapBuybot(r: Record<string, unknown>): TgBuybot {
  return { chatId: num(r.chat_id), mint: r.mint as string, minLamports: big(r.min_lamports), createdAt: ms(r.created_at) };
}

/** One coin per group: setting a new one replaces the old. */
export async function setBuybot(q: Queryable, b: { chatId: number; mint: string; minLamports: bigint; createdBy: number | null; atMs?: number }): Promise<void> {
  await q.query(
    `INSERT INTO tg_buybots (chat_id, mint, min_lamports, created_by, created_at) VALUES ($1, $2, $3, $4, COALESCE($5, now()))
     ON CONFLICT (chat_id) DO UPDATE SET mint = EXCLUDED.mint, min_lamports = EXCLUDED.min_lamports, created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at`,
    [String(b.chatId), b.mint, dec(b.minLamports), b.createdBy === null ? null : String(b.createdBy), b.atMs === undefined ? null : ts(b.atMs)],
  );
}

export async function getBuybot(q: Queryable, chatId: number): Promise<TgBuybot | null> {
  const res = await q.query("SELECT * FROM tg_buybots WHERE chat_id = $1", [String(chatId)]);
  return res.rows[0] ? mapBuybot(res.rows[0]) : null;
}

export async function removeBuybot(q: Queryable, chatId: number): Promise<boolean> {
  const res = await q.query("DELETE FROM tg_buybots WHERE chat_id = $1 RETURNING chat_id", [String(chatId)]);
  return res.rows.length > 0;
}

export async function buybotsForMint(q: Queryable, mint: string): Promise<TgBuybot[]> {
  const res = await q.query("SELECT * FROM tg_buybots WHERE mint = $1", [mint]);
  return res.rows.map(mapBuybot);
}

export interface HoldBurnRow {
  sig: string;
  /** The Moatpad coin whose vault paid for the burn. */
  mint: string;
  solSpent: bigint;
  /** $MOATPAD base units burned. */
  holdBurned: bigint;
  ts: number;
}

function mapBurn(r: Record<string, unknown>): HoldBurnRow {
  return { sig: r.sig as string, mint: r.mint as string, solSpent: big(r.sol_spent), holdBurned: big(r.hold_burned), ts: ms(r.ts) };
}

export async function insertHoldBurn(q: Queryable, b: HoldBurnRow): Promise<boolean> {
  const res = await q.query(
    `INSERT INTO hold_burns (sig, mint, sol_spent, hold_burned, ts) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (sig, mint) DO NOTHING RETURNING sig`,
    [b.sig, b.mint, dec(b.solSpent), dec(b.holdBurned), ts(b.ts)],
  );
  return res.rows.length > 0;
}

export async function getHoldBurn(q: Queryable, sig: string, mint: string): Promise<HoldBurnRow | null> {
  const res = await q.query("SELECT * FROM hold_burns WHERE sig = $1 AND mint = $2", [sig, mint]);
  return res.rows[0] ? mapBurn(res.rows[0]) : null;
}

export interface BurnTotals {
  count: number;
  solSpent: bigint;
  holdBurned: bigint;
  lastAt: number | null;
}

export async function burnTotals(q: Queryable): Promise<BurnTotals> {
  const res = await q.query("SELECT count(*) AS n, COALESCE(sum(sol_spent), 0) AS sol, COALESCE(sum(hold_burned), 0) AS burned, max(ts) AS last FROM hold_burns");
  const r = res.rows[0] ?? {};
  return { count: num(r.n), solSpent: big(r.sol), holdBurned: big(r.burned), lastAt: r.last ? ms(r.last) : null };
}

export async function recentBurns(q: Queryable, limit: number): Promise<HoldBurnRow[]> {
  const res = await q.query("SELECT * FROM hold_burns ORDER BY ts DESC, sig DESC LIMIT $1", [limit]);
  return res.rows.map(mapBurn);
}
