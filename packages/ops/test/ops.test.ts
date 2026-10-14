import { describe, expect, it } from "vitest";

import { Alerter, alerterFromEnv, formatAlert, freshness, Metrics, startOpsServer, type Alert, type AlertSink } from "../src/index.js";

const quiet = { warn: () => {}, error: () => {} };

describe("metrics", () => {
  it("renders counters and gauges in the Prometheus text format", () => {
    const m = new Metrics();
    const sent = m.counter("tx_total", "Transactions sent");
    sent.inc({ action: "defend", ok: true });
    sent.inc({ action: "defend", ok: true }, 2);
    sent.inc({ ok: true, action: "collect" });
    m.gauge("keeper_balance_sol", "Keeper wallet balance").set(1.5);
    m.gauge("label_escape", 'quotes "and" newlines').set(1, { v: 'a"b\nc' });
    const text = m.render();
    expect(text).toContain("# TYPE holdfast_tx_total counter");
    expect(text).toContain('holdfast_tx_total{action="defend",ok="true"} 3');
    expect(text).toContain('holdfast_tx_total{ok="true",action="collect"} 1');
    expect(text).toContain("holdfast_keeper_balance_sol 1.5");
    expect(text).toContain('holdfast_label_escape{v="a\\"b\\nc"} 1');
    expect(sent.get({ ok: true, action: "defend" })).toBe(3); // label order does not matter
    expect(() => sent.inc({}, -1)).toThrow();
    expect(() => m.counter("bad name", "x")).toThrow();
  });
});

describe("ops server", () => {
  it("serves /metrics and /healthz (503 when unhealthy)", async () => {
    const m = new Metrics();
    m.gauge("up", "up").set(1);
    let ok = true;
    const server = await startOpsServer({ port: 0, host: "127.0.0.1", metrics: m, health: () => ({ ok, details: { lag: 3 } }) });
    const base = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(`${base}/metrics`)).text()).toContain("holdfast_up 1");
    const h = await fetch(`${base}/healthz`);
    expect([h.status, await h.json()]).toEqual([200, { ok: true, lag: 3 }]);
    ok = false;
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    await server.close();
  });

  it("freshness is healthy only while the last success is recent", () => {
    expect(freshness(null, 1000, 5000).ok).toBe(false);
    expect(freshness(4500, 1000, 5000).ok).toBe(true);
    expect(freshness(3000, 1000, 5000)).toEqual({ ok: false, details: { lastSuccessAgoMs: 2000 } });
  });
});

describe("alerts", () => {
  it("throttles repeats per key and sends one resolved message", async () => {
    const sent: Alert[] = [];
    const sink: AlertSink = { name: "mem", send: async (a) => void sent.push(a) };
    let now = 0;
    const alerter = new Alerter("keeper", [sink], quiet, { minIntervalMs: 1000, now: () => now });
    expect(await alerter.fire("balance", "critical", "keeper balance low", { sol: 0.01 })).toBe(true);
    now = 500;
    expect(await alerter.fire("balance", "critical", "keeper balance low")).toBe(false);
    now = 1500;
    expect(await alerter.fire("balance", "critical", "keeper balance low")).toBe(true);
    await alerter.resolve("balance", "keeper balance back above threshold");
    await alerter.resolve("balance"); // no second resolved message
    expect(sent.map((a) => [a.key, a.resolved ?? false])).toEqual([
      ["balance", false],
      ["balance", false],
      ["balance", true],
    ]);
    expect(formatAlert(sent[0]!)).toBe("🚨 [keeper] keeper balance low\nsol: 0.01");
  });

  it("builds Telegram and webhook sinks from the environment and survives delivery failures", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchFn = async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      return { ok: !url.includes("broken"), status: url.includes("broken") ? 500 : 200 };
    };
    const a = alerterFromEnv("api", { ALERT_TELEGRAM_BOT_TOKEN: "t0k", ALERT_TELEGRAM_CHAT_ID: "42", ALERT_WEBHOOK_URL: "https://hooks.example/broken" }, quiet, fetchFn);
    expect(a.enabled).toBe(true);
    await a.fire("x", "warning", "something");
    expect(calls.map((c) => c.url)).toEqual(["https://api.telegram.org/bott0k/sendMessage", "https://hooks.example/broken"]);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ chat_id: "42", text: "⚠️ [api] something" });
    expect(JSON.parse(calls[1]!.body)).toMatchObject({ text: "⚠️ [api] something", content: "⚠️ [api] something", key: "x" });
    expect(alerterFromEnv("api", {}, quiet).enabled).toBe(false);
  });
});
