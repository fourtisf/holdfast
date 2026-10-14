import { Keypair, PublicKey } from "@solana/web3.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LAUNCH_FEE_LAMPORTS } from "@holdfast/core";
import {
  atomicTxFee,
  deliverTxFee,
  COIN_VAULT_SIZE,
  coinKeys,
  DEFAULT_RENT,
  PUMP_BONDING_CURVE_SIZE,
  pumpMintSize,
  TOKEN_2022_ATA_SIZE,
  TOKEN_2022_PROGRAM_ID,
  treasuryPda,
  utf8Len,
} from "@holdfast/chain";
import { getCoin, type Db } from "@holdfast/db";

import { decryptMintSecret, mintSecretKey } from "../src/crypto.js";
import { metadataUriLength } from "../src/metadata.js";
import { pump } from "../src/pump.js";
import { defaultForm, freshDb, Harness, MASTER, resetDb, SOL } from "./helpers.js";

const rent = DEFAULT_RENT;
const form = defaultForm();
const createRent = rent(pumpMintSize(utf8Len(form.name), utf8Len(form.ticker), metadataUriLength("https://api.holdfast.test/metadata"))) + rent(PUMP_BONDING_CURVE_SIZE) + rent(TOKEN_2022_ATA_SIZE);
const initRent = rent(COIN_VAULT_SIZE) + rent(0);

let db: Db;
let h: Harness;
const sender = () => Keypair.generate().publicKey;

beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  h = await Harness.create(db, { atomic: true });
});
afterEach(async () => {
  await h.close();
});

async function mintOf(id: string): Promise<PublicKey> {
  const row = await h.row(id);
  return decryptMintSecret(mintSecretKey(MASTER), id, row.mintSecret!).publicKey;
}

