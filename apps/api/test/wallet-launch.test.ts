import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { LaunchRequest, WalletLaunchPrepared } from "@holdfast/core";
import { insertWalletLaunch, settleWalletLaunch, type Db } from "@holdfast/db";
import { HttpWalletLauncher, type WalletLauncher } from "../src/launch/wallet.js";
import { freshDb, makeApi, NOW, resetDb, type TestApi } from "./helpers.js";

let db: Db;
let api: TestApi;
const calls: { req: LaunchRequest; wallet: string }[] = [];
const prepared: WalletLaunchPrepared = { mint: Keypair.generate().publicKey.toBase58(), transaction: "AQID", lastValidBlockHeight: 99, maxCostLamports: "21000000", expiresAt: NOW + 180_000 };
const fake: WalletLauncher = {
  async prepare(req, wallet) {
    calls.push({ req, wallet });
    return prepared;
  },
};
const wallet = Keypair.generate().publicKey.toBase58();
const valid: LaunchRequest = { name: "Dog Coin", ticker: "DOG", triggerBps: 2500, devBuySol: 0.5 };

beforeAll(async () => {
  db = await freshDb();
  api = await makeApi(db, {}, () => NOW, { walletLauncher: fake });
});
beforeEach(async () => {
  calls.length = 0;
  await resetDb(db);
});
afterAll(async () => {
  await api.app.close();
  await db.close();
});

describe("POST /launch/wallet", () => {
  it("hands the validated launch and the wallet to the launcher and returns its transaction", async () => {
    const res = await api.app.inject({ method: "POST", url: "/launch/wallet", payload: { ...valid, wallet, socials: { x: "@dogcoin" } } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual(prepared);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.wallet).toBe(wallet);
    expect(calls[0]!.req).toMatchObject({ name: "Dog Coin", ticker: "DOG", triggerBps: 2500, devBuySol: 0.5, socials: { x: "https://x.com/dogcoin" } });
  });

  it("rejects a missing or invalid wallet, blocked text and paused launches before the launcher", async () => {
    expect((await api.app.inject({ method: "POST", url: "/launch/wallet", payload: valid })).statusCode).toBe(400);
    expect((await api.app.inject({ method: "POST", url: "/launch/wallet", payload: { ...valid, wallet: "0".repeat(40) } })).statusCode).toBe(400);
    expect((await api.app.inject({ method: "POST", url: "/launch/wallet", payload: { ...valid, wallet, triggerBps: 1234 } })).statusCode).toBe(400);
    const paused = await makeApi(db, { launchesPaused: true }, () => NOW, { walletLauncher: fake });
    try {
      const res = await paused.app.inject({ method: "POST", url: "/launch/wallet", payload: { ...valid, wallet } });
      expect(res.statusCode).toBe(503);
    } finally {
      await paused.app.close();
    }
    expect(calls).toHaveLength(0);
  });
});

describe("GET /launch/wallet/:mint", () => {
  it("reports pending, then live; unknown mints are 404", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    expect((await api.app.inject({ method: "GET", url: `/launch/wallet/${mint}` })).statusCode).toBe(404);
    await insertWalletLaunch(db, { mint, wallet, form: valid, uri: "https://example.com/m.json", expiresAt: NOW + 180_000 });
    expect((await api.app.inject({ method: "GET", url: `/launch/wallet/${mint}` })).json()).toEqual({ mint, status: "pending" });
    expect(await settleWalletLaunch(db, mint, "live")).not.toBeNull();
    expect(await settleWalletLaunch(db, mint, "expired")).toBeNull();
    expect((await api.app.inject({ method: "GET", url: `/launch/wallet/${mint}` })).json()).toEqual({ mint, status: "live" });
  });
});

describe("HttpWalletLauncher", () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("returns the launcher's transaction and passes its 4xx messages on", async () => {
    await expect(new HttpWalletLauncher("http://launcher:9103", reply(200, prepared)).prepare(valid, wallet)).resolves.toEqual(prepared);
    await expect(new HttpWalletLauncher("http://launcher:9103", reply(422, { error: "name too long" })).prepare(valid, wallet)).rejects.toMatchObject({ statusCode: 422, message: "name too long" });
    await expect(new HttpWalletLauncher("http://launcher:9103", reply(500, { error: "rpc down" })).prepare(valid, wallet)).rejects.toMatchObject({ statusCode: 503 });
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(new HttpWalletLauncher("http://launcher:9103", down).prepare(valid, wallet)).rejects.toMatchObject({ statusCode: 503 });
  });
});
