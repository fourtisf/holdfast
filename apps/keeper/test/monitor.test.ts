import { describe, expect, it } from "vitest";

import type { CrankResult } from "../src/crank.js";
import { Monitor, opsPort } from "../src/monitor.js";

const logs: string[] = [];
const log = { warn: (_: object, m?: string) => void logs.push(`warn ${m}`), error: (_: object, m?: string) => void logs.push(`error ${m}`), info: () => {} };
const res = (over: Partial<CrankResult> = {}): CrankResult => ({ actions: [], sent: [], errors: [], creatorOk: true, ...over });

function monitor() {
  const sent: string[] = [];
  const m = new Monitor({ service: "keeper", lowBalanceLamports: 1_000_000_000n, maxLoopAgeMs: 60_000 }, log, {});
  // capture what would be delivered
  (m.alerter as unknown as { dispatch: (a: { key: string; resolved?: boolean }) => Promise<void> }).dispatch = async (a) => void sent.push(`${a.resolved ? "resolved" : "fired"}:${a.key}`);
  return { m, sent };
}

describe("keeper monitor", () => {
  it("alerts when a coin's pump.fun creator stops being its treasury, and when it is restored", async () => {
    const { m, sent } = monitor();
    await m.crank("MINT", res({ creatorOk: false }));
    expect(m.metrics.render()).toContain("holdfast_creator_mismatch_coins 1");
    await m.crank("MINT", res({ creatorOk: true }));
    expect(sent).toEqual(["fired:creator:MINT", "resolved:creator:MINT"]);
    expect(m.metrics.render()).toContain("holdfast_creator_mismatch_coins 0");
  });

  it("alerts after three consecutive failures of the same action, and on recovery", async () => {
    const { m, sent } = monitor();
    const fail = res({ actions: ["defend"], errors: [{ action: "defend", error: "slippage" }] });
    await m.crank("A", fail);
    await m.crank("A", fail);
    expect(sent).toEqual([]);
    await m.crank("A", fail);
    expect(sent).toEqual(["fired:crank:A:defend"]);
    await m.crank("A", res({ actions: ["defend"], sent: [{ action: "defend", sig: "s" }] }));
    expect(sent).toEqual(["fired:crank:A:defend", "resolved:crank:A:defend"]);
    expect(m.metrics.render()).toContain('holdfast_keeper_actions_total{action="defend",result="error"} 3');
  });

  it("tracks the keeper balance (warning, then critical) and loop freshness", async () => {
    const { m, sent } = monitor();
    await m.keeperBalance(500_000_000n);
    await m.keeperBalance(100_000_000n);
    expect(logs.slice(-2)).toEqual(["warn keeper wallet balance low", "error keeper wallet almost empty: cranks and payouts will stop"]);
    await m.keeperBalance(5_000_000_000n);
    expect(sent).toEqual(["fired:keeper_balance", "resolved:keeper_balance"]); // throttled while firing
    m.loopDone(12);
    expect(m.metrics.render()).toContain("holdfast_coins 12");
  });

  it("parses ops ports", () => {
    expect(opsPort({}, "KEEPER_OPS_PORT", 9101)).toBe(9101);
    expect(opsPort({ KEEPER_OPS_PORT: "0" }, "KEEPER_OPS_PORT", 9101)).toBe(0);
    expect(() => opsPort({ KEEPER_OPS_PORT: "x" }, "KEEPER_OPS_PORT", 9101)).toThrow();
  });
});
