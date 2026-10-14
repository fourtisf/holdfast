import type { Queryable } from "../db.js";
import { big, ms, num, ts } from "../sql.js";
import { mapCoin, type CoinRow } from "./coins.js";

// ---- comments ------------------------------------------------------------------------------------

export interface CommentRow {
  id: number;
  mint: string;
  wallet: string;
  body: string;
  replyTo: number | null;
  signedAt: number;
  signature: string;
  hidden: boolean;
  hiddenReason: string | null;
  createdAt: number;
}

function mapComment(r: Record<string, unknown>): CommentRow {
  return {
    id: num(r.id),
    mint: r.mint as string,
    wallet: r.wallet as string,
    body: r.body as string,
    replyTo: r.reply_to === null || r.reply_to === undefined ? null : num(r.reply_to),
    signedAt: ms(r.signed_at),
    signature: r.signature as string,
    hidden: Boolean(r.hidden),
    hiddenReason: (r.hidden_reason as string | null) ?? null,
    createdAt: ms(r.created_at),
  };
}

/** Null when the signature was already used (replay). */
export async function insertComment(
  q: Queryable,
  c: { mint: string; wallet: string; body: string; replyTo?: number | null; signedAt: number; signature: string; createdAt: number },
): Promise<CommentRow | null> {
  const res = await q.query(
    `INSERT INTO comments (mint, wallet, body, reply_to, signed_at, signature, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (signature) DO NOTHING RETURNING *`,
    [c.mint, c.wallet, c.body, c.replyTo ?? null, ts(c.signedAt), c.signature, ts(c.createdAt)],
  );
  return res.rows[0] ? mapComment(res.rows[0]) : null;
}

export async function getComment(q: Queryable, id: number): Promise<CommentRow | null> {
  const res = await q.query("SELECT * FROM comments WHERE id = $1", [id]);
  return res.rows[0] ? mapComment(res.rows[0]) : null;
}

/** Newest first; `beforeId` pages backwards. */
export async function listComments(q: Queryable, mint: string, opts: { limit: number; beforeId?: number | null }): Promise<CommentRow[]> {
  const params: unknown[] = [mint, opts.limit];
  let where = "mint = $1";
  if (opts.beforeId) {
    params.push(opts.beforeId);
    where += " AND id < $3";
  }
  const res = await q.query(`SELECT * FROM comments WHERE ${where} ORDER BY id DESC LIMIT $2`, params);
  return res.rows.map(mapComment);
}

export async function countRecentComments(q: Queryable, wallet: string, sinceMs: number): Promise<number> {
  const res = await q.query<{ n: string }>("SELECT count(*) AS n FROM comments WHERE wallet = $1 AND created_at >= $2", [wallet, ts(sinceMs)]);
  return num(res.rows[0]?.n);
}

export async function setCommentHidden(q: Queryable, id: number, hidden: boolean, reason: string | null): Promise<boolean> {
  const res = await q.query("UPDATE comments SET hidden = $2, hidden_reason = $3 WHERE id = $1", [id, hidden, hidden ? reason : null]);
  return (res.rowCount ?? 0) > 0;
}

// ---- portfolio -----------------------------------------------------------------------------------

export interface WalletTradeRow {
  sig: string;
  ixIndex: number;
  mint: string;
  ticker: string;
  name: string;
  side: "buy" | "sell" | "vault";
  source: "curve" | "pumpswap" | "vault";
  sol: bigint;
  tokens: bigint;
  price: number;
  decimals: number;
  ts: number;
}

/** A wallet's trades across coins, newest first. */
export async function listWalletTrades(q: Queryable, wallet: string, opts: { limit: number; before?: { ts: number; sig: string; ixIndex: number } | null }): Promise<WalletTradeRow[]> {
  const params: unknown[] = [wallet, opts.limit];
  let where = "t.wallet = $1";
  if (opts.before) {
    params.push(ts(opts.before.ts), opts.before.sig, opts.before.ixIndex);
    where += " AND (t.ts, t.sig, t.ix_index) < ($3, $4, $5)";
  }
  const res = await q.query(
    `SELECT t.sig, t.ix_index, t.mint, t.side, t.source, t.sol, t.tokens, t.price, t.ts, c.ticker, c.name, c.decimals
       FROM trades t JOIN coins c ON c.mint = t.mint
      WHERE ${where} ORDER BY t.ts DESC, t.sig DESC, t.ix_index DESC LIMIT $2`,
    params,
  );
  return res.rows.map((r) => ({
    sig: r.sig as string,
    ixIndex: num(r.ix_index),
    mint: r.mint as string,
    ticker: r.ticker as string,
    name: r.name as string,
    side: r.side as WalletTradeRow["side"],
    source: r.source as WalletTradeRow["source"],
    sol: big(r.sol),
    tokens: big(r.tokens),
    price: num(r.price),
    decimals: num(r.decimals),
    ts: ms(r.ts),
  }));
}

export interface WalletFlow {
  boughtSol: bigint;
  soldSol: bigint;
  boughtTokens: bigint;
  soldTokens: bigint;
  trades: number;
}

