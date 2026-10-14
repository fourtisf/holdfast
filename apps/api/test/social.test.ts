import { createPrivateKey, sign } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  commentMessage,
  encodeSignature,
  PUMP_INITIAL_REAL_TOKEN_RESERVES,
  type CoinSummary,
  type Comment,
  type CreatorProfile,
  type Leaderboard,
  type Page,
  type Stats,
  type WalletTrade,
} from "@holdfast/core";
import { insertCoin, insertLot, updateCurveReserves, type Db } from "@holdfast/db";
import { parseCoingecko, parseHermes, SolUsdFeed } from "../src/services/price.js";
import { ADMIN_TOKEN, freshDb, makeApi, NOW, resetDb, testConfig, type TestApi } from "./helpers.js";
import { seedMarket, type MarketFixture } from "./fixtures.js";

let db: Db;
let api: TestApi;
let f: MarketFixture;

beforeAll(async () => {
  db = await freshDb();
  api = await makeApi(db, { moderation: { ...testConfig().moderation, autoHideReports: 2 } }, () => NOW, { prices: { solUsd: () => 150.5 } });
});
beforeEach(async () => {
  await resetDb(db);
  f = await seedMarket(db);
});
afterAll(async () => {
  await api.app.close();
  await db.close();
});

const get = async <T>(url: string, status = 200): Promise<T> => {
  const res = await api.app.inject({ method: "GET", url });
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as T;
};
const post = async <T>(url: string, payload: unknown, status = 200, headers: Record<string, string> = {}): Promise<T> => {
  const res = await api.app.inject({ method: "POST", url, payload: payload as object, headers });
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as T;
};

/** ed25519 over the UTF-8 message with a Solana keypair, like a wallet's `signMessage`. */
function signWith(kp: Keypair, message: string): string {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(kp.secretKey.subarray(0, 32))]);
  return encodeSignature(sign(null, Buffer.from(message, "utf8"), createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })));
}

function signed(kp: Keypair, mint: string, body: string, opts: { replyTo?: number | null; signedAt?: number } = {}) {
  const signedAt = opts.signedAt ?? NOW - 5_000;
  const replyTo = opts.replyTo ?? null;
  return { wallet: kp.publicKey.toBase58(), body, replyTo, signedAt, signature: signWith(kp, commentMessage({ mint, body, replyTo, signedAt })) };
}

describe("market extras", () => {
  it("stats carry the SOL/USD price", async () => {
    expect((await get<Stats>("/stats")).solUsd).toBe(150.5);
  });

  it("bonding-curve progress from the indexed reserves", async () => {
    const before = await get<CoinSummary>(`/coins/${f.mint}`);
    expect(before.bondingCurveProgress).toBe(0);
    await updateCurveReserves(db, f.mint, PUMP_INITIAL_REAL_TOKEN_RESERVES / 4n, 103);
    expect((await get<CoinSummary>(`/coins/${f.mint}`)).bondingCurveProgress).toBe(0.75);
    // an older trade never rewinds it
    await updateCurveReserves(db, f.mint, PUMP_INITIAL_REAL_TOKEN_RESERVES, 50);
    expect((await get<CoinSummary>(`/coins/${f.mint}`)).bondingCurveProgress).toBe(0.75);
  });

  it("filters: watchlist mints, graduated, age, market cap", async () => {
    const mints = (p: Page<CoinSummary>) => p.items.map((c) => c.mint).sort();
    expect(mints(await get(`/coins?mints=${f.mint}`))).toEqual([f.mint]);
    expect(mints(await get(`/coins?mints=${f.mint},${f.other}`))).toEqual([f.mint, f.other].sort());
    expect(mints(await get("/coins?graduated=true"))).toEqual([]);
    expect(mints(await get("/coins?graduated=false"))).toEqual([f.mint, f.other].sort());
    expect(mints(await get("/coins?maxAgeHours=2"))).toEqual([f.other]);
    // 3.1e-7 SOL × 1B tokens = 310 SOL market cap; the other coin never traded
    expect(mints(await get("/coins?minMcapSol=300"))).toEqual([f.mint]);
    expect(mints(await get("/coins?minMcapSol=400"))).toEqual([]);
    await get("/coins?mints=nope", 400);
  });
});

