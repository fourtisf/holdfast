import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertLaunch, updateLaunchStatus, type Db } from "@holdfast/db";

import { LauncherMonitor } from "../src/monitor.js";
import { freshDb } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});

async function launch(status: "creating" | "failed", error: string | null = null) {
  const id = randomUUID();
  await insertLaunch(db, { id, form: { name: "X", ticker: "X", triggerBps: 2500 }, depositAddress: randomUUID(), depositIndex: BigInt(Math.floor(Math.random() * 1e9)), requiredLamports: 1n, devBuyLamports: 0n, expiresAt: Date.now() + 1e6 });
  await updateLaunchStatus(db, id, status, { error }, ["awaiting_deposit"]);
  return id;
}

describe("launcher monitor", () => {
  it("exports launches by status, alerts on stuck and newly failed launches", async () => {
    const sent: string[] = [];
    let now = Date.now();
    const m = new LauncherMonitor(db, { warn: () => {}, error: () => {} }, { stuckAfterMs: 60_000, maxTickAgeMs: 60_000 }, {}, () => now);
    (m.alerter as unknown as { dispatch: (a: { key: string; resolved?: boolean }) => Promise<void> }).dispatch = async (a) => void sent.push(`${a.resolved ? "resolved" : "fired"}:${a.key}`);

    await launch("failed", "old failure"); // failed before the process started: no alert
    const creating = await launch("creating");
    await m.tickDone();
    expect(m.metrics.render()).toContain('holdfast_launches{status="creating"} 1');
    expect(sent).toEqual([]);

    now += 120_000; // the creating launch has not moved for 2 minutes
    const failed = await launch("failed", "create: rpc down");
    await m.tickDone();
    expect(sent).toEqual(["fired:launches_stuck", `fired:launch_failed:${failed}`]);

    await updateLaunchStatus(db, creating, "live", {}, ["creating"]);
    await m.tickDone();
    expect(sent.at(-1)).toBe("resolved:launches_stuck");
  });
});
