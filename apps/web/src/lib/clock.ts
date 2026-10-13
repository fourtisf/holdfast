import type { Schedule } from "@holdfast/core";

/**
 * Server-synchronised round clock for the payout countdown.
 *
 * The server's schedule is sampled with a request; the round-trip is split evenly so
 * `serverNow ≈ Date.now() + offsetMs`. Rounds start at multiples of the interval, so once the known
 * `nextRoundAt` has passed the clock rolls forward by whole intervals without another request.
 */
export interface RoundClock {
  /** serverTime − localTime, in ms. */
  offsetMs: number;
  intervalMs: number;
  /** A known round start on the server clock (any past or future one). */
  anchorRoundAt: number;
}

/** Offset between server and local clocks from one request, compensating half the RTT. */
export function computeClockOffset(serverTime: number, requestStartedAt: number, responseReceivedAt: number): number {
  const rtt = Math.max(0, responseReceivedAt - requestStartedAt);
  return serverTime + rtt / 2 - responseReceivedAt;
}

export function createRoundClock(schedule: Schedule, requestStartedAt: number, responseReceivedAt: number): RoundClock {
  return {
    offsetMs: computeClockOffset(schedule.serverTime, requestStartedAt, responseReceivedAt),
    intervalMs: Math.max(1, schedule.roundIntervalSec) * 1000,
    anchorRoundAt: schedule.nextRoundAt,
  };
}

export function serverNow(clock: RoundClock, localNow: number): number {
  return localNow + clock.offsetMs;
}

/** First round start strictly after `serverNowMs`, rolling the anchor forward/backward by whole intervals. */
export function nextRoundAfter(anchorRoundAt: number, intervalMs: number, serverNowMs: number): number {
  const elapsed = serverNowMs - anchorRoundAt;
  const steps = Math.floor(elapsed / intervalMs) + 1;
  return anchorRoundAt + steps * intervalMs;
}

export interface CountdownState {
  /** Next round start (server clock). */
  nextRoundAt: number;
  /** ms until the next round, in (0, intervalMs]. */
  remainingMs: number;
  /** Elapsed fraction of the current interval, 0..1. */
  progress: number;
}

export function countdownAt(clock: RoundClock, localNow: number): CountdownState {
  const now = serverNow(clock, localNow);
  const next = nextRoundAfter(clock.anchorRoundAt, clock.intervalMs, now);
  const remainingMs = next - now;
  return { nextRoundAt: next, remainingMs, progress: 1 - remainingMs / clock.intervalMs };
}

/** Convert a server-clock timestamp (e.g. a launch's expiresAt) to ms remaining on the local clock. */
export function msUntilServerTime(clock: RoundClock | null, serverTs: number, localNow: number): number {
  return serverTs - (localNow + (clock?.offsetMs ?? 0));
}
