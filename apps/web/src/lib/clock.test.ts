import { describe, expect, it } from "vitest";
import { computeClockOffset, countdownAt, createRoundClock, msUntilServerTime, nextRoundAfter, serverNow } from "./clock";

const INTERVAL = 120_000;

describe("computeClockOffset", () => {
  it("is zero for synced clocks with no latency", () => {
    expect(computeClockOffset(1000, 1000, 1000)).toBe(0);
  });
  it("compensates half the round trip", () => {
    // Request sent at local 1000, received at local 1200 (RTT 200). Server stamped 5100,
    // i.e. at local ~1100 → server is 4000 ahead.
    expect(computeClockOffset(5100, 1000, 1200)).toBe(4000);
  });
  it("handles a server clock behind the local one", () => {
    expect(computeClockOffset(900, 1000, 1100)).toBe(-150);
  });
});

describe("nextRoundAfter", () => {
  it("returns the anchor while it is still in the future", () => {
    expect(nextRoundAfter(240_000, INTERVAL, 200_000)).toBe(240_000);
  });
  it("rolls forward by whole intervals once the anchor passed", () => {
    expect(nextRoundAfter(240_000, INTERVAL, 240_000)).toBe(360_000);
    expect(nextRoundAfter(240_000, INTERVAL, 359_999)).toBe(360_000);
    expect(nextRoundAfter(240_000, INTERVAL, 1_000_000)).toBe(1_080_000);
  });
  it("rolls backward when the anchor is far in the future", () => {
    expect(nextRoundAfter(1_200_000, INTERVAL, 250_000)).toBe(360_000);
  });
});

describe("countdownAt", () => {
  const schedule = { roundIntervalSec: 120, nextRoundAt: 1_200_000, serverTime: 1_150_000 };

  it("counts down to the server's next round using the offset", () => {
    // local clock is 10s behind the server; no latency.
    const clock = createRoundClock(schedule, 1_140_000, 1_140_000);
    expect(clock.offsetMs).toBe(10_000);
    expect(serverNow(clock, 1_140_000)).toBe(1_150_000);
    const state = countdownAt(clock, 1_140_000);
    expect(state.nextRoundAt).toBe(1_200_000);
    expect(state.remainingMs).toBe(50_000);
    expect(state.progress).toBeCloseTo(70 / 120);
  });

  it("rolls to the next interval when it reaches zero", () => {
    const clock = createRoundClock(schedule, 1_150_000, 1_150_000);
    expect(countdownAt(clock, 1_199_999).remainingMs).toBe(1);
    const after = countdownAt(clock, 1_200_000);
    expect(after.nextRoundAt).toBe(1_320_000);
    expect(after.remainingMs).toBe(INTERVAL);
    expect(countdownAt(clock, 1_200_500).remainingMs).toBe(119_500);
  });

  it("stays aligned across several missed intervals without re-sync", () => {
    const clock = createRoundClock(schedule, 1_150_000, 1_150_000);
    const state = countdownAt(clock, 1_150_000 + 10 * INTERVAL);
    expect((state.nextRoundAt - 1_200_000) % INTERVAL).toBe(0);
    expect(state.remainingMs).toBe(50_000);
  });
});

describe("msUntilServerTime", () => {
  it("converts a server timestamp using the clock offset", () => {
    const clock = createRoundClock({ roundIntervalSec: 120, nextRoundAt: 0, serverTime: 10_000 }, 5000, 5000);
    expect(msUntilServerTime(clock, 70_000, 5000)).toBe(60_000);
    expect(msUntilServerTime(null, 70_000, 10_000)).toBe(60_000);
  });
});