describe("portfolio, leaderboards, creators", () => {
  it("GET /me/trades lists a wallet's trades across coins, newest first, paged", async () => {
    const p = await get<Page<WalletTrade>>(`/me/trades?wallet=${f.alice}`);
    expect(p.items).toEqual([{ sig: f.sigs[0], wallet: f.alice, side: "buy", sol: 0.1, tokens: 1000, price: 1e-7, ts: NOW - 2 * 86_400_000, source: "curve", mint: f.mint, ticker: "HOUND", name: "Holdfast Hound" }]);
    expect(p.nextCursor).toBeNull();
    const first = await get<Page<WalletTrade>>(`/me/trades?wallet=${f.treasury}&limit=1`);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeNull();
  });

  it("GET /leaderboard: earners, diamond hands, creators, coins", async () => {
    const earners = await get<Leaderboard>("/leaderboard?kind=earners");
    expect(earners).toEqual({ kind: "earners", items: [{ wallet: f.alice, earnedSol: 0.5, coins: 1, payouts: 1 }] });
    expect((await get<Leaderboard>("/leaderboard?kind=earners&days=1")).items).toHaveLength(1);

    const dh = await get<Leaderboard>("/leaderboard?kind=diamond_hands");
    expect(dh.kind).toBe("diamond_hands");
    expect(dh.items.map((i) => (i as { wallet: string }).wallet)).toEqual([f.alice, f.bob]);

    const creators = await get<Leaderboard>("/leaderboard?kind=creators");
    expect(creators).toEqual({ kind: "creators", items: [{ wallet: f.carol, coins: 1, paidToHoldersSol: 0, totalFeesSol: 20, firstLaunchAt: NOW - 3 * 86_400_000 }] });

    const coins = await get<Leaderboard>("/leaderboard?kind=coins&limit=5");
    expect(coins.kind).toBe("coins");
    expect((coins.items[0] as CoinSummary).mint).toBe(f.mint);
    await get("/leaderboard?kind=nope", 400);
  });

  it("GET /creators/:wallet", async () => {
    const c = await get<CreatorProfile>(`/creators/${f.carol}`);
    expect(c).toMatchObject({ wallet: f.carol, coinCount: 1, paidToHoldersSol: 0, totalFeesSol: 20, coinsAboveFloor: 1 });
    expect(c.coins.map((x) => x.mint)).toEqual([f.mint]);
    const none = await get<CreatorProfile>(`/creators/${Keypair.generate().publicKey.toBase58()}`);
    expect(none).toMatchObject({ coinCount: 0, coins: [], firstLaunchAt: null });
  });

  it("GET /me reports PnL and launched coins", async () => {
    const carol = await get<{ launchedCoins: number; totalPnlSol: number }>(`/me?wallet=${f.carol}`);
    expect(carol.launchedCoins).toBe(1);
    const bob = await get<{ totalValueSol: number; totalPnlSol: number }>(`/me?wallet=${f.bob}`);
    expect(bob.totalValueSol).toBeCloseTo(1000 * 3.1e-7, 12);
    expect(bob.totalPnlSol).toBeCloseTo(1000 * 3.1e-7 - 0.2, 12);
  });
});

