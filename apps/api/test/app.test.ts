import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTERNAL_TOKEN_HEADER, TELEGRAM_USER_HEADER } from "@holdfast/core";
import type { Db } from "@holdfast/db";
import { loadConfig } from "../src/index.js";
import { rateLimitKey } from "../src/ratelimit.js";
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

describe("rate limits for the Telegram bot (INTERNAL_API_TOKEN)", () => {
  const TOKEN = "internal-token-0123456789abcdef0123456789";
  const bot = (user: string, token = TOKEN) => ({ [INTERNAL_TOKEN_HEADER]: token, [TELEGRAM_USER_HEADER]: user });
  /** POST /launch (10 a minute) with an invalid form: 400 until the bucket is empty, then 429. */
  const launch = (api: TestApi, headers: Record<string, string>) => api.app.inject({ method: "POST", url: "/launch", remoteAddress: "10.0.0.20", headers, payload: {} }).then((r) => r.statusCode);

  it("keys the bot's requests by Telegram user when the token matches, and by IP otherwise", async () => {
    const db = await freshDb();
    const api = await makeApi(db, { rateLimitPerMinute: 100, internalApiToken: TOKEN });
    for (let i = 0; i < 10; i++) expect(await launch(api, bot("111"))).toBe(400);
    expect(await launch(api, bot("111"))).toBe(429);
    // Another Telegram user behind the same notifier IP has a bucket of its own...
    expect(await launch(api, bot("222"))).toBe(400);
    // ...and so has the IP itself, which the bot users did not use up.
    for (let i = 0; i < 10; i++) expect(await launch(api, {})).toBe(400);
    expect(await launch(api, {})).toBe(429);
    // Without the right token the user header counts for nothing: the IP's bucket, already empty.
    expect(await launch(api, bot("333", "wrong-token-0123456789abcdef0123456789"))).toBe(429);
    expect(await launch(api, { [TELEGRAM_USER_HEADER]: "444" })).toBe(429);
    expect(await launch(api, bot("not-a-user"))).toBe(429);
    expect(await launch(api, bot("555"))).toBe(400);
    await api.app.close();
    await db.close();
  });

  it("ignores the bot headers when the API has no token", async () => {
    const db = await freshDb();
    const api = await makeApi(db, { rateLimitPerMinute: 100 });
    for (let i = 0; i < 10; i++) expect(await launch(api, bot(String(1000 + i)))).toBe(400);
    expect(await launch(api, bot("2000"))).toBe(429);
    await api.app.close();
    await db.close();
  });

  it("builds the key and reads the token from the environment", () => {
    expect(rateLimitKey({ ip: "10.0.0.20", headers: bot("123") }, TOKEN)).toBe("tg:123");
    expect(rateLimitKey({ ip: "10.0.0.20", headers: bot("123") }, null)).toBe("10.0.0.20");
    expect(rateLimitKey({ ip: "10.0.0.20", headers: bot("123", `${TOKEN}x`) }, TOKEN)).toBe("10.0.0.20");
    expect(rateLimitKey({ ip: "10.0.0.20", headers: bot("0123") }, TOKEN)).toBe("10.0.0.20");
    expect(rateLimitKey({ ip: "10.0.0.20", headers: { [INTERNAL_TOKEN_HEADER]: TOKEN } }, TOKEN)).toBe("10.0.0.20");
    expect(loadConfig({}).internalApiToken).toBeNull();
    expect(loadConfig({ INTERNAL_API_TOKEN: "too-short" }).internalApiToken).toBeNull();
    expect(loadConfig({ INTERNAL_API_TOKEN: ` ${TOKEN} ` }).internalApiToken).toBe(TOKEN);
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
