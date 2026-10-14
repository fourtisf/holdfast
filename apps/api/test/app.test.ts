import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@holdfast/db";
import { loadConfig } from "../src/index.js";
import { freshDb, makeApi, type TestApi } from "./helpers.js";

let db: Db;
let api: TestApi;

beforeAll(async () => {
  db = await freshDb();
  api = await makeApi(db, { rateLimitPerMinute: 3, corsOrigin: "http://localhost:3000,https://holdfast.example" });
});
afterAll(async () => {
  await api.app.close();
  await db.close();
});

describe("cross-cutting", () => {
  it("CORS allows configured origins only", async () => {
    const ok = await api.app.inject({ method: "OPTIONS", url: "/stats", headers: { origin: "https://holdfast.example", "access-control-request-method": "GET" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("https://holdfast.example");
    const no = await api.app.inject({ method: "GET", url: "/schedule", headers: { origin: "https://evil.example" } });
    expect(no.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rate limits with a JSON error", async () => {
    const codes: number[] = [];
    let last: { error?: string } = {};
    for (let i = 0; i < 4; i++) {
      const res = await api.app.inject({ method: "GET", url: "/schedule", remoteAddress: "10.0.0.9" });
      codes.push(res.statusCode);
      last = res.json();
    }
    expect(codes).toEqual([200, 200, 200, 429]);
    expect(last.error).toMatch(/Rate limit exceeded/);
  });

  it("reads config from env", () => {
    const c = loadConfig({ API_PORT: "4100", CORS_ORIGIN: "*", PUBLIC_METADATA_BASE_URL: "https://cdn.example/meta/" });
    expect(c).toMatchObject({ port: 4100, corsOrigin: "*", publicMetadataBaseUrl: "https://cdn.example/meta" });
  });
});

describe("GET /metrics", () => {
  it("counts requests by route template and status class", async () => {
    const db = await freshDb();
    const api = await makeApi(db);
    await api.app.inject({ method: "GET", url: "/healthz" });
    await api.app.inject({ method: "GET", url: "/coins/not-a-mint" });
    const text = (await api.app.inject({ method: "GET", url: "/metrics" })).body;
    expect(text).toContain('holdfast_api_requests_total{route="/healthz",status="2xx"} 1');
    expect(text).toContain('holdfast_api_requests_total{route="/coins/:mint",status="4xx"} 1');
    await api.app.close();
    await db.close();
  });
});
