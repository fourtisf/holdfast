import { TIMEFRAME_SECONDS, candleBucket, type Candle, type CandleTimeframe, type CandlesResponse, type Trade } from "@holdfast/core";

/** Chart-library-agnostic points (time in unix seconds, as lightweight-charts expects). */
export interface LinePoint {
  time: number;
  value: number;
}

export interface DefendMarker {
  time: number;
  count: number;
  solSpent: number;
}

export function bucketMs(tf: CandleTimeframe): number {
  return TIMEFRAME_SECONDS[tf] * 1000;
}

/**
 * Snap the floor step-line onto candle buckets: each candle gets the floor in force at its close.
 * Buckets before the first floor point are skipped. `liveFloor` (from the vault snapshot) overrides the
 * last bucket so the line tracks floor raises between candle refreshes.
 */
export function floorSeries(candles: readonly Candle[], floorLine: CandlesResponse["floorLine"], tf: CandleTimeframe, liveFloor?: number): LinePoint[] {
  const size = bucketMs(tf);
  const points = [...floorLine].sort((a, b) => a.t - b.t);
  const out: LinePoint[] = [];
  let i = 0;
  let current: number | null = null;
  for (const candle of candles) {
    const close = candle.t + size;
    while (i < points.length && points[i]!.t < close) {
      current = points[i]!.price;
      i++;
    }
    if (current !== null && current > 0) out.push({ time: candle.t / 1000, value: current });
  }
  const last = out[out.length - 1];
  if (last && liveFloor && liveFloor > 0) last.value = Math.max(last.value, liveFloor);
  return out;
}

/** Group vault buybacks into the candle bucket they happened in (one "V" marker per bucket). */
export function defendMarkers(candles: readonly Candle[], defends: CandlesResponse["defends"], tf: CandleTimeframe): DefendMarker[] {
  if (candles.length === 0) return [];
  const first = candles[0]!.t;
  const last = candles[candles.length - 1]!.t + bucketMs(tf);
  const byBucket = new Map<number, DefendMarker>();
  for (const d of defends) {
    if (d.t < first || d.t >= last) continue;
    const t = candleBucket(d.t, tf);
    const existing = byBucket.get(t);
    if (existing) {
      existing.count += 1;
      existing.solSpent += d.solSpent;
    } else {
      byBucket.set(t, { time: t / 1000, count: 1, solSpent: d.solSpent });
    }
  }
  return [...byBucket.values()].sort((a, b) => a.time - b.time);
}

/**
 * Fold a live trade into the candle list. Returns the updated array (new reference) and the touched
 * candle, or `null` for an invalid price. A trade that arrives late (older than the last bucket, or
 * `late`: older than a trade already applied) is merged into its own bucket without touching that
 * bucket's open or close.
 */
export function applyTrade(
  candles: readonly Candle[],
  trade: Pick<Trade, "ts" | "price" | "sol">,
  tf: CandleTimeframe,
  late = false,
): { candles: Candle[]; candle: Candle } | null {
  if (!(trade.price > 0)) return null;
  const t = candleBucket(trade.ts, tf);
  const last = candles[candles.length - 1];
  if (last && (t < last.t || (late && t === last.t))) {
    let i = candles.length - 1;
    while (i > 0 && candles[i]!.t > t) i--;
    const at = candles[i]!;
    if (at.t === t) {
      const candle: Candle = { ...at, h: Math.max(at.h, trade.price), l: Math.min(at.l, trade.price), v: at.v + trade.sol };
      return { candles: [...candles.slice(0, i), candle, ...candles.slice(i + 1)], candle };
    }
    // No bucket yet: insert one after the latest earlier candle (or first, if none is earlier).
    const before = at.t < t ? at : null;
    const open = before ? before.c : trade.price;
    const candle: Candle = { t, o: open, h: Math.max(open, trade.price), l: Math.min(open, trade.price), c: trade.price, v: trade.sol };
    const pos = before ? i + 1 : 0;
    return { candles: [...candles.slice(0, pos), candle, ...candles.slice(pos)], candle };
  }
  if (last && t === last.t) {
    const candle: Candle = {
      ...last,
      h: Math.max(last.h, trade.price),
      l: Math.min(last.l, trade.price),
      c: trade.price,
      v: last.v + trade.sol,
    };
    return { candles: [...candles.slice(0, -1), candle], candle };
  }
  const open = last ? last.c : trade.price;
  const candle: Candle = {
    t,
    o: open,
    h: Math.max(open, trade.price),
    l: Math.min(open, trade.price),
    c: trade.price,
    v: trade.sol,
  };
  return { candles: [...candles, candle], candle };
}

/** A bucket without trades, drawn flat at the previous close so the time axis keeps moving. */
export function isFiller(c: Candle): boolean {
  return c.v === 0;
}

/**
 * Continuous time axis: insert a flat candle (the previous close, no volume) for every bucket without
 * trades, between candles and from the last one up to the bucket of `now`. Only the newest `maxBars`
 * are returned, so a long idle stretch costs no more than a full chart.
 */
export function fillGaps(candles: readonly Candle[], tf: CandleTimeframe, now: number, maxBars = 1500): Candle[] {
  if (candles.length === 0) return [];
  const size = bucketMs(tf);
  const out: Candle[] = [];
  // Newest first: buckets after candle i (up to `next`) are flat at its close.
  let next = Math.max(candles[candles.length - 1]!.t, candleBucket(now, tf));
  for (let i = candles.length - 1; i >= 0 && out.length < maxBars; i--) {
    const c = candles[i]!;
    for (let t = next; t > c.t && out.length < maxBars; t -= size) out.push({ t, o: c.c, h: c.c, l: c.c, c: c.c, v: 0 });
    if (out.length < maxBars) out.push(c);
    next = c.t - size;
  }
  return out.reverse();
}
