import type { Candle } from "@holdfast/core";
import { describe, expect, it } from "vitest";
import { applyTrade, defendMarkers, fillGaps, floorSeries, isFiller } from "./chart";

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
  it("merges a late trade into its own bucket without moving that bucket's open or close", () => {
    const cs = candles(3); // buckets 10, 11, 12
    const result = applyTrade(cs, { ts: 10 * M + 30_000, price: 2, sol: 1 }, "1m")!;
    expect(result.candles).toHaveLength(3);
    expect(result.candles[0]).toEqual({ ...cs[0]!, h: 2, v: cs[0]!.v + 1 });
    expect(result.candles.slice(1)).toEqual(cs.slice(1));
  });
  it("inserts a bucket for a late trade that has none, in time order", () => {
    const cs = [candles(1)[0]!, { t: 13 * M, o: 1, h: 1, l: 1, c: 1, v: 1 }];
    const mid = applyTrade(cs, { ts: 11 * M + 1, price: 0.5, sol: 2 }, "1m")!;
    expect(mid.candles.map((c) => c.t)).toEqual([10 * M, 11 * M, 13 * M]);
    expect(mid.candle).toEqual({ t: 11 * M, o: cs[0]!.c, h: cs[0]!.c, l: 0.5, c: 0.5, v: 2 });
    const first = applyTrade(cs, { ts: 9 * M, price: 3, sol: 1 }, "1m")!;
    expect(first.candles.map((c) => c.t)).toEqual([9 * M, 10 * M, 13 * M]);
    expect(first.candle).toEqual({ t: 9 * M, o: 3, h: 3, l: 3, c: 3, v: 1 });
  });
  it("a trade older than one already applied (late) merges without moving the close", () => {
    const cs = candles(2);
    const result = applyTrade(cs, { ts: 11 * M + 5000, price: 1.5, sol: 3 }, "1m", true)!;
    expect(result.candle).toEqual({ ...cs[1]!, h: 1.5, v: cs[1]!.v + 3 });
  });
  it("ignores invalid prices", () => {
    expect(applyTrade(candles(1), { ts: 11 * M, price: 0, sol: 1 }, "1m")).toBeNull();
  });
  it("starts a series from nothing", () => {
    const result = applyTrade([], { ts: 5 * M + 10, price: 2, sol: 1 }, "5m")!;
    expect(result.candles).toEqual([{ t: 5 * M, o: 2, h: 2, l: 2, c: 2, v: 1 }]);
  });
});

describe("fillGaps", () => {
  const k = (t: number, c: number, v = 1) => ({ t: t * M, o: c, h: c, l: c, c, v });
  it("fills idle buckets flat at the previous close, up to the current bucket", () => {
    const out = fillGaps([k(10, 1), k(13, 2)], "1m", 15 * M + 20_000);
    expect(out.map((c) => c.t / M)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(out[1]).toEqual({ t: 11 * M, o: 1, h: 1, l: 1, c: 1, v: 0 });
    expect(out[5]).toEqual({ t: 15 * M, o: 2, h: 2, l: 2, c: 2, v: 0 });
    expect(out.filter(isFiller).map((c) => c.t / M)).toEqual([11, 12, 14, 15]);
  });
  it("never drops candles ahead of the local clock, and returns nothing without candles", () => {
    expect(fillGaps([k(10, 1), k(12, 2)], "1m", 5 * M).map((c) => c.t / M)).toEqual([10, 11, 12]);
    expect(fillGaps([], "1m", 5 * M)).toEqual([]);
  });
  it("keeps only the newest bars", () => {
    const out = fillGaps([k(0, 1), k(100, 2)], "1m", 200 * M, 50);
    expect(out).toHaveLength(50);
    expect(out[0]!.t).toBe(151 * M);
    expect(out[49]!.t).toBe(200 * M);
    expect(fillGaps([k(0, 1), k(1, 2), k(2, 3)], "1m", 2 * M, 2).map((c) => c.t / M)).toEqual([1, 2]);
  });
  it("works on larger timeframes", () => {
    const H = 60 * M;
    const out = fillGaps([{ t: 0, o: 1, h: 1, l: 1, c: 1, v: 1 }], "1h", 3 * H + 5);
    expect(out.map((c) => c.t / H)).toEqual([0, 1, 2, 3]);
  });
});
