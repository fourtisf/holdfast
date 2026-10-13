import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { coinKeys, TOKEN_2022_PROGRAM_ID, treasuryPda } from "@holdfast/chain";
import { getCoin, listExcluded, type Db } from "@holdfast/db";

import { DEFAULT_RENT, txFee } from "@holdfast/chain";
import { decryptMintSecret, mintSecretKey } from "../src/crypto.js";
import { metadataUriLength } from "../src/metadata.js";
import { pump } from "../src/pump.js";
import {
  COIN_VAULT_SIZE,
  PUMP_BONDING_CURVE_SIZE,
  PUMP_USER_VOLUME_ACCUMULATOR_SIZE,
  pumpMintSize,
  SPL_TOKEN_ACCOUNT_SIZE,
  TOKEN_2022_ATA_SIZE,
  utf8Len,
} from "@holdfast/chain";
import { tokenAccountOf } from "../src/tx.js";
import { pumpCoder } from "./fakeChain.js";
import { defaultForm, freshDb, Harness, MASTER, resetDb, SOL } from "./helpers.js";

const rent = DEFAULT_RENT;
const form = defaultForm();
/** Rent tx A pays (pump mint + curve + curve token account). */
const createRent = rent(pumpMintSize(utf8Len(form.name), utf8Len(form.ticker), metadataUriLength("https://api.holdfast.test/metadata"))) + rent(PUMP_BONDING_CURVE_SIZE) + rent(TOKEN_2022_ATA_SIZE);
/** Rent the launcher pays in tx B and is reimbursed for. */
const initRent = rent(COIN_VAULT_SIZE) + rent(0) + rent(TOKEN_2022_ATA_SIZE) + rent(SPL_TOKEN_ACCOUNT_SIZE) + rent(PUMP_USER_VOLUME_ACCUMULATOR_SIZE);

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
  h = await Harness.create(db);
});
afterEach(async () => {
  await h.close();
});

async function mintOf(id: string): Promise<PublicKey> {
  const row = await h.row(id);
  return decryptMintSecret(mintSecretKey(MASTER), id, row.mintSecret!).publicKey;
}

