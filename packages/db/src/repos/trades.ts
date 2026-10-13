import type { TradeSide } from "@holdfast/core";
import type { Queryable } from "../db.js";
import { big, dec, ms, num, ts } from "../sql.js";

export type TradeSource = "curve" | "pumpswap" | "vault";

export interface TradeRow {
  sig: string;
  ixIndex: number;
  mint: string;
  wallet: string;
  side: TradeSide;
  /** Lamports. */
  sol: bigint;
  /** Token base units. */
  tokens: bigint;
  /** SOL per whole token. */
  price: number;
  ts: number;
  slot: number;
  source: TradeSource;
}

export interface TradeCursor {
  ts: number;
  sig: string;
  ixIndex: number;
}

function mapTrade(r: Record<string, unknown>): TradeRow {
  return {
    sig: r.sig as string,
    ixIndex: num(r.ix_index),
    mint: r.mint as string,
    wallet: r.wallet as string,
    side: r.side as TradeSide,
    sol: big(r.sol),
    tokens: big(r.tokens),
    price: num(r.price),
    ts: ms(r.ts),
    slot: num(r.slot),
    source: r.source as TradeSource,
  };
}

const COLUMNS = "sig, ix_index, mint, wallet, side, sol, tokens, price, ts, slot, source";

/** Returns false when the trade (sig, ix_index) was already recorded. */
export async function insertTrade(q: Queryable, t: TradeRow): Promise<boolean> {
  const res = await q.query(
    `INSERT INTO trades (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (sig, ix_index) DO NOTHING RETURNING sig`,
    [t.sig, t.ixIndex, t.mint, t.wallet, t.side, dec(t.sol), dec(t.tokens), t.price, ts(t.ts), t.slot, t.source],
  );
  return res.rows.length > 0;
}

/** Newest first; `before` is the last item of the previous page. */
export async function listTrades(q: Queryable, mint: string, opts: { limit: number; before?: TradeCursor | null }): Promise<TradeRow[]> {
  const params: unknown[] = [mint, opts.limit];
  let where = "mint = $1";
  if (opts.before) {
    params.push(ts(opts.before.ts), opts.before.sig, opts.before.ixIndex);
    where += " AND (ts, sig, ix_index) < ($3, $4, $5)";
  }
  const res = await q.query(
    `SELECT ${COLUMNS} FROM trades WHERE ${where} ORDER BY ts DESC, sig DESC, ix_index DESC LIMIT $2`,
    params,
  );
  return res.rows.map(mapTrade);
}

export async function getTradesBySig(q: Queryable, sig: string): Promise<TradeRow[]> {
  const res = await q.query(`SELECT ${COLUMNS} FROM trades WHERE sig = $1 ORDER BY ix_index`, [sig]);
  return res.rows.map(mapTrade);
}

export async function latestTradePrice(q: Queryable, mint: string): Promise<number | null> {
  const res = await q.query<{ price: number }>("SELECT price FROM trades WHERE mint = $1 ORDER BY ts DESC, slot DESC, ix_index DESC LIMIT 1", [mint]);
  return res.rows[0] ? num(res.rows[0].price) : null;
}
