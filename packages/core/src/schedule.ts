import { ROUND_INTERVAL_SECONDS } from "./constants.js";

/** Rounds start at wall-clock multiples of the interval, so every service agrees on the schedule. */
export function roundSlot(nowMs: number, intervalSec = ROUND_INTERVAL_SECONDS): number {
  return Math.floor(nowMs / (intervalSec * 1000));
}

export function nextRoundAt(nowMs: number, intervalSec = ROUND_INTERVAL_SECONDS): number {
  return (roundSlot(nowMs, intervalSec) + 1) * intervalSec * 1000;
}

export function currentRoundStartedAt(nowMs: number, intervalSec = ROUND_INTERVAL_SECONDS): number {
  return roundSlot(nowMs, intervalSec) * intervalSec * 1000;
}

/** Candle bucket start for a timeframe. */
export const TIMEFRAME_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600 } as const;

export function candleBucket(tsMs: number, tf: keyof typeof TIMEFRAME_SECONDS): number {
  const size = TIMEFRAME_SECONDS[tf] * 1000;
  return Math.floor(tsMs / size) * size;
}
