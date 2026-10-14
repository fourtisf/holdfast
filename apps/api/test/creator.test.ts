import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, VersionedTransaction } from "@solana/web3.js";
import { HOLDFAST_IDL, HOLDFAST_PROGRAM_ID } from "@holdfast/chain";
import type { CoinDetail, CreatorClaimBuildResponse } from "@holdfast/core";
import { applyVaultDelta, getCoin, type Db } from "@holdfast/db";
import { freshDb, makeApi, resetDb, type TestApi } from "./helpers.js";
import { seedMarket, type MarketFixture } from "./fixtures.js";

let db: Db;
let api: TestApi;
let f: MarketFixture;
const discriminator = (name: string) =>
  Buffer.from((HOLDFAST_IDL.instructions as unknown as { name: string; discriminator: number[] }[]).find((i) => i.name === name)!.discriminator);

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

const claim = (payload: object) => api.app.inject({ method: "POST", url: "/creator/claim/build", payload });

describe("creator share", () => {
  it("shows the unclaimed and claimed creator share in the coin's vault", async () => {
    const coin = (await api.app.inject({ method: "GET", url: `/coins/${f.mint}` })).json<CoinDetail>();
    expect(coin.launcher).toBe(f.carol);
    expect(coin.vault).toMatchObject({ creatorSol: 0.3, creatorClaimedSol: 0.05, platformSol: 0.2, platformSweptSol: 0.07 });
  });

  it("builds an unsigned claim transaction paid and signed by the creator", async () => {
    const res = await claim({ mint: f.mint, wallet: f.carol });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<CreatorClaimBuildResponse>();
    expect(body).toMatchObject({ claimableSol: 0.3, lastValidBlockHeight: 123_456 });

    const tx = VersionedTransaction.deserialize(Buffer.from(body.transaction, "base64"));
    const keys = tx.message.staticAccountKeys;
    expect(keys[0]!.toBase58()).toBe(f.carol);
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    const [limit, price, ix] = tx.message.compiledInstructions;
    expect(keys[limit!.programIdIndex]!.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(keys[price!.programIdIndex]!.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(keys[ix!.programIdIndex]!.equals(HOLDFAST_PROGRAM_ID)).toBe(true);
    expect(Buffer.from(ix!.data).equals(discriminator("claim_creator_fees"))).toBe(true); // no args
    const coin = await getCoin(db, f.mint);
    const accounts = ix!.accountKeyIndexes.map((i) => keys[i]!.toBase58());
    expect(accounts[0]).toBe(f.carol);
    expect(accounts).toContain(coin!.vault);
    expect(accounts).toContain(coin!.treasury);
  });

  it("refuses anyone but the creator, and an empty bucket", async () => {
    expect((await claim({ mint: f.mint, wallet: f.alice })).statusCode).toBe(403);
    expect((await claim({ mint: f.other, wallet: f.carol })).statusCode).toBe(403); // no creator recorded
    expect((await claim({ mint: Keypair.generate().publicKey.toBase58(), wallet: f.carol })).statusCode).toBe(404);
    expect((await claim({ mint: f.mint, wallet: "nope" })).statusCode).toBe(400);
    await applyVaultDelta(db, f.mint, { creatorSol: -300_000_000n, totalCreatorClaimed: 300_000_000n });
    const empty = await claim({ mint: f.mint, wallet: f.carol });
    expect(empty.statusCode).toBe(409);
    expect(empty.json()).toMatchObject({ error: "Nothing to claim yet" });
  });
});
