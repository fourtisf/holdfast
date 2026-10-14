import { randomUUID } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AdminCoin, AdminLaunch, AdminOverview, AdminReport, CoinDetail, Page, CoinSummary } from "@holdfast/core";
import { getCoin, insertLaunch, updateLaunchStatus, type Db } from "@holdfast/db";

import { seedMarket, type MarketFixture } from "./fixtures.js";
import { ADMIN_TOKEN, freshDb, makeApi, resetDb, type TestApi } from "./helpers.js";

let db: Db;
let api: TestApi;
let m: MarketFixture;
const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };

beforeAll(async () => {
  db = await freshDb();
  api = await makeApi(db);
});
beforeEach(async () => {
  await resetDb(db);
  m = await seedMarket(db);
});
afterAll(async () => {
  await api.app.close();
  await db.close();
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-bytes-for-moderation")]);
function multipart(content: Buffer) {
  const boundary = "----holdfast";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload: body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("reports", () => {
  it("records one report per reporter, validates the reason", async () => {
    const r1 = await api.app.inject({ method: "POST", url: `/coins/${m.mint}/report`, payload: { reason: "scam", details: "fake team" }, remoteAddress: "1.1.1.1" });
    expect(r1.json()).toEqual({ recorded: true });
    const again = await api.app.inject({ method: "POST", url: `/coins/${m.mint}/report`, payload: { reason: "nsfw" }, remoteAddress: "1.1.1.1" });
    expect(again.json()).toEqual({ recorded: false });
    expect((await api.app.inject({ method: "POST", url: `/coins/${m.mint}/report`, payload: { reason: "because" } })).statusCode).toBe(400);
    expect((await api.app.inject({ method: "POST", url: `/coins/${Keypair.generate().publicKey.toBase58()}/report`, payload: { reason: "scam" } })).statusCode).toBe(404);
    const reports = (await api.app.inject({ method: "GET", url: "/admin/reports", headers: auth })).json<AdminReport[]>();
    expect(reports).toMatchObject([{ mint: m.mint, reason: "scam", details: "fake team", resolvedAt: null }]);
  });

  it("hides a coin automatically after the configured number of distinct reports", async () => {
    const strict = await makeApi(db, { moderation: { ...api.config.moderation, autoHideReports: 2 } });
    for (const ip of ["1.1.1.1", "2.2.2.2"]) await strict.app.inject({ method: "POST", url: `/coins/${m.mint}/report`, payload: { reason: "illegal" }, remoteAddress: ip });
    expect(await getCoin(db, m.mint)).toMatchObject({ hidden: true });
    await strict.app.close();
  });
});

describe("hidden coins", () => {
  it("are not listed and their content is withheld, but the coin page still answers", async () => {
    const hide = await api.app.inject({ method: "POST", url: `/admin/coins/${m.mint}/hide`, headers: auth, payload: { reason: "copyrighted image" } });
    expect(hide.statusCode, hide.body).toBe(200);
    const list = (await api.app.inject({ method: "GET", url: "/coins" })).json<Page<CoinSummary>>();
    expect(list.items.map((c) => c.mint)).not.toContain(m.mint);
    const detail = (await api.app.inject({ method: "GET", url: `/coins/${m.mint}` })).json<CoinDetail>();
    expect(detail).toMatchObject({ hidden: true, hiddenReason: "copyrighted image", imageUrl: null, description: "", socials: {} });
    expect(detail.vault).toBeTruthy(); // vault data stays public: holders still get paid

    const unhide = await api.app.inject({ method: "POST", url: `/admin/coins/${m.mint}/unhide`, headers: auth });
    expect(unhide.statusCode).toBe(200);
    expect((await api.app.inject({ method: "GET", url: `/coins/${m.mint}` })).json<CoinDetail>()).toMatchObject({ hidden: false, description: "good boy" });
  });

  it("blocking a coin's image refuses the same bytes on upload", async () => {
    const up = await api.app.inject({ method: "POST", url: "/uploads/image", ...multipart(PNG) });
    const { imageUrl } = up.json<{ imageUrl: string }>();
    await db.query("UPDATE coins SET image_url = $2 WHERE mint = $1", [m.mint, imageUrl]);
    await api.app.inject({ method: "POST", url: `/admin/coins/${m.mint}/hide`, headers: auth, payload: { reason: "nsfw", blockImage: true } });
    const again = await api.app.inject({ method: "POST", url: "/uploads/image", ...multipart(PNG) });
    expect(again.statusCode).toBe(422);
    expect(again.json()).toEqual({ error: "This image is not allowed" });
  });
});

describe("launch text moderation", () => {
  it("rejects blocked terms before a deposit address is created", async () => {
    const res = await api.app.inject({ method: "POST", url: "/launch", payload: { name: "Free SOL airdrop", ticker: "FREE", triggerBps: 2500, description: "claim airdrop at my site" } });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toMatch(/not allowed/);
    const ok = await api.app.inject({ method: "POST", url: "/launch", payload: { name: "USD Coin", ticker: "USDC", triggerBps: 2500 } });
    expect(ok.statusCode).toBe(200); // reserved names are flagged for review, not refused
  });
});

describe("admin API", () => {
  it("requires the token, and is disabled without one", async () => {
    expect((await api.app.inject({ method: "GET", url: "/admin/overview" })).statusCode).toBe(401);
    expect((await api.app.inject({ method: "GET", url: "/admin/overview", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
    const off = await makeApi(db, { adminToken: null });
    expect((await off.app.inject({ method: "GET", url: "/admin/overview", headers: auth })).statusCode).toBe(404);
    await off.app.close();
  });

  it("lists coins to review, launches, and retries a stuck launch", async () => {
    await db.query("UPDATE coins SET needs_review = true WHERE mint = $1", [m.mint]);
    const coins = (await api.app.inject({ method: "GET", url: "/admin/coins", headers: auth })).json<AdminCoin[]>();
    expect(coins).toMatchObject([{ mint: m.mint, needsReview: true, hidden: false }]);
    expect((await api.app.inject({ method: "POST", url: `/admin/coins/${m.mint}/reviewed`, headers: auth })).statusCode).toBe(200);
    expect(await getCoin(db, m.mint)).toMatchObject({ needsReview: false });

    const id = randomUUID();
    const l = await insertLaunch(db, { id, form: { name: "Stuck", ticker: "STK", triggerBps: 2500 }, depositAddress: m.alice, depositIndex: 1n, requiredLamports: 1n, devBuyLamports: 0n, expiresAt: Date.now() + 60_000 });
    await updateLaunchStatus(db, l.id, "creating", { error: "create: rpc down", incrementAttempts: true }, ["awaiting_deposit"]);
    const launches = (await api.app.inject({ method: "GET", url: "/admin/launches?status=creating,failed", headers: auth })).json<AdminLaunch[]>();
    expect(launches).toMatchObject([{ launchId: id, name: "Stuck", attempts: 1, status: "creating", error: "create: rpc down" }]);
    const retry = await api.app.inject({ method: "POST", url: `/admin/launches/${id}/retry`, headers: auth });
    expect(retry.json<AdminLaunch>()).toMatchObject({ attempts: 0, error: null });
    expect((await api.app.inject({ method: "GET", url: "/admin/launches?status=bogus", headers: auth })).statusCode).toBe(400);

    const overview = (await api.app.inject({ method: "GET", url: "/admin/overview", headers: auth })).json<AdminOverview>();
    expect(overview).toMatchObject({ launches: { creating: 1 }, openReports: 0, hiddenCoins: 0 });
    const log = (await api.app.inject({ method: "GET", url: "/admin/log", headers: auth })).json<{ action: string }[]>();
    expect(log.map((e) => e.action)).toEqual(["retry_launch", "reviewed"]);
  });
});