/** SOL in / out of a wallet's trades per coin (the basis of its PnL); `mint` limits it to one coin. */
export async function walletFlows(q: Queryable, wallet: string, mint?: string): Promise<Map<string, WalletFlow>> {
  const params: unknown[] = [wallet];
  if (mint) params.push(mint);
  const res = await q.query(
    `SELECT mint,
            COALESCE(sum(sol) FILTER (WHERE side = 'buy'), 0) AS bought_sol,
            COALESCE(sum(sol) FILTER (WHERE side = 'sell'), 0) AS sold_sol,
            COALESCE(sum(tokens) FILTER (WHERE side = 'buy'), 0) AS bought_tokens,
            COALESCE(sum(tokens) FILTER (WHERE side = 'sell'), 0) AS sold_tokens,
            count(*) AS n
       FROM trades WHERE wallet = $1 AND side IN ('buy', 'sell')${mint ? " AND mint = $2" : ""} GROUP BY mint`,
    params,
  );
  return new Map(
    res.rows.map((r) => [
      r.mint as string,
      { boughtSol: big(r.bought_sol), soldSol: big(r.sold_sol), boughtTokens: big(r.bought_tokens), soldTokens: big(r.sold_tokens), trades: num(r.n) },
    ]),
  );
}

// ---- leaderboards --------------------------------------------------------------------------------

export interface EarnerRow {
  wallet: string;
  sol: bigint;
  coins: number;
  payouts: number;
}

/** Wallets by lifetime SOL received from payout rounds. */
export async function topEarners(q: Queryable, limit: number, sinceMs?: number | null): Promise<EarnerRow[]> {
  const params: unknown[] = [limit];
  let since = "";
  if (sinceMs) {
    params.push(ts(sinceMs));
    since = "AND r.ts >= $2";
  }
  const res = await q.query(
    `SELECT p.wallet, sum(p.sol) AS sol, count(DISTINCT p.mint) AS coins, count(*) AS payouts
       FROM payouts p JOIN payout_rounds r ON r.mint = p.mint AND r.round_id = p.round_id
      WHERE p.status = 'confirmed' ${since}
        AND NOT EXISTS (SELECT 1 FROM excluded_wallets e WHERE e.address = p.wallet)
      GROUP BY p.wallet ORDER BY sol DESC, p.wallet LIMIT $1`,
    params,
  );
  return res.rows.map((r) => ({ wallet: r.wallet as string, sol: big(r.sol), coins: num(r.coins), payouts: num(r.payouts) }));
}

export interface DiamondHandRow {
  wallet: string;
  mint: string;
  ticker: string;
  /** Oldest still-open purchase lot. */
  heldSince: number;
  /** Tokens still in open lots of that coin. */
  tokens: bigint;
  decimals: number;
}

/** Longest-standing holders: each wallet's oldest open lot (one row per wallet). */
export async function diamondHands(q: Queryable, limit: number): Promise<DiamondHandRow[]> {
  const res = await q.query(
    `SELECT DISTINCT ON (l.wallet) l.wallet, l.mint, c.ticker, c.decimals, l.acquired_at,
            (SELECT sum(amount_remaining) FROM lots x WHERE x.wallet = l.wallet AND x.mint = l.mint AND x.amount_remaining > 0) AS tokens
       FROM lots l JOIN coins c ON c.mint = l.mint
      WHERE l.amount_remaining > 0 AND NOT c.hidden
        AND NOT EXISTS (SELECT 1 FROM excluded_wallets e WHERE e.address = l.wallet)
      ORDER BY l.wallet, l.acquired_at ASC`,
  );
  return res.rows
    .map((r) => ({ wallet: r.wallet as string, mint: r.mint as string, ticker: r.ticker as string, decimals: num(r.decimals), heldSince: ms(r.acquired_at), tokens: big(r.tokens) }))
    .sort((a, b) => a.heldSince - b.heldSince)
    .slice(0, limit);
}

export interface CreatorSummary {
  wallet: string;
  coins: number;
  /** Lifetime SOL its coins paid to holders. */
  paidToHoldersSol: bigint;
  /** Lifetime creator fees its coins generated. */
  totalFees: bigint;
  firstLaunchAt: number | null;
}

export async function creatorSummary(q: Queryable, wallet: string): Promise<CreatorSummary> {
  const res = await q.query(
    `SELECT count(*) AS coins, COALESCE(sum(v.total_paid_sol), 0) AS paid, COALESCE(sum(v.total_fees), 0) AS fees, min(c.created_at) AS first_at
       FROM coins c LEFT JOIN vault_state v ON v.mint = c.mint WHERE c.creator = $1 AND NOT c.hidden`,
    [wallet],
  );
  const r = res.rows[0] ?? {};
  return { wallet, coins: num(r.coins), paidToHoldersSol: big(r.paid), totalFees: big(r.fees), firstLaunchAt: r.first_at ? ms(r.first_at) : null };
}

/** Top creators by what their coins paid to holders. */
export async function topCreators(q: Queryable, limit: number): Promise<CreatorSummary[]> {
  const res = await q.query(
    `SELECT c.creator AS wallet, count(*) AS coins, COALESCE(sum(v.total_paid_sol), 0) AS paid, COALESCE(sum(v.total_fees), 0) AS fees, min(c.created_at) AS first_at
       FROM coins c LEFT JOIN vault_state v ON v.mint = c.mint
      WHERE c.creator IS NOT NULL AND NOT c.hidden
      GROUP BY c.creator ORDER BY paid DESC, fees DESC, coins DESC LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({ wallet: r.wallet as string, coins: num(r.coins), paidToHoldersSol: big(r.paid), totalFees: big(r.fees), firstLaunchAt: r.first_at ? ms(r.first_at) : null }));
}

export { mapCoin, type CoinRow };