describe("happy path", () => {
  it("launches without a dev buy: create, init, refund the rest, live", async () => {
    const { row, deposit, required } = await h.launch();
    const from = sender();
    const launcherBefore = await h.chain.getBalance(h.launcher.publicKey);
    const depositSig = h.chain.fund(from, deposit.publicKey, required);

    await h.tick();
    const live = await h.row(row.id);
    expect(live.status).toBe("live");
    expect(live.receivedLamports).toBe(required);
    expect(live.sender).toBe(from.toBase58());
    expect(live.depositSig).toBe(depositSig);
    expect(live.error).toBeNull();
    expect(live.attempts).toBe(0);
    const mint = await mintOf(row.id);
    expect(live.mint).toBe(mint.toBase58());
    expect(live.createSig).toBeTruthy();
    expect(live.refundSig).toBeTruthy();

    expect([h.chain.count("create"), h.chain.count("init"), h.chain.count("devBuy"), h.chain.count("refund")]).toEqual([1, 1, 0, 1]);
    // Refund = received − rent of everything created − every fee.
    const refund = required - createRent - initRent - txFee("create", h.settings.priority) - txFee("init", h.settings.priority) - txFee("refund", h.settings.priority);
    expect(await h.chain.getBalance(from)).toBe(SOL + refund);
    expect(await h.chain.getBalance(deposit.publicKey)).toBe(0n);
    expect(await h.chain.getBalance(h.launcher.publicKey)).toBe(launcherBefore);
    expect(h.chain.feesPaidBy(h.launcher.publicKey)).toBe(0n);

    // On-chain: creator = treasury PDA, vault registered with the chosen trigger.
    const keys = coinKeys(mint, TOKEN_2022_PROGRAM_ID);
    expect(h.chain.curve(mint).creator.equals(treasuryPda(mint))).toBe(true);
    expect(h.chain.vaultTriggers.get(mint.toBase58())).toBe(2500);
    expect(await h.chain.accountExists(keys.vault)).toBe(true);
    expect(await h.chain.accountExists(pump.userVolumeAccumulatorPda(keys.treasury))).toBe(true);
    expect(await h.chain.getBalance(keys.treasury)).toBe(rent(0));

    const coin = await getCoin(db, mint.toBase58());
    expect(coin).toMatchObject({
      name: form.name,
      ticker: form.ticker,
      imageUrl: form.imageUrl,
      description: form.description,
      socials: form.socials,
      triggerBps: 2500,
      creator: from.toBase58(),
      vault: keys.vault.toBase58(),
      treasury: keys.treasury.toBase58(),
      bondingCurve: keys.bondingCurve.toBase58(),
      tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
      decimals: 6,
      launchSig: live.createSig,
    });
    expect(coin!.metadataUri).toMatch(/^https:\/\/api\.holdfast\.test\/metadata\/[0-9a-f]{64}\.json$/);

    const excluded = new Map((await listExcluded(db)).map((e) => [e.address, e.reason]));
    expect(excluded.get(keys.vault.toBase58())).toBe("vault");
    expect(excluded.get(keys.treasury.toBase58())).toBe("treasury");
    expect(excluded.get(keys.bondingCurve.toBase58())).toBe("bonding_curve");
    expect(excluded.get(deposit.publicKey.toBase58())).toBe("deposit");
    expect(excluded.get(h.launcher.publicKey.toBase58())).toBe("launcher");

    // Metadata JSON written where the uri points.
    const file = coin!.metadataUri!.split("/").pop()!;
    const json = JSON.parse(await readFile(join(h.settings.metadata.storeDir, file), "utf8"));
    expect(json).toEqual({
      name: form.name,
      symbol: form.ticker,
      description: form.description,
      image: form.imageUrl,
      showName: true,
      createdOn: "https://holdfast.test",
      twitter: form.socials!.x,
      telegram: form.socials!.telegram,
      website: form.socials!.website,
    });
    const createIx = h.chain.landed.find((t) => t.kind === "create")!.tx.instructions.find((i) => i.programId.equals(pump.PUMP_PROGRAM_ID))!;
    const decoded = pumpCoder.instruction.decode(Buffer.from(createIx.data))!;
    expect((decoded.data as { uri: string }).uri).toBe(coin!.metadataUri);

    // deposit_received, creating, ..., live: every status change notified; the coin too.
    await h.flush();
    expect(h.launchNotes(row.id)).toBeGreaterThanOrEqual(4);
    expect(h.notes).toContainEqual({ kind: "coin", mint: mint.toBase58() });
  });

  it("launches with a dev buy: tokens to the sender by transfer, tx C is launch_sig, dev buy excluded", async () => {
    const devBuy = SOL / 2n;
    const { row, deposit, required } = await h.launch(defaultForm(), { devBuyLamports: devBuy });
    const from = sender();
    const launcherBefore = await h.chain.getBalance(h.launcher.publicKey);
    h.chain.fund(from, deposit.publicKey, required);

    await h.tick();
    const live = await h.row(row.id);
    expect(live.status).toBe("live");
    expect(live.error).toBeNull();
    const mint = await mintOf(row.id);
    expect([h.chain.count("create"), h.chain.count("init"), h.chain.count("devBuy"), h.chain.count("refund")]).toEqual([1, 1, 1, 1]);

    const quote = h.freshCurveQuote(treasuryPda(mint), devBuy);
    expect(h.chain.tokenBalance(from, mint)).toBe(quote.tokens);
    expect(h.chain.tokenBalance(deposit.publicKey, mint)).toBeNull(); // closed
    expect(await h.chain.accountExists(pump.userVolumeAccumulatorPda(deposit.publicKey))).toBe(false); // closed
    expect(quote.cost).toBeLessThanOrEqual(devBuy);

    const p = h.settings.priority;
    const refund = required - createRent - initRent - rent(TOKEN_2022_ATA_SIZE) - quote.cost - txFee("create", p) - txFee("init", p) - txFee("devBuy", p) - txFee("refund", p);
    expect(await h.chain.getBalance(from)).toBe(SOL + refund);
    expect(await h.chain.getBalance(deposit.publicKey)).toBe(0n);
    expect(await h.chain.getBalance(h.launcher.publicKey)).toBe(launcherBefore);

    const devBuySig = h.chain.landed.find((t) => t.kind === "devBuy")!.signature;
    const coin = await getCoin(db, mint.toBase58());
    expect(coin!.launchSig).toBe(devBuySig);
    expect(coin!.creator).toBe(from.toBase58());
    const excluded = new Map((await listExcluded(db)).map((e) => [e.address, e.reason]));
    expect(excluded.get(deposit.publicKey.toBase58())).toBe("deposit");
    expect(excluded.get(h.launcher.publicKey.toBase58())).toBe("launcher");
  });

  it("raises an under-quoted launch to its real cost before creating anything", async () => {
    const { row, deposit } = await h.launch(defaultForm(), { requiredLamports: 15_000_000n });
    h.chain.fund(sender(), deposit.publicKey, 15_000_000n);
    await h.tick();
    const r = await h.row(row.id);
    expect(r.status).toBe("awaiting_deposit");
    expect(r.receivedLamports).toBe(15_000_000n);
    expect(h.chain.landed).toHaveLength(0);
    expect(h.logs.some((l) => l.msg?.includes("quoted below its real cost"))).toBe(true);
  });
});