describe("comments", () => {
  it("posts a wallet-signed comment with holder / creator badges, and lists it", async () => {
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    await insertLot(db, { wallet: w, mint: f.mint, amount: 10n ** 6n, acquiredAt: NOW, sourceSig: "s", sourceIx: 0 });
    const c = await post<Comment>(`/coins/${f.mint}/comments`, signed(kp, f.mint, "  diamond hands only \r\n"));
    expect(c).toMatchObject({ mint: f.mint, wallet: w, body: "diamond hands only", replyTo: null, createdAt: NOW, holder: true, isCreator: false, hidden: false });
    expect(c.weightMultiplier).toBeCloseTo(0.1, 9);

    const stranger = Keypair.generate();
    const reply = await post<Comment>(`/coins/${f.mint}/comments`, signed(stranger, f.mint, "ngmi", { replyTo: c.id }));
    expect(reply).toMatchObject({ replyTo: c.id, holder: false, weightMultiplier: null });

    // the creator's badge
    const creator = Keypair.generate();
    const mint = Keypair.generate().publicKey.toBase58();
    await insertCoin(db, { mint, name: "Mine", ticker: "MINE", triggerBps: 2500, creator: creator.publicKey.toBase58(), vault: w, treasury: w, bondingCurve: w, tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", createdAt: NOW });
    expect((await post<Comment>(`/coins/${mint}/comments`, signed(creator, mint, "gm"))).isCreator).toBe(true);

    const page = await get<Page<Comment>>(`/coins/${f.mint}/comments?limit=1`);
    expect(page.items.map((x) => x.id)).toEqual([reply.id]);
    const next = await get<Page<Comment>>(`/coins/${f.mint}/comments?limit=1&before=${page.nextCursor}`);
    expect(next.items.map((x) => x.id)).toEqual([c.id]);
    expect(next.nextCursor).toBeNull();
  });

  it("refuses forged, expired, replayed, off-coin and blocked comments, and floods", async () => {
    const kp = Keypair.generate();
    const good = signed(kp, f.mint, "hello");
    // signed by someone else / for another coin / another text
    await post(`/coins/${f.mint}/comments`, { ...good, wallet: Keypair.generate().publicKey.toBase58() }, 401);
    await post(`/coins/${f.other}/comments`, good, 401);
    await post(`/coins/${f.mint}/comments`, { ...good, body: "hello!" }, 401);
    await post(`/coins/${f.mint}/comments`, signed(kp, f.mint, "old", { signedAt: NOW - 11 * 60_000 }), 400);
    await post(`/coins/${f.mint}/comments`, signed(kp, f.mint, "future", { signedAt: NOW + 5 * 60_000 }), 400);
    await post(`/coins/${f.mint}/comments`, signed(kp, f.mint, "x".repeat(501)), 400);
    await post(`/coins/${f.mint}/comments`, signed(kp, f.mint, "   "), 400);
    await post(`/coins/${f.mint}/comments`, signed(kp, f.mint, "reply", { replyTo: 999_999 }), 400);
    // blocked terms survive leetspeak and spacing
    await post(`/coins/${f.mint}/comments`, signed(kp, f.mint, "get your w4ll3t dr4iner here"), 422);
    await post(`/coins/${f.mint}/comments`, signed(kp, f.mint, "torpedo incoming"), 200);

    await post(`/coins/${f.mint}/comments`, good, 200);
    await post(`/coins/${f.mint}/comments`, good, 409);
    await post(`/coins/${f.mint}/comments`, signed(kp, f.mint, "third"), 200);
    // 3 per wallet per minute
    await post(`/coins/${f.mint}/comments`, signed(kp, f.mint, "fourth"), 429);
  });

  it("reports hide a comment after the threshold; admins hide and unhide", async () => {
    const kp = Keypair.generate();
    const c = await post<Comment>(`/coins/${f.mint}/comments`, signed(kp, f.mint, "rug soon"));
    const report = (ip: string) => api.app.inject({ method: "POST", url: `/comments/${c.id}/report`, payload: { reason: "scam" }, remoteAddress: ip });
    expect((await report("10.0.0.1")).json()).toEqual({ recorded: true });
    expect((await report("10.0.0.1")).json()).toEqual({ recorded: false });
    expect((await get<Page<Comment>>(`/coins/${f.mint}/comments`)).items[0]!.hidden).toBe(false);
    await report("10.0.0.2");
    const hidden = (await get<Page<Comment>>(`/coins/${f.mint}/comments`)).items[0]!;
    expect(hidden).toMatchObject({ id: c.id, hidden: true, body: "" });

    const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };
    await post(`/admin/comments/${c.id}/unhide`, {}, 200, auth);
    expect((await get<Page<Comment>>(`/coins/${f.mint}/comments`)).items[0]).toMatchObject({ hidden: false, body: "rug soon" });
    await post(`/admin/comments/${c.id}/hide`, { reason: "spam" }, 200, auth);
    expect((await get<Page<Comment>>(`/coins/${f.mint}/comments`)).items[0]!.hidden).toBe(true);
    await post(`/admin/comments/${c.id}/hide`, { reason: "spam" }, 401);
    await post(`/admin/comments/999999/hide`, { reason: "spam" }, 404, auth);
  });
});

describe("SOL/USD feed", () => {
  const response = (body: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body });

  it("parses Hermes and CoinGecko answers", () => {
    expect(parseHermes({ parsed: [{ price: { price: "15050000000", expo: -8 } }] })).toBeCloseTo(150.5, 9);
    expect(parseHermes({ parsed: [] })).toBeNull();
    expect(parseCoingecko({ solana: { usd: 151.2 } })).toBe(151.2);
    expect(parseCoingecko({})).toBeNull();
  });

  it("falls back to CoinGecko, keeps the last value, and goes stale", async () => {
    let t = 1_000_000;
    let hermesUp = false;
    const urls: string[] = [];
    const feed = new SolUsdFeed({
      now: () => t,
      maxAgeMs: 60_000,
      fetch: (url) => {
        urls.push(url);
        if (url.includes("hermes")) return hermesUp ? response({ parsed: [{ price: { price: "14000000000", expo: -8 } }] }) : response({}, false);
        return response({ solana: { usd: 151 } });
      },
    });
    expect(feed.solUsd()).toBeNull();
    expect(await feed.refresh()).toBe(151);
    expect(urls[0]).toContain("ids[]=0xef0d8b6f");
    hermesUp = true;
    expect(await feed.refresh()).toBeCloseTo(140, 9);
    t += 61_000;
    expect(feed.solUsd()).toBeNull();
  });
});
