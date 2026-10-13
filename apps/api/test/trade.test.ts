import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import BN from "bn.js";
import { ComputeBudgetProgram, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { buyQuoteInput, sellBaseInput } from "@pump-fun/pump-swap-sdk";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "@holdfast/chain";
import type { TradeBuildResponse, TradeQuote } from "@holdfast/core";
import type { Db } from "@holdfast/db";
import { quoteTrade, type AmmVenue, type CurveVenue } from "../src/index.js";
import { pumpSdk } from "../src/trade/sdk.js";
import { ammVenue, curveVenue, freshDb, makeApi, resetDb, type TestApi } from "./helpers.js";
import { seedMarket, type MarketFixture } from "./fixtures.js";

let db: Db;
let api: TestApi;
let f: MarketFixture;
const user = Keypair.generate().publicKey;

beforeAll(async () => {
  db = await freshDb();
  api = await makeApi(db);
});
beforeEach(async () => {
  await resetDb(db);
  f = await seedMarket(db);
  api.chain.venue = null;
});
afterAll(async () => {
  await api.app.close();
  await db.close();
});

const post = async <T>(url: string, payload: unknown, status = 200): Promise<T> => {
  const res = await api.app.inject({ method: "POST", url, payload: payload as object });
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as T;
};

describe("quote math (offline SDK functions)", () => {
  it("bonding-curve buy matches getBuyTokenAmountFromSolAmount", () => {
    const v = curveVenue(f.mint) as CurveVenue;
    const { quote, plan } = quoteTrade(v, { side: "buy", amount: 1.5, slippageBps: 100 }, 6);
    const expected = pumpSdk.getBuyTokenAmountFromSolAmount({ global: v.global, feeConfig: null, mintSupply: v.mintSupply, bondingCurve: v.bondingCurve, amount: new BN(1_500_000_000), quoteMint: NATIVE_MINT });
    expect(plan.expectedOut.toString()).toBe(expected.toString());
    expect(quote.expectedOut).toBeCloseTo(Number(expected.toString()) / 1e6, 6);
    expect(quote).toMatchObject({ side: "buy", venue: "curve" });
    expect(quote.minOut).toBe(quote.expectedOut);
    // fee = 1.25% (95 protocol + 30 creator bps) of the gross
    expect(quote.feeSol).toBeCloseTo(1.5 - 1.5 * (10_000 / 10_125), 9);
    expect(quote.priceImpactPct).toBeGreaterThan(0);
    expect(quote.priceImpactPct).toBeLessThan(10);
  });

  it("bonding-curve sell matches getSellSolAmountFromTokenAmount", () => {
    const v = curveVenue(f.mint, { hasTokenAccount: true }) as CurveVenue;
    const { quote } = quoteTrade(v, { side: "sell", amount: 1_000_000, slippageBps: 200 }, 6);
    const expected = pumpSdk.getSellSolAmountFromTokenAmount({ global: v.global, feeConfig: null, mintSupply: v.mintSupply, bondingCurve: v.bondingCurve, amount: new BN(1_000_000_000_000) });
    expect(quote.expectedOut).toBeCloseTo(Number(expected.toString()) / 1e9, 12);
    expect(quote.minOut).toBeCloseTo(quote.expectedOut * 0.98, 12);
    expect(quote.feeSol).toBeGreaterThan(0);
  });

  it("PumpSwap quotes price on effective quote reserves", () => {
    const v = ammVenue(f.mint, user, { virtualQuote: -5_000_000_000n }) as AmmVenue;
    const { quote } = quoteTrade(v, { side: "buy", amount: 1, slippageBps: 100 }, 6);
    const r = buyQuoteInput({
      quote: new BN(1_000_000_000),
      slippage: 1,
      baseReserve: v.swap.poolBaseAmount,
      quoteReserve: v.swap.poolQuoteAmount,
      virtualQuoteReserves: v.swap.pool.virtualQuoteReserves,
      globalConfig: v.swap.globalConfig,
      baseMintAccount: v.swap.baseMintAccount,
      baseMint: v.swap.baseMint,
      coinCreator: v.swap.pool.coinCreator,
      creator: v.swap.pool.creator,
      feeConfig: null,
    });
    expect(quote).toMatchObject({ venue: "pumpswap", side: "buy", expectedOut: Number(r.base.toString()) / 1e6 });
    // 1 SOL into (85 − 5) SOL of effective reserves vs 200M tokens: ≈ 2.46M tokens
    expect(quote.expectedOut).toBeGreaterThan(2_400_000);
    expect(quote.expectedOut).toBeLessThan(2_500_000);

    const sell = quoteTrade(v, { side: "sell", amount: 100_000, slippageBps: 50 }, 6).quote;
    const rs = sellBaseInput({
      base: new BN(100_000_000_000),
      slippage: 0.5,
      baseReserve: v.swap.poolBaseAmount,
      quoteReserve: v.swap.poolQuoteAmount,
      virtualQuoteReserves: v.swap.pool.virtualQuoteReserves,
      globalConfig: v.swap.globalConfig,
      baseMintAccount: v.swap.baseMintAccount,
      baseMint: v.swap.baseMint,
      coinCreator: v.swap.pool.coinCreator,
      creator: v.swap.pool.creator,
      feeConfig: null,
    });
    expect(sell.expectedOut).toBeCloseTo(Number(rs.uiQuote.toString()) / 1e9, 12);
    expect(sell.minOut).toBeCloseTo(Number(rs.minQuote.toString()) / 1e9, 12);
  });
});

describe("POST /trade/quote and /trade/build", () => {
  it("quotes through the injected chain", async () => {
    api.chain.venue = (coin) => curveVenue(coin.mint);
    const q = await post<TradeQuote>("/trade/quote", { mint: f.mint, wallet: user.toBase58(), side: "buy", amount: 0.5, slippageBps: 100 });
    expect(q).toMatchObject({ side: "buy", venue: "curve" });
    expect(q.expectedOut).toBeGreaterThan(0);
  });

  it("builds an unsigned v0 transaction paid by the wallet (bonding curve buy_v2 + ATA + compute budget)", async () => {
    api.chain.venue = (coin) => curveVenue(coin.mint);
    const res = await post<TradeBuildResponse>("/trade/build", { mint: f.mint, wallet: user.toBase58(), side: "buy", amount: 0.5, slippageBps: 100 });
    expect(res.lastValidBlockHeight).toBe(123_456);
    const tx = VersionedTransaction.deserialize(Buffer.from(res.transaction, "base64"));
    const keys = tx.message.staticAccountKeys;
    expect(keys[0]!.equals(user)).toBe(true);
    expect(tx.signatures.every((s) => s.every((b) => b === 0))).toBe(true);
    const programs = tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]!.toBase58());
    expect(programs[0]).toBe(ComputeBudgetProgram.programId.toBase58());
    expect(programs[1]).toBe(ComputeBudgetProgram.programId.toBase58());
    expect(programs).toContain("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    expect(programs.at(-1)).toBe(PUMP_PROGRAM_ID.toBase58());
    expect(res.quote.venue).toBe("curve");
  });

  it("builds a sell on PumpSwap after graduation", async () => {
    api.chain.venue = (coin, wallet) => ammVenue(coin.mint, wallet, { hasTokenAccount: true });
    const res = await post<TradeBuildResponse>("/trade/build", { mint: f.mint, wallet: user.toBase58(), side: "sell", amount: 1000, slippageBps: 100 });
    const tx = VersionedTransaction.deserialize(Buffer.from(res.transaction, "base64"));
    const keys = tx.message.staticAccountKeys;
    const programs = tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]!.toBase58());
    expect(programs).toContain(PUMP_AMM_PROGRAM_ID.toBase58());
    expect(res.quote).toMatchObject({ venue: "pumpswap", side: "sell" });
  });

  it("quotes without a connected wallet (System Program address or none), but never builds", async () => {
    const seen: string[] = [];
    api.chain.venue = (coin, wallet) => {
      seen.push(wallet.toBase58());
      return curveVenue(coin.mint);
    };
    const disconnected = "11111111111111111111111111111111";
    const q = await post<TradeQuote>("/trade/quote", { mint: f.mint, wallet: disconnected, side: "buy", amount: 0.5, slippageBps: 100 });
    expect(q.expectedOut).toBeGreaterThan(0);
    const sellQuote = await post<TradeQuote>("/trade/quote", { mint: f.mint, side: "sell", amount: 1000, slippageBps: 100 });
    expect(sellQuote.side).toBe("sell");
    expect(seen).toEqual([disconnected, disconnected]);
    expect(await post("/trade/build", { mint: f.mint, wallet: disconnected, side: "buy", amount: 0.5, slippageBps: 100 }, 400)).toEqual({
      error: "wallet: connect a wallet to build a transaction",
    });
    expect(await post("/trade/build", { mint: f.mint, side: "buy", amount: 0.5, slippageBps: 100 }, 400)).toHaveProperty("error");
  });

  it("validates input and maps chain failures", async () => {
    const base = { mint: f.mint, wallet: user.toBase58(), side: "buy", amount: 1, slippageBps: 100 };
    expect(await post("/trade/quote", { ...base, amount: -1 }, 400)).toHaveProperty("error");
    expect(await post("/trade/quote", { ...base, slippageBps: 9000 }, 400)).toHaveProperty("error");
    expect(await post("/trade/quote", { ...base, wallet: "x" }, 400)).toHaveProperty("error");
    expect(await post("/trade/quote", { ...base, mint: Keypair.generate().publicKey.toBase58() }, 404)).toEqual({ error: "Coin not found" });
    expect(await post("/trade/quote", base, 502)).toEqual({ error: "RPC unavailable" });
    api.chain.venue = (coin) => curveVenue(coin.mint);
    expect(await post("/trade/build", { ...base, side: "sell" }, 400)).toEqual({ error: "This wallet holds no tokens of this coin" });
    expect(new PublicKey(user).toBase58()).toBeTruthy();
  });
});