describe("deposits", () => {
  it("waits on an underpayment, then launches after the top-up", async () => {
    const { row, deposit, required } = await h.launch();
    const from = sender();
    h.chain.fund(from, deposit.publicKey, required / 2n);
    await h.tick();
    let r = await h.row(row.id);
    expect(r.status).toBe("awaiting_deposit");
    expect(r.receivedLamports).toBe(required / 2n);
    await h.flush();
    expect(h.launchNotes(row.id)).toBe(1);
    expect(h.chain.landed).toHaveLength(0);

    h.advance(10_000);
    h.chain.fund(from, deposit.publicKey, required - required / 2n);
    await h.tick();
    r = await h.row(row.id);
    expect(r.status).toBe("live");
    expect(r.receivedLamports).toBe(required);
    expect(r.sender).toBe(from.toBase58());
  });

  it("refunds an overpayment in full", async () => {
    const { row, deposit, required } = await h.launch();
    const from = sender();
    h.chain.fund(from, deposit.publicKey, required + 3n * SOL);
    await h.tick();
    expect((await h.row(row.id)).status).toBe("live");
    const p = h.settings.priority;
    const refund = required + 3n * SOL - createRent - initRent - txFee("create", p) - txFee("init", p) - txFee("refund", p);
    expect(await h.chain.getBalance(from)).toBe(SOL + refund);
  });

  it("expires a launch nothing was sent to", async () => {
    const { row } = await h.launch(defaultForm(), { ttlMs: 60_000 });
    await h.tick();
    expect((await h.row(row.id)).status).toBe("awaiting_deposit");
    h.advance(61_000);
    await h.tick();
    expect((await h.row(row.id)).status).toBe("expired");
    expect(h.chain.landed).toHaveLength(0);
    await h.flush();
    expect(h.launchNotes(row.id)).toBe(1);
  });

  it("refunds a deposit still below the required amount at expiry", async () => {
    const { row, deposit, required } = await h.launch(defaultForm(), { ttlMs: 60_000 });
    const from = sender();
    h.chain.fund(from, deposit.publicKey, required / 3n);
    await h.tick();
    h.advance(61_000);
    await h.tick();
    const r = await h.row(row.id);
    expect(r.status).toBe("refunded");
    expect(r.error).toBeNull();
    expect(r.refundSig).toBe(h.chain.landed[0]!.signature);
    expect(h.chain.landed.map((t) => t.kind)).toEqual(["refund"]);
    expect(await h.chain.getBalance(from)).toBe(SOL + required / 3n - txFee("refund", h.settings.priority));
    expect(await h.chain.getBalance(deposit.publicKey)).toBe(0n);
  });

  it("refunds a full deposit that arrives after expiry (launch already expired)", async () => {
    const { row, deposit, required } = await h.launch(defaultForm(), { ttlMs: 60_000 });
    h.advance(61_000);
    await h.tick();
    expect((await h.row(row.id)).status).toBe("expired");
    const from = sender();
    h.chain.fund(from, deposit.publicKey, required);
    await h.tick();
    const r = await h.row(row.id);
    expect(r.status).toBe("refunded");
    expect(r.receivedLamports).toBe(required);
    expect(h.chain.landed.map((t) => t.kind)).toEqual(["refund"]);
    expect(await h.chain.getBalance(from)).toBe(SOL + required - txFee("refund", h.settings.priority));
  });

  it("refunds a full deposit made after expiry but seen before the expired sweep", async () => {
    const { row, deposit, required } = await h.launch(defaultForm(), { ttlMs: 60_000 });
    h.advance(61_000);
    h.chain.fund(sender(), deposit.publicKey, required);
    await h.tick();
    expect((await h.row(row.id)).status).toBe("refunded");
    expect(h.chain.count("create")).toBe(0);
  });

  it("still launches a deposit made before expiry that the watcher only sees afterwards", async () => {
    const { row, deposit, required } = await h.launch(defaultForm(), { ttlMs: 60_000 });
    h.chain.fund(sender(), deposit.publicKey, required, h.clock.now + 30_000);
    h.advance(90_000);
    await h.tick();
    expect((await h.row(row.id)).status).toBe("live");
  });

  it("refunds a second deposit sent to a live launch", async () => {
    const { row, deposit, required } = await h.launch();
    const from = sender();
    h.chain.fund(from, deposit.publicKey, required);
    await h.tick();
    expect((await h.row(row.id)).status).toBe("live");
    const before = await h.chain.getBalance(from);
    h.advance(1_000);
    h.chain.fund(from, deposit.publicKey, SOL);
    await h.tick();
    expect(await h.chain.getBalance(from)).toBe(before + SOL - txFee("refund", h.settings.priority));
    expect((await h.row(row.id)).status).toBe("live");
    expect(h.chain.count("create")).toBe(1);
  });
});