describe("atomic launch (one v0 transaction with the lookup table)", () => {
  it("creates, registers and sends the leftover back in one transaction; the deposit ends empty", async () => {
    const { row, deposit, required } = await h.launch();
    const from = sender();
    const launcherBefore = await h.chain.getBalance(h.launcher.publicKey);
    // a typical launch costs at most the spec's 0.015 SOL, retry reserve included
    expect(required).toBe(LAUNCH_FEE_LAMPORTS);
    h.chain.fund(from, deposit.publicKey, required);

    await h.tick();
    const live = await h.row(row.id);
    expect(live.status).toBe("live");
    expect(live.error).toBeNull();
    expect(h.chain.landed.map((t) => t.kind)).toEqual(["launch"]);
    const launchTx = h.chain.landed[0]!;
    expect(launchTx.size).toBeLessThanOrEqual(1232);
    expect(live.createSig).toBe(launchTx.signature);
    expect(live.refundSig).toBe(launchTx.signature); // the leftover went back inside the launch tx

    const leftover = required - createRent - initRent - atomicTxFee(h.settings.priority, false);
    expect(await h.chain.getBalance(from)).toBe(SOL + leftover);
    expect(await h.chain.getBalance(deposit.publicKey)).toBe(0n);
    expect(await h.chain.getBalance(h.launcher.publicKey)).toBe(launcherBefore);

    const mint = await mintOf(row.id);
    const keys = coinKeys(mint, TOKEN_2022_PROGRAM_ID);
    expect(h.chain.curve(mint).creator.equals(treasuryPda(mint))).toBe(true);
    expect(h.chain.vaultTriggers.get(mint.toBase58())).toBe(2500);
    expect(await h.chain.accountExists(keys.vault)).toBe(true);
    const coin = await getCoin(db, mint.toBase58());
    expect(coin).toMatchObject({ name: form.name, launchSig: launchTx.signature, creator: from.toBase58() });
  });

  it("runs the dev buy in the launch transaction (no one can buy before it), then delivers it", async () => {
    const devBuy = SOL / 2n;
    const { row, deposit, required } = await h.launch(defaultForm(), { devBuyLamports: devBuy });
    const from = sender();
    h.chain.fund(from, deposit.publicKey, required);

    await h.tick();
    const live = await h.row(row.id);
    expect(live.error).toBeNull();
    expect(live.status).toBe("live");
    expect(h.chain.landed.map((t) => t.kind)).toEqual(["launch", "deliver"]);
    expect(h.chain.landed[0]!.size).toBeLessThanOrEqual(1232);
    expect(live.refundSig).toBe(h.chain.landed[1]!.signature);
    const mint = await mintOf(row.id);
    // priced on the untouched curve: the dev buy is the first trade of the coin
    const quote = h.freshCurveQuote(treasuryPda(mint), devBuy);
    expect(h.chain.tokenBalance(from, mint)).toBe(quote.tokens);
    expect(h.chain.tokenBalance(deposit.publicKey, mint)).toBeNull();
    expect(await h.chain.accountExists(pump.userVolumeAccumulatorPda(deposit.publicKey))).toBe(false);

    const leftover = required - createRent - initRent - atomicTxFee(h.settings.priority, true) - quote.cost - deliverTxFee(h.settings.priority) - rent(TOKEN_2022_ATA_SIZE);
    expect(await h.chain.getBalance(from)).toBe(SOL + leftover);
    expect(await h.chain.getBalance(deposit.publicKey)).toBe(0n);
    const coin = await getCoin(db, mint.toBase58());
    expect(coin!.launchSig).toBe(h.chain.landed[0]!.signature);
  });

  it("sends a leftover an emptied sender could not receive to the coin's treasury", async () => {
    const { row, deposit, required } = await h.launch();
    const from = sender();
    h.chain.fund(from, deposit.publicKey, required);
    h.chain.drain(from); // the sender sent its whole balance
    await h.tick();
    expect((await h.row(row.id)).status).toBe("live");
    const mint = await mintOf(row.id);
    const leftover = required - createRent - initRent - atomicTxFee(h.settings.priority, false);
    expect(leftover).toBeLessThan(rent(0));
    expect(await h.chain.getBalance(from)).toBe(0n);
    expect(await h.chain.getBalance(treasuryPda(mint))).toBe(rent(0) + leftover);
    expect(await h.chain.getBalance(deposit.publicKey)).toBe(0n);
  });

  it("resumes after a crash right after broadcasting, without repeating the launch", async () => {
    const { row, deposit, required } = await h.launch(defaultForm(), { devBuyLamports: SOL / 4n });
    const from = sender();
    h.chain.fund(from, deposit.publicKey, required);
    h.chain.inject({ kind: "launch", mode: "crash", times: 1 });
    const crashed = h.chain.nextCrash();
    void h.worker.tick();
    await crashed;
    h.worker = h.newWorker();
    h.advancePastGuard();
    await h.tick();
    const r = await h.row(row.id);
    expect(r.status).toBe("live");
    expect(h.chain.landed.map((t) => t.kind)).toEqual(["launch", "deliver"]);
    const mint = await mintOf(row.id);
    expect((await getCoin(db, mint.toBase58()))!.launchSig).toBe(h.chain.landed[0]!.signature);
    expect(h.chain.tokenBalance(from, mint)).toBe(h.freshCurveQuote(treasuryPda(mint), SOL / 4n).tokens);
    expect(await h.chain.getBalance(deposit.publicKey)).toBe(0n);
  });

  it("falls back to the split flow after rejected atomic attempts when the deposit covers it", async () => {
    const { row, deposit } = await h.launch();
    const from = sender();
    h.chain.fund(from, deposit.publicKey, SOL / 10n); // plenty
    h.chain.inject({ kind: "launch", mode: "reject", times: h.settings.atomicAttempts });
    for (let i = 0; i <= h.settings.atomicAttempts; i++) {
      await h.tick();
      h.advance(60_000);
    }
    const r = await h.row(row.id);
    expect(r.status).toBe("live");
    expect(h.chain.landed.map((t) => t.kind)).toEqual(["create", "init", "refund"]);
    expect(await h.chain.getBalance(deposit.publicKey)).toBe(0n);
  });

  it("uses the split flow right away when the launch does not fit one packet (long URI + dev buy)", async () => {
    await h.close();
    const longBase = `https://metadata.example.org/${"x".repeat(90)}`;
    h = await Harness.create(db, {
      atomic: true,
      metadata: { storeDir: h.settings.metadata.storeDir, publicBaseUrl: longBase, siteUrl: "https://holdfast.test" },
      metadataLocation: { kind: "local", publicBaseUrl: longBase, gatewayUrl: "https://ipfs.io" },
    });
    const { row, deposit } = await h.launch({ ...defaultForm(), imageUrl: undefined }, { devBuyLamports: SOL / 10n });
    h.chain.fund(sender(), deposit.publicKey, SOL);
    await h.tick();
    const r = await h.row(row.id);
    expect(r.status).toBe("live");
    expect(r.attempts).toBe(0);
    expect(h.chain.landed.map((t) => t.kind)).toEqual(["create", "init", "devBuy", "refund"]);
    expect(h.logs.some((l) => l.msg?.includes("too large"))).toBe(true);
  });

  it("refunds instead of starting a split launch the deposit cannot cover", async () => {
    const { row, deposit, required } = await h.launch();
    const from = sender();
    h.chain.fund(from, deposit.publicKey, required);
    h.chain.inject({ kind: "launch", mode: "reject", times: 99 });
    for (let i = 0; i <= h.settings.atomicAttempts; i++) {
      await h.tick();
      h.advance(60_000);
    }
    const r = await h.row(row.id);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/cannot cover the multi-transaction launch/);
    expect(h.chain.landed.map((t) => t.kind)).toEqual(["refund"]);
    expect(h.chain.count("create")).toBe(0);
  });
});
