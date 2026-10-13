import { candleBucket, type CandleTimeframe } from "@holdfast/core";
import type { Queryable } from "../db.js";
import { big, dec, ms, num, ts } from "../sql.js";

export const TIMEFRAMES: readonly CandleTimeframe[] = ["1m", "5m", "15m", "1h"];

export interface CandleRow {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Lamports. */
  volume: bigint;
  trades: number;
}

export interface CandleTick {
  mint: string;
  /** Trade time, unix ms. */
  ts: number;
  price: number;
  /** Lamports traded. */
  volume: bigint;
  /** Chain order of the trade, keeps open/close right when trades arrive out of order. */
  slot: number;
}

/** Fold one trade into the 1m/5m/15m/1h candles. */
export async function upsertCandles(q: Queryable, tick: CandleTick): Promise<void> {
  const params: unknown[] = [tick.mint, tick.price, dec(tick.volume), tick.slot];
  const values = TIMEFRAMES.map((tf, i) => {
    params.push(tf, ts(candleBucket(tick.ts, tf)));
    const tfParam = 5 + i * 2;
    return `($1, $${tfParam}, $${tfParam + 1}, $2, $2, $2, $2, $3::numeric, $4::bigint, $4::bigint, 1)`;
  });
  await q.query(
    `INSERT INTO price_candles AS pc (mint, tf, ts, open, high, low, close, volume, open_slot, close_slot, trades)
     VALUES ${values.join(", ")}
     ON CONFLICT (mint, tf, ts) DO UPDATE SET
       high = GREATEST(pc.high, EXCLUDED.high),
       low = LEAST(pc.low, EXCLUDED.low),
       open = CASE WHEN EXCLUDED.open_slot < pc.open_slot THEN EXCLUDED.open ELSE pc.open END,
       open_slot = LEAST(pc.open_slot, EXCLUDED.open_slot),
       close = CASE WHEN EXCLUDED.close_slot >= pc.close_slot THEN EXCLUDED.close ELSE pc.close END,
       close_slot = GREATEST(pc.close_slot, EXCLUDED.close_slot),
       volume = pc.volume + EXCLUDED.volume,
       trades = pc.trades + 1`,
    params,
  );
}

export async function listCandles(
  q: Queryable,
  mint: string,
  tf: CandleTimeframe,
  opts: { from?: number; to?: number; limit: number },
): Promise<CandleRow[]> {
  const params: unknown[] = [mint, tf, opts.limit];
  const conds = ["mint = $1", "tf = $2"];
  if (opts.from !== undefined) {
    params.push(ts(opts.from));
    conds.push(`ts >= $${params.length}`);
  }
  if (opts.to !== undefined) {
    params.push(ts(opts.to));
    conds.push(`ts <= $${params.length}`);
  }
  // Latest `limit` buckets in range, returned oldest first.
  const res = await q.query(
    `SELECT * FROM (
       SELECT ts, open, high, low, close, volume, trades FROM price_candles
       WHERE ${conds.join(" AND ")} ORDER BY ts DESC LIMIT $3
     ) recent ORDER BY ts ASC`,
    params,
  );
  return res.rows.map((r) => ({
    ts: ms(r.ts),
    open: num(r.open),
    high: num(r.high),
    low: num(r.low),
    close: num(r.close),
    volume: big(r.volume),
    trades: num(r.trades),
  }));
}