describe("crash / retry", () => {
  for (const kind of ["create", "init", "devBuy", "refund"] as const) {
    it(`resumes after a crash right after broadcasting ${kind}, without repeating it`, async () => {
      const devBuy = SOL / 4n;
      const { row, deposit, required } = await h.launch(defaultForm(), { devBuyLamports: devBuy });
      const from = sender();
      h.chain.fund(from, deposit.publicKey, required);
      h.chain.inject({ kind, mode: "crash", times: 1 });
      const crashed = h.chain.nextCrash();
      void h.worker.tick(); // never settles: the process "died" with the transaction in flight
      await crashed;
      expect((await h.row(row.id)).status).toBe("creating");

      // A new process: the in-flight guard holds it back until the broadcast can no longer be pending.
      h.worker = h.newWorker();
      await h.tick();
      expect(h.chain.landed.filter((t) => t.kind === kind)).toHaveLength(1);
      expect((await h.row(row.id)).status).toBe("creating");

      h.advancePastGuard();
      await h.tick();
      const r = await h.row(row.id);
      expect(r.status).toBe("live");
      expect([h.chain.count("create"), h.chain.count("init"), h.chain.count("devBuy"), h.chain.count("refund")]).toEqual([1, 1, 1, 1]);
      const mint = await mintOf(row.id);
      const quote = h.freshCurveQuote(treasuryPda(mint), devBuy);
      expect(h.chain.tokenBalance(from, mint)).toBe(quote.tokens);
      const p = h.settings.priority;
      const refund = required - createRent - initRent - rent(TOKEN_2022_ATA_SIZE) - quote.cost - txFee("create", p) - txFee("init", p) - txFee("devBuy", p) - txFee("refund", p);
      expect(await h.chain.getBalance(from)).toBe(SOL + refund);
      expect(r.refundSig).toBe(h.chain.landed.find((t) => t.kind === "refund")!.signature);
      const coin = await getCoin(db, mint.toBase58());
      expect(coin!.launchSig).toBe(h.chain.landed.find((t) => t.kind === "devBuy")!.signature);
    });
  }

  it("never refunds twice when the process dies after broadcasting an expiry refund", async () => {
    const { row, deposit, required } = await h.launch(defaultForm(), { ttlMs: 60_000 });
    const from = sender();
    h.chain.fund(from, deposit.publicKey, required / 2n);
    h.advance(61_000);
    h.chain.inject({ kind: "refund", mode: "crash", times: 1 });
    const crashed = h.chain.nextCrash();
    void h.worker.tick();
    await crashed;
    expect((await h.row(row.id)).status).toBe("refunding");

    h.worker = h.newWorker();
    h.advancePastGuard();
    await h.tick();
    const r = await h.row(row.id);
    expect(r.status).toBe("refunded");
    expect(r.refundSig).toBe(h.chain.landed[0]!.signature);
    expect(h.chain.count("refund")).toBe(1);
    expect(await h.chain.getBalance(from)).toBe(SOL + required / 2n - txFee("refund", h.settings.priority));
  });

  it("retries a transaction that expired, with backoff", async () => {
    const { row, deposit, required } = await h.launch();
    h.chain.fund(sender(), deposit.publicKey, required);
    h.chain.inject({ kind: "init", mode: "expire", times: 1 });
    await h.tick();
    let r = await h.row(row.id);
    expect(r.status).toBe("creating");
    expect(r.attempts).toBe(1);
    expect(r.error).toMatch(/^init: injected expiry/);
    await h.tick(); // not due yet
    expect(h.chain.count("init")).toBe(0);
    h.advancePastGuard();
    await h.tick();
    r = await h.row(row.id);
    expect(r.status).toBe("live");
    expect(r.error).toBeNull();
    expect(h.chain.count("create")).toBe(1);
  });
});

