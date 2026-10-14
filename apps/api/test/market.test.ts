import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { nextRoundAt, verifyRoundSnapshot, type CandlesResponse, type CoinDetail, type CoinSummary, type Holder, type Page, type RoundSnapshot, type RoundSummary, type Stats, type Trade } from "@holdfast/core";
import { insertTrade, updateLastPrice, type Db } from "@holdfast/db";
import { freshDb, makeApi, NOW, resetDb, type TestApi } from "./helpers.js";
import { seedMarket, type MarketFixture } from "./fixtures.js";

let db: Db;
let api: TestApi;
let f: MarketFixture;

beforeAll(async () => {
  db = await freshDb();
  api = await makeApi(db);
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
  expect(res.statusCode, `${url}: ${res.body}`).toBe(status);
  return res.json() as T;
};

describe("stats & schedule", () => {
  it("GET /healthz", async () => {
    expect(await get("/healthz")).toEqual({ ok: true, time: NOW });
  });

  it("GET /stats", async () => {
    const s = await get<Stats>("/stats");
    expect(s).toEqual({
      coins: 2,
      totalVaultSol: 10,
      totalPaidSol: 0.5,
      defends24h: 1,
      volume24hSol: 0.2 + 0.15 + 0.03,
      schedule: { roundIntervalSec: 120, nextRoundAt: nextRoundAt(NOW), serverTime: NOW },
      solUsd: null,
    });
  });

  it("GET /schedule", async () => {
    expect(await get("/schedule")).toEqual({ roundIntervalSec: 120, nextRoundAt: nextRoundAt(NOW), serverTime: NOW });
  });
});

describe("coins", () => {
  it("GET /coins returns summaries with market math", async () => {
    const page = await get<Page<CoinSummary>>("/coins");
    expect(page.items.map((c) => c.ticker)).toEqual(["OCAT", "HOUND"]);
    expect(page.nextCursor).toBeNull();
    const hound = page.items[1]!;
    expect(hound).toMatchObject({
      mint: f.mint,
      name: "Holdfast Hound",
      imageUrl: "http://localhost:4000/metadata/abc.png",
      triggerBps: 2500,
      price: 3.1e-7,
      holders: 3,
      paidOutSol: 0.5,
      graduated: false,
      vaultBuying: false,
      createdAt: NOW - 3 * 86_400_000,
    });
    expect(hound.marketCapSol).toBeCloseTo(310, 6); // 3.1e-7 × 1e9 tokens
    expect(hound.athMarketCapSol).toBeCloseTo(400, 6);
    expect(hound.floorMarketCapSol).toBeCloseTo(300, 6);
    expect(hound.floorToAthProgress).toBeCloseTo(0.1, 6);
    expect(hound.change24hPct).toBeCloseTo(200, 6); // 3e-7 now vs 1e-7 a day+ ago
    expect(hound.volume24hSol).toBeCloseTo(0.38, 9);
    expect(hound.vault).toEqual({
      floorSol: 10,
      holderSol: 1,
      burnSol: 0.1,
      holderTokens: 1000,
      athPrice: expect.closeTo(4e-7, 12),
      floorPrice: expect.closeTo(3e-7, 12),
      defendCount: 1,
      lastDefendAt: NOW - 30 * 60_000,
      totalDefendedSol: 0.15,
    });
    const ocat = page.items[0]!;
    expect(ocat).toMatchObject({ price: 0, marketCapSol: 0, holders: 0, change24hPct: 0, floorToAthProgress: 0, vaultBuying: false });
  });

  it("sorts, searches and paginates", async () => {
    const tickers = async (url: string) => (await get<Page<CoinSummary>>(url)).items.map((c) => c.ticker);
    expect(await tickers("/coins?sort=trending")).toEqual(["HOUND", "OCAT"]);
    expect(await tickers("/coins?sort=top_payouts")).toEqual(["HOUND", "OCAT"]);
    expect(await tickers("/coins?sort=biggest_vault")).toEqual(["HOUND", "OCAT"]);
    // vault_buying filters: HOUND trades 10% above its floor, OCAT has no floor yet.
    expect(await tickers("/coins?sort=vault_buying")).toEqual([]);
    expect(await tickers("/coins?q=hound")).toEqual(["HOUND"]);
    expect(await tickers("/coins?q=%24ocat")).toEqual(["OCAT"]);
    expect(await tickers(`/coins?q=${f.mint}`)).toEqual(["HOUND"]);

    const p1 = await get<Page<CoinSummary>>("/coins?limit=1");
    expect(p1.items).toHaveLength(1);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await get<Page<CoinSummary>>(`/coins?limit=1&cursor=${p1.nextCursor}`);
    expect(p2.items.map((c) => c.ticker)).toEqual(["HOUND"]);
    expect(p2.nextCursor).toBeNull();
    const t1 = await get<Page<CoinSummary>>("/coins?sort=trending&limit=1");
    const t2 = await get<Page<CoinSummary>>(`/coins?sort=trending&limit=1&cursor=${t1.nextCursor}`);
    expect([...t1.items, ...t2.items].map((c) => c.ticker)).toEqual(["HOUND", "OCAT"]);

    await get("/coins?sort=hot", 400);
    await get("/coins?limit=0", 400);
  });

  it("vault_buying lists coins at/below the floor; young coins show change since launch", async () => {
    await updateLastPrice(db, f.mint, 2.9e-7, NOW, 999);
    const buying = await get<Page<CoinSummary>>("/coins?sort=vault_buying");
    expect(buying.items.map((c) => [c.ticker, c.vaultBuying, c.floorToAthProgress])).toEqual([["HOUND", true, 0]]);

    // OCAT is 1h old: its 24h change is measured from the first trade.
    const t = { ixIndex: 0, mint: f.other, wallet: f.bob, side: "buy" as const, sol: 1n, tokens: 1n, source: "curve" as const };
    await insertTrade(db, { ...t, sig: "ocat1", price: 1e-8, ts: NOW - 50 * 60_000, slot: 300 });
    await insertTrade(db, { ...t, sig: "ocat2", price: 2.5e-8, ts: NOW - 5 * 60_000, slot: 301 });
    const ocat = (await get<Page<CoinSummary>>("/coins?q=OCAT")).items[0]!;
    expect(ocat.change24hPct).toBeCloseTo(150, 9);
  });

  it("GET /coins/:mint returns the detail", async () => {
    const d = await get<CoinDetail>(`/coins/${f.mint}`);
    expect(d).toMatchObject({
      description: "good boy",
      socials: { x: "https://x.com/hound" },
      launcher: f.carol,
      treasuryAddress: f.treasury,
      ammPool: null,
      roundId: 1,
      lastRound: { roundId: 1, solPot: 0.5, tokenPot: 0, recipients: 1, status: "closed", ts: NOW - 3_600_000 + 5_000 },
    });
    expect(d.vaultAddress).toBeTruthy();
    expect(d.bondingCurve).toBeTruthy();
    const err = await get<{ error: string }>(`/coins/${f.alice}`, 404);
    expect(err).toEqual({ error: "Coin not found" });
    expect(await get("/coins/not-a-mint", 400)).toHaveProperty("error");
  });

  it("GET /coins/:mint/candles with floor line and defend markers", async () => {
    const c = await get<CandlesResponse>(`/coins/${f.mint}/candles?tf=1h`);
    expect(c.mint).toBe(f.mint);
    expect(c.tf).toBe("1h");
    expect(c.candles).toEqual([
      { t: NOW - 2 * 86_400_000, o: 1e-7, h: 1e-7, l: 1e-7, c: 1e-7, v: 0.1 },
      { t: NOW - 3_600_000, o: 2e-7, h: 3e-7, l: 1.5e-7, c: 3e-7, v: expect.closeTo(0.38, 12) },
    ]);
    expect(c.floorLine.map((p) => p.price)).toEqual([expect.closeTo(1.5e-7, 12), expect.closeTo(3e-7, 12)]);
    expect(c.defends).toEqual([{ t: NOW - 30 * 60_000, price: 1.5e-7, solSpent: 0.15, sig: f.sigs[2] }]);

    // A window after both floor points still starts with the current floor level.
    const recent = await get<CandlesResponse>(`/coins/${f.mint}/candles?tf=1m&from=${NOW - 2 * 3_600_000}`);
    expect(recent.floorLine).toEqual([{ t: NOW - 86_400_000, price: expect.closeTo(3e-7, 12) }]);
    expect(recent.candles.every((x) => x.t >= NOW - 2 * 3_600_000)).toBe(true);
    await get(`/coins/${f.mint}/candles?tf=2h`, 400);
  });

  it("GET /coins/:mint/trades pages with a cursor", async () => {
    const p1 = await get<Page<Trade>>(`/coins/${f.mint}/trades?limit=3`);
    expect(p1.items.map((t) => t.side)).toEqual(["sell", "vault", "buy"]);
    expect(p1.items[0]).toEqual({ sig: f.sigs[3], wallet: f.carol, side: "sell", sol: 0.03, tokens: 100, price: 3e-7, ts: NOW - 60_000, source: "curve" });
    expect(p1.items[1]).toMatchObject({ source: "vault", wallet: f.treasury });
    const p2 = await get<Page<Trade>>(`/coins/${f.mint}/trades?limit=3&before=${p1.nextCursor}`);
    expect(p2.items.map((t) => t.sig)).toEqual([f.sigs[0]]);
    expect(p2.nextCursor).toBeNull();
  });

  it("GET /coins/:mint/holders: sorted by weighted tokens with shares", async () => {
    const holders = await get<Holder[]>(`/coins/${f.mint}/holders`);
    expect(holders.map((h) => h.wallet)).toEqual([f.alice, f.bob, f.carol]);
    expect(holders[0]).toEqual({
      wallet: f.alice,
      tokens: 1000,
      eligibleTokens: 1000,
      weightedTokens: 1000,
      weightMultiplier: 1,
      share: expect.closeTo(1 / 1.1, 9),
      earnedSol: 0.5,
      earnedTokens: 0,
      oldestLotAt: NOW - 7 * 86_400_000,
    });
    expect(holders[1]).toMatchObject({ weightedTokens: 100, weightMultiplier: 0.1, share: expect.closeTo(0.1 / 1.1, 9), earnedSol: 0 });
    expect(holders[2]).toMatchObject({ tokens: 500, eligibleTokens: 0, weightedTokens: 0, weightMultiplier: 0, share: 0, oldestLotAt: null });
    expect(await get<Holder[]>(`/coins/${f.mint}/holders?limit=1`)).toHaveLength(1);
    expect(holders.some((h) => h.wallet === f.pool)).toBe(false);
  });

  it("GET /coins/:mint/defends and /rounds", async () => {
    expect(await get(`/coins/${f.mint}/defends`)).toEqual([{ sig: f.sigs[2], solSpent: 0.15, tokensBought: 1000, price: 1.5e-7, ts: NOW - 30 * 60_000 }]);
    const rounds = await get<RoundSummary[]>(`/coins/${f.mint}/rounds`);
    expect(rounds).toEqual([{ roundId: 1, ts: NOW - 3_600_000 + 5_000, solPot: 0.5, tokenPot: 0, recipients: 1, snapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/), status: "closed", openSig: "open1", closeSig: "close1" }]);
  });

  it("GET /coins/:mint/rounds/:id returns the verifiable public snapshot", async () => {
    const snap = await get<RoundSnapshot>(`/coins/${f.mint}/rounds/1`);
    expect(snap).toMatchObject({ version: 1, mint: f.mint, roundId: 1, status: "closed", solPot: 0.5, recipients: 1 });
    expect(snap.entries).toEqual([expect.objectContaining({ wallet: f.alice, solLamports: "500000000", sig: "paysig1" })]);
    expect(verifyRoundSnapshot(snap)).toEqual({ ok: true, problems: [] });
    await get(`/coins/${f.mint}/rounds/2`, 404);
    await get(`/coins/${f.mint}/rounds/abc`, 400);
  });

  it("unknown routes answer JSON 404", async () => {
    expect(await get("/nope", 404)).toEqual({ error: "Not found" });
  });
});
