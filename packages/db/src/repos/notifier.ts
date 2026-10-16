import type { Lot } from "@holdfast/core";
import type { Queryable } from "../db.js";
import type { HoldfastNotification } from "../notify.js";
import { big, likeEscape, lotId, ms, num, ts } from "../sql.js";

/** Telegram notifier state (apps/notifier): subscriptions, the getUpdates offset, sent-message log. */

export type SubscriptionKind = "wallet" | "coin";

export interface Subscription {
  /** Telegram chat id (fits in 52 bits, so a JS number is exact). */
  chatId: number;
  kind: SubscriptionKind;
  /** Base58 wallet address or mint. */
  target: string;
  createdAt: number;
  /** Forum topic its alerts go to (where /follow or /watch was sent); null: the General topic, or a chat without topics. */
  threadId: number | null;
}

/** A chat following some target, since when, and the forum topic its alerts go to. */
export interface Watcher {
  chatId: number;
  createdAt: number;
  threadId: number | null;
}

/** "moved": the chat already followed `target`, and its alerts now go to the topic of this request. */
export type SubscribeResult = "added" | "exists" | "moved" | "limit";

function threadOf(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

function mapSubscription(r: Record<string, unknown>): Subscription {
  return { chatId: num(r.chat_id), kind: r.kind as SubscriptionKind, target: r.target as string, createdAt: ms(r.created_at), threadId: threadOf(r.thread_id) };
}

/**
 * Follow `target` from `chatId` (`threadId`: the forum topic its alerts go to). With `limit`, a chat that
 * already has that many subscriptions gets "limit" instead. Following again from another topic moves the
 * alerts there ("moved"). Commands of one chat are handled one at a time, so check-then-insert is enough.
 */
export async function addSubscription(
  q: Queryable,
  sub: { chatId: number; kind: SubscriptionKind; target: string; atMs?: number; threadId?: number | null },
  opts: { limit?: number } = {},
): Promise<SubscribeResult> {
  const chat = String(sub.chatId);
  const threadId = sub.threadId ?? null;
  const thread = threadId === null ? null : String(threadId);
  const existing = await q.query("SELECT thread_id FROM tg_subscriptions WHERE chat_id = $1 AND kind = $2 AND target = $3", [chat, sub.kind, sub.target]);
  const row = existing.rows[0];
  if (row) {
    if (sub.threadId === undefined || threadOf(row.thread_id) === threadId) return "exists";
    await q.query("UPDATE tg_subscriptions SET thread_id = $4 WHERE chat_id = $1 AND kind = $2 AND target = $3", [chat, sub.kind, sub.target, thread]);
    return "moved";
  }
  if (opts.limit !== undefined && (await countChatSubscriptions(q, sub.chatId)) >= opts.limit) return "limit";
  const res = await q.query(
    `INSERT INTO tg_subscriptions (chat_id, kind, target, created_at, thread_id) VALUES ($1, $2, $3, COALESCE($4, now()), $5)
     ON CONFLICT (chat_id, kind, target) DO NOTHING RETURNING chat_id`,
    [chat, sub.kind, sub.target, sub.atMs === undefined ? null : ts(sub.atMs), thread],
  );
  return res.rows.length > 0 ? "added" : "exists";
}

/** Returns false when the chat was not following `target`. */
export async function removeSubscription(q: Queryable, chatId: number, kind: SubscriptionKind, target: string): Promise<boolean> {
  const res = await q.query("DELETE FROM tg_subscriptions WHERE chat_id = $1 AND kind = $2 AND target = $3 RETURNING chat_id", [String(chatId), kind, target]);
  return res.rows.length > 0;
}

/** Everything a chat follows is dropped (/stop, or the bot was blocked). Returns how many. */
export async function removeChatSubscriptions(q: Queryable, chatId: number): Promise<number> {
  const res = await q.query("DELETE FROM tg_subscriptions WHERE chat_id = $1 RETURNING chat_id", [String(chatId)]);
  return res.rows.length;
}

/** Wallets first, then coins, oldest first. */
export async function listChatSubscriptions(q: Queryable, chatId: number): Promise<Subscription[]> {
  const res = await q.query(
    "SELECT chat_id, kind, target, created_at, thread_id FROM tg_subscriptions WHERE chat_id = $1 ORDER BY kind DESC, created_at, target",
    [String(chatId)],
  );
  return res.rows.map(mapSubscription);
}

export async function countChatSubscriptions(q: Queryable, chatId: number): Promise<number> {
  const res = await q.query<{ n: string }>("SELECT count(*) AS n FROM tg_subscriptions WHERE chat_id = $1", [String(chatId)]);
  return num(res.rows[0]?.n);
}

/** Chats watching each of `wallets` (wallets nobody watches are absent). */
export async function chatsWatchingWallets(q: Queryable, wallets: readonly string[]): Promise<Map<string, Watcher[]>> {
  const out = new Map<string, Watcher[]>();
  if (wallets.length === 0) return out;
  const res = await q.query(
    "SELECT chat_id, target, created_at, thread_id FROM tg_subscriptions WHERE kind = 'wallet' AND target = ANY($1::text[]) ORDER BY target, chat_id",
    [[...new Set(wallets)]],
  );
  for (const r of res.rows) {
    const wallet = r.target as string;
    const list = out.get(wallet) ?? [];
    list.push({ chatId: num(r.chat_id), createdAt: ms(r.created_at), threadId: threadOf(r.thread_id) });
    out.set(wallet, list);
  }
  return out;
}

export async function chatsWatchingWallet(q: Queryable, wallet: string): Promise<Watcher[]> {
  return (await chatsWatchingWallets(q, [wallet])).get(wallet) ?? [];
}

export async function chatsWatchingCoin(q: Queryable, mint: string): Promise<Watcher[]> {
  const res = await q.query("SELECT chat_id, created_at, thread_id FROM tg_subscriptions WHERE kind = 'coin' AND target = $1 ORDER BY chat_id", [mint]);
  return res.rows.map((r) => ({ chatId: num(r.chat_id), createdAt: ms(r.created_at), threadId: threadOf(r.thread_id) }));
}

export async function countSubscriptionsByKind(q: Queryable): Promise<Record<SubscriptionKind, number>> {
  const res = await q.query("SELECT kind, count(*) AS n FROM tg_subscriptions GROUP BY kind");
  const out: Record<SubscriptionKind, number> = { wallet: 0, coin: 0 };
  for (const r of res.rows) out[r.kind as SubscriptionKind] = num(r.n);
  return out;
}

/** Every wallet subscription (weight-milestone sweep). */
export async function listWalletSubscriptions(q: Queryable): Promise<Subscription[]> {
  const res = await q.query("SELECT chat_id, kind, target, created_at, thread_id FROM tg_subscriptions WHERE kind = 'wallet' ORDER BY target, chat_id");
  return res.rows.map(mapSubscription);
}

// ---- bot state ---------------------------------------------------------------------------------

const OFFSET_KEY = "telegram_update_offset";

export async function getTgState(q: Queryable, key: string): Promise<string | null> {
  const res = await q.query<{ value: string }>("SELECT value FROM tg_state WHERE key = $1", [key]);
  return res.rows[0]?.value ?? null;
}

export async function setTgState(q: Queryable, key: string, value: string): Promise<void> {
  await q.query("INSERT INTO tg_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, value]);
}

/** Next getUpdates offset (last handled update_id + 1); 0 before the first update. */
export async function getTelegramOffset(q: Queryable): Promise<number> {
  const v = await getTgState(q, OFFSET_KEY);
  return v === null ? 0 : Number(v);
}

export async function setTelegramOffset(q: Queryable, offset: number): Promise<void> {
  await setTgState(q, OFFSET_KEY, String(offset));
}

// ---- idempotency -------------------------------------------------------------------------------

/**
 * Claim `eventKey` for `chatId`. False when it was already claimed: the message must not be sent.
 * `sentAs`: keys the same message was claimed under before (an older key format); a claim of any of them
 * counts as a claim of `eventKey` (and none is made).
 */
export async function markSent(q: Queryable, chatId: number, eventKey: string, sentAs: readonly string[] = []): Promise<boolean> {
  const res =
    sentAs.length === 0
      ? await q.query("INSERT INTO tg_sent (chat_id, event_key) VALUES ($1, $2) ON CONFLICT (chat_id, event_key) DO NOTHING RETURNING chat_id", [String(chatId), eventKey])
      : await q.query(
          `INSERT INTO tg_sent (chat_id, event_key)
           SELECT $1::bigint, $2::text WHERE NOT EXISTS (SELECT 1 FROM tg_sent WHERE chat_id = $1::bigint AND event_key = ANY($3::text[]))
           ON CONFLICT (chat_id, event_key) DO NOTHING RETURNING chat_id`,
          [String(chatId), eventKey, [...sentAs]],
        );
  return res.rows.length > 0;
}

/** Which of `eventKeys` are claimed for `chatId`. */
export async function sentKeys(q: Queryable, chatId: number, eventKeys: readonly string[]): Promise<Set<string>> {
  if (eventKeys.length === 0) return new Set();
  const res = await q.query("SELECT event_key FROM tg_sent WHERE chat_id = $1 AND event_key = ANY($2::text[])", [String(chatId), [...new Set(eventKeys)]]);
  return new Set(res.rows.map((r) => r.event_key as string));
}

/** Release a claim whose message could not be delivered, so a later attempt may send it. */
export async function unmarkSent(q: Queryable, chatId: number, eventKey: string): Promise<void> {
  await q.query("DELETE FROM tg_sent WHERE chat_id = $1 AND event_key = $2", [String(chatId), eventKey]);
}

/**
 * Forget claims older than `beforeMs`, except keys starting with one of `keepPrefixes` (claims that
 * must last forever, like weight milestones). Only safe for events too old to be announced again.
 */
export async function pruneSent(q: Queryable, beforeMs: number, keepPrefixes: readonly string[] = []): Promise<number> {
  const res = await q.query("DELETE FROM tg_sent WHERE sent_at < $1 AND NOT (event_key LIKE ANY($2::text[])) RETURNING chat_id", [
    ts(beforeMs),
    keepPrefixes.map((p) => `${likeEscape(p)}%`),
  ]);
  return res.rows.length;
}

// ---- reads for notifications --------------------------------------------------------------------

/** Open lots of `wallets` (excluded addresses left out): wallet → mint → lots, oldest first. */
export async function openLotsByWallet(q: Queryable, wallets: readonly string[]): Promise<Map<string, Map<string, Lot[]>>> {
  const out = new Map<string, Map<string, Lot[]>>();
  if (wallets.length === 0) return out;
  const res = await q.query(
    `SELECT l.wallet, l.mint, l.id, l.amount_remaining, l.acquired_at FROM lots l
     WHERE l.wallet = ANY($1::text[]) AND l.amount_remaining > 0
       AND NOT EXISTS (SELECT 1 FROM excluded_wallets e WHERE e.address = l.wallet)
     ORDER BY l.wallet, l.mint, l.acquired_at, l.id`,
    [[...new Set(wallets)]],
  );
  for (const r of res.rows) {
    const wallet = r.wallet as string;
    const mint = r.mint as string;
    let byMint = out.get(wallet);
    if (!byMint) {
      byMint = new Map();
      out.set(wallet, byMint);
    }
    const lots = byMint.get(mint) ?? [];
    lots.push({ id: lotId(r.id), amount: big(r.amount_remaining), acquiredAt: ms(r.acquired_at) });
    byMint.set(mint, lots);
  }
  return out;
}

/**
 * Notifications the notifier may have missed while it was down: rounds closed, vault buybacks,
 * graduations, status changes of launches started from Telegram and $MOATPAD burns since `sinceMs`,
 * and with `buysSinceMs` the buys since then (buy alerts are only posted while fresh).
 * Replaying them is safe because every message is claimed in tg_sent.
 */
export async function recentNotifierEvents(q: Queryable, sinceMs: number, opts: { buysSinceMs?: number } = {}): Promise<HoldfastNotification[]> {
  const since = ts(sinceMs);
  const buysSince = opts.buysSinceMs === undefined ? null : ts(Math.max(sinceMs, opts.buysSinceMs));
  const rounds = await q.query("SELECT mint, round_id FROM payout_rounds WHERE status = 'closed' AND ts >= $1 ORDER BY ts, mint, round_id", [since]);
  const trades = await q.query(
    `SELECT mint, sig, min(ts) AS ts FROM trades
     WHERE (side = 'vault' AND ts >= $1) OR (side = 'buy' AND $2::timestamptz IS NOT NULL AND ts >= $2::timestamptz)
     GROUP BY mint, sig ORDER BY min(ts), sig`,
    [since, buysSince],
  );
  const coins = await q.query("SELECT mint FROM coins WHERE graduated AND graduated_at >= $1 ORDER BY graduated_at, mint", [since]);
  // launch_id is text (no cast that a bad row could break): compare as text.
  const launches = await q.query(
    "SELECT t.launch_id FROM tg_launches t JOIN launches l ON l.id::text = t.launch_id WHERE l.updated_at >= $1 ORDER BY l.updated_at, t.launch_id",
    [since],
  );
  const burns = await q.query("SELECT mint, sig FROM hold_burns WHERE ts >= $1 ORDER BY ts, sig, mint", [since]);
  return [
    ...rounds.rows.map((r): HoldfastNotification => ({ kind: "round", mint: r.mint as string, roundId: num(r.round_id) })),
    ...trades.rows.map((r): HoldfastNotification => ({ kind: "trade", mint: r.mint as string, sig: r.sig as string })),
    ...coins.rows.map((r): HoldfastNotification => ({ kind: "coin", mint: r.mint as string })),
    ...launches.rows.map((r): HoldfastNotification => ({ kind: "launch", launchId: r.launch_id as string })),
    ...burns.rows.map((r): HoldfastNotification => ({ kind: "burn", mint: r.mint as string, sig: r.sig as string })),
  ];
}