describe("failures", () => {
  it("fails and refunds when the vault can never be initialized (wrong launcher wallet)", async () => {
    await h.close();
    h = await Harness.create(db, {}, Keypair.generate().publicKey);
    const { row, deposit, required } = await h.launch();
    const from = sender();
    h.chain.fund(from, deposit.publicKey, required);
    for (let i = 0; i < h.settings.maxAttempts; i++) {
      await h.tick();
      h.advance(60_000);
    }
    const r = await h.row(row.id);
    expect(r.status).toBe("failed");
    expect(r.attempts).toBe(h.settings.maxAttempts);
    expect(r.error).toMatch(/vault was never initialized/);
    expect(r.mint).toBeNull();
    expect(h.chain.count("create")).toBe(1);
    expect(h.chain.count("init")).toBe(0);
    const p = h.settings.priority;
    expect(await h.chain.getBalance(from)).toBe(SOL + required - createRent - txFee("create", p) - txFee("refund", p));
    // The coin exists on pump.fun (creator = treasury): it stays registered so a manual init_coin can adopt it.
    const orphan = await getCoin(db, (await mintOf(row.id)).toBase58());
    expect(orphan).toMatchObject({ creator: from.toBase58(), launchSig: r.createSig });
    expect(h.logs.some((l) => l.level === "error" && l.msg?.includes("needs a manual init_coin"))).toBe(true);
  });

  it("fails and refunds everything when the coin cannot be created", async () => {
    h.chain.inject({ kind: "create", mode: "reject" });
    const { row, deposit, required } = await h.launch();
    const from = sender();
    h.chain.fund(from, deposit.publicKey, required);
    for (let i = 0; i < h.settings.maxAttempts; i++) {
      await h.tick();
      h.advance(60_000);
    }
    const r = await h.row(row.id);
    expect(r.status).toBe("failed");
    expect(r.refundSig).toBeTruthy();
    expect(await h.chain.getBalance(from)).toBe(SOL + required - txFee("refund", h.settings.priority));
  });

  it("goes live without the dev buy when it keeps failing, refunding the dev buy SOL", async () => {
    h.chain.inject({ kind: "devBuy", mode: "reject" });
    const devBuy = SOL;
    const { row, deposit, required } = await h.launch(defaultForm(), { devBuyLamports: devBuy });
    const from = sender();
    h.chain.fund(from, deposit.publicKey, required);
    for (let i = 0; i <= h.settings.maxAttempts; i++) {
      await h.tick();
      h.advance(60_000);
    }
    const r = await h.row(row.id);
    expect(r.status).toBe("live");
    expect(r.error).toMatch(/dev buy skipped/);
    expect(h.chain.count("devBuy")).toBe(0);
    const mint = await mintOf(row.id);
    expect(h.chain.tokenBalance(from, mint)).toBeNull();
    const p = h.settings.priority;
    expect(await h.chain.getBalance(from)).toBe(SOL + required - createRent - initRent - txFee("create", p) - txFee("init", p) - txFee("refund", p));
    // Attempts at tx C pointed launch_sig at their signatures; with no dev buy it is the create tx again.
    expect((await getCoin(db, mint.toBase58()))!.launchSig).toBe(r.createSig);
  });

  it("refunds an invalid launch (image not under our metadata base) without creating anything", async () => {
    const bad = { ...defaultForm(), imageUrl: "https://evil.example/x.png" };
    const { row, deposit, required } = await h.launch(bad);
    const from = sender();
    h.chain.fund(from, deposit.publicKey, required);
    await h.tick();
    const r = await h.row(row.id);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/invalid launch: image URL/);
    expect(h.chain.landed.map((t) => t.kind)).toEqual(["refund"]);
    expect(await h.chain.getBalance(from)).toBe(SOL + required - txFee("refund", h.settings.priority));
  });

  it("goes live with the refund pending when the final refund keeps failing; the sweep sends it later", async () => {
    const { row, deposit, required } = await h.launch();
    const from = sender();
    h.chain.fund(from, deposit.publicKey, required);
    // maxAttempts failures inside the launch + one more for the sweep that runs in the same tick.
    h.chain.inject({ kind: "refund", mode: "reject", times: h.settings.maxAttempts + 1 });
    for (let i = 0; i < h.settings.maxAttempts; i++) {
      await h.tick();
      h.advance(60_000);
    }
    let r = await h.row(row.id);
    expect(r.status).toBe("live");
    expect(r.error).toMatch(/refund pending/);
    expect(h.chain.count("refund")).toBe(0);
    await h.tick(); // sweep
    r = await h.row(row.id);
    expect(h.chain.count("refund")).toBe(1);
    expect(r.error).toBeNull();
    expect(r.refundSig).toBe(h.chain.landed.find((t) => t.kind === "refund")!.signature);
    expect(await h.chain.getBalance(deposit.publicKey)).toBe(0n);
  });
});

