import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { Position, Profile } from "@holdfast/core";
import type { Db } from "@holdfast/db";
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
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as T;
};

describe("GET /me/position", () => {
  it("weights, share and next payout estimate", async () => {
    const p = await get<Position>(`/me/position?wallet=${f.bob}&mint=${f.mint}`);
    // bob: 1000 tokens bought now → 0.1×; total weight = 1000 (alice) + 100 (bob)
    // pot 1 SOL − 0.001 carried = 0.999 distributable × 1/11, plus bob's own 0.001 carry.
    expect(p).toEqual({
      mint: f.mint,
      name: "Holdfast Hound",
      ticker: "HOUND",
      imageUrl: "http://localhost:4000/metadata/abc.png",
      tokens: 1000,
      eligibleTokens: 1000,
      weightedTokens: 100,
      weightMultiplier: 0.1,
      share: expect.closeTo(1 / 11, 9),
      valueSol: expect.closeTo(1000 * 3.1e-7, 12),
      earnedSol: 0,
      earnedTokens: 0,
      // integer lamports: floor(0.999e9 × 1/11) + 0.001e9
      nextPayoutEstimateSol: (Math.floor(999_000_000 / 11) + 1_000_000) / 1e9,
      lots: [{ amount: 1000, acquiredAt: NOW, weight: 0.1 }],
    });

    const a = await get<Position>(`/me/position?wallet=${f.alice}&mint=${f.mint}`);
    expect(a).toMatchObject({ weightedTokens: 1000, weightMultiplier: 1, share: expect.closeTo(10 / 11, 9), earnedSol: 0.5, nextPayoutEstimateSol: Math.floor((999_000_000 * 10) / 11) / 1e9 });
    expect(a.lots).toEqual([{ amount: 1000, acquiredAt: NOW - 7 * 86_400_000, weight: 1 }]);

    const c = await get<Position>(`/me/position?wallet=${f.carol}&mint=${f.mint}`);
    expect(c).toMatchObject({ tokens: 500, eligibleTokens: 0, weightedTokens: 0, share: 0, nextPayoutEstimateSol: 0, lots: [] });
  });

  it("null for wallets without a position, 400 for bad input", async () => {
    const stranger = Keypair.generate().publicKey.toBase58();
    expect(await get(`/me/position?wallet=${stranger}&mint=${f.mint}`)).toBeNull();
    expect(await get(`/me/position?wallet=${f.alice}&mint=${f.other}`)).toBeNull();
    await get(`/me/position?wallet=nope&mint=${f.mint}`, 400);
    await get(`/me/position?wallet=${f.alice}`, 400);
  });
});

describe("GET /me", () => {
  it("profile with positions, earnings and recent payouts", async () => {
    const p = await get<Profile>(`/me?wallet=${f.alice}`);
    expect(p.wallet).toBe(f.alice);
    expect(p.totalEarnedSol).toBe(0.5);
    expect(p.totalEarnedTokensValueSol).toBe(0);
    expect(p.positions.map((x) => x.mint)).toEqual([f.mint]);
    expect(p.recentPayouts).toEqual([{ mint: f.mint, ticker: "HOUND", roundId: 1, sol: 0.5, tokens: 0, ts: NOW - 3_600_000 + 5_000, sig: "paysig1" }]);

    const empty = await get<Profile>(`/me?wallet=${Keypair.generate().publicKey.toBase58()}`);
    expect(empty).toMatchObject({ totalEarnedSol: 0, positions: [], recentPayouts: [] });
    await get("/me", 400);
  });
});
