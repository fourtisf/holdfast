import type { Candle } from "@holdfast/core";
import { describe, expect, it } from "vitest";
import { applyTrade, defendMarkers, floorSeries } from "./chart";

const M = 60_000;
const candles = (n: number, start = 10 * M): Candle[] => Array.from({ length: n }, (_, i) => ({ t: start + i * M, o: 1, h: 1.2, l: 0.9, c: 1.1, v: 2 }));

describe("floorSeries", () => {
  it("snaps the floor to candle buckets as a step line and skips buckets before the first floor", () => {
    const cs = candles(4); // buckets at 10m, 11m, 12m, 13m
    const floor = [
      { t: 11 * M + 30_000, price: 0.5 },
      { t: 13 * M + 10_000, price: 0.7 },
    ];
    expect(floorSeries(cs, floor, "1m")).toEqual([
      { time: (11 * M) / 1000, value: 0.5 },
      { time: (12 * M) / 1000, value: 0.5 },
      { time: (13 * M) / 1000, value: 0.7 },
    ]);
  });
  it("carries in a floor set before the window and applies a higher live floor to the last bucket", () => {
    const cs = candles(2);
    const out = floorSeries(cs, [{ t: 0, price: 0.4 }], "1m", 0.45);
    expect(out.map((p) => p.value)).toEqual([0.4, 0.45]);
  });
  it("never lowers the line for a stale live floor", () => {
    const out = floorSeries(candles(1), [{ t: 0, price: 0.4 }], "1m", 0.3);
    expect(out[0]!.value).toBe(0.4);
  });
});

describe("defendMarkers", () => {
  it("groups buybacks per bucket and ignores ones outside the candle range", () => {
    const cs = candles(10, 0); // 0m..9m, 1m buckets
    const defends = [
      { t: 2 * M + 1000, price: 1, solSpent: 0.5, sig: "a" },
      { t: 2 * M + 40_000, price: 1, solSpent: 0.25, sig: "b" },
      { t: 7 * M, price: 1, solSpent: 1, sig: "c" },
      { t: 20 * M, price: 1, solSpent: 1, sig: "late" },
    ];
    expect(defendMarkers(cs, defends, "1m")).toEqual([
      { time: 120, count: 2, solSpent: 0.75 },
      { time: 420, count: 1, solSpent: 1 },
    ]);
  });
  it("buckets into larger timeframes", () => {
    const cs: Candle[] = [
      { t: 0, o: 1, h: 1, l: 1, c: 1, v: 0 },
      { t: 5 * M, o: 1, h: 1, l: 1, c: 1, v: 0 },
    ];
    const out = defendMarkers(cs, [{ t: 6 * M, price: 1, solSpent: 1, sig: "x" }], "5m");
    expect(out).toEqual([{ time: 300, count: 1, solSpent: 1 }]);
  });
  it("returns nothing without candles", () => {
    expect(defendMarkers([], [{ t: 0, price: 1, solSpent: 1, sig: "x" }], "1m")).toEqual([]);
  });
});

describe("applyTrade", () => {
  it("updates the current bucket", () => {
    const cs = candles(2);
    const result = applyTrade(cs, { ts: 11 * M + 5000, price: 1.5, sol: 3 }, "1m")!;
    expect(result.candles).toHaveLength(2);
    expect(result.candle).toEqual({ t: 11 * M, o: 1, h: 1.5, l: 0.9, c: 1.5, v: 5 });
    expect(cs[1]!.c).toBe(1.1); // input untouched
  });
  it("opens a new bucket from the previous close", () => {
    const result = applyTrade(candles(1), { ts: 12 * M + 1, price: 0.8, sol: 1 }, "1m")!;
    expect(result.candles).toHaveLength(2);
    expect(result.candle).toEqual({ t: 12 * M, o: 1.1, h: 1.1, l: 0.8, c: 0.8, v: 1 });
  });
  it("ignores trades older than the last bucket and invalid prices", () => {
    expect(applyTrade(candles(3), { ts: 10 * M, price: 2, sol: 1 }, "1m")).toBeNull();
    expect(applyTrade(candles(1), { ts: 11 * M, price: 0, sol: 1 }, "1m")).toBeNull();
  });
  it("starts a series from nothing", () => {
    const result = applyTrade([], { ts: 5 * M + 10, price: 2, sol: 1 }, "5m")!;
    expect(result.candles).toEqual([{ t: 5 * M, o: 2, h: 2, l: 2, c: 2, v: 1 }]);
  });
});