describe("mint keypair", () => {
  it("is generated once and reused by every retry", async () => {
    const { row, deposit, required } = await h.launch();
    h.chain.fund(sender(), deposit.publicKey, required);
    h.chain.inject({ kind: "create", mode: "reject", times: 1 });
    await h.tick();
    const first = await h.row(row.id);
    expect(first.status).toBe("creating");
    expect(first.mintSecret).toMatch(/^v1\./);
    expect(first.mintSecret).not.toContain(Buffer.from(decryptMintSecret(mintSecretKey(MASTER), row.id, first.mintSecret!).secretKey).toString("base64"));
    h.advance(60_000);
    await h.tick();
    const done = await h.row(row.id);
    expect(done.status).toBe("live");
    expect(done.mintSecret).toBe(first.mintSecret);
    expect(done.mint).toBe((await mintOf(row.id)).toBase58());
    const created = pumpCoder.instruction.decode(
      Buffer.from(h.chain.landed.find((t) => t.kind === "create")!.tx.instructions.find((i) => i.programId.equals(pump.PUMP_PROGRAM_ID))!.data),
    )!;
    expect((created.data as { creator: PublicKey }).creator.equals(treasuryPda(new PublicKey(done.mint!)))).toBe(true);
    expect(tokenAccountOf).toBeTypeOf("function");
  });
});

describe("throughput", () => {
  it("handles several launches in one tick, each with its own mint and refund", async () => {
    const launches = await Promise.all([0, 1, 2, 3, 4].map(() => h.launch()));
    const senders = launches.map(() => sender());
    launches.forEach((l, i) => h.chain.fund(senders[i]!, l.deposit.publicKey, l.required + BigInt(i) * 1_000_000n));
    await h.tick();
    const rows = await Promise.all(launches.map((l) => h.row(l.row.id)));
    expect(rows.map((r) => r.status)).toEqual(["live", "live", "live", "live", "live"]);
    expect(new Set(rows.map((r) => r.mint)).size).toBe(5);
    expect(h.chain.count("create")).toBe(5);
    expect(h.chain.count("refund")).toBe(5);
    const p = h.settings.priority;
    for (const [i, l] of launches.entries()) {
      const refund = l.required + BigInt(i) * 1_000_000n - createRent - initRent - txFee("create", p) - txFee("init", p) - txFee("refund", p);
      expect(await h.chain.getBalance(senders[i]!)).toBe(SOL + refund);
    }
  });
});
