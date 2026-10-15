import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { coinKeys, TOKEN_2022_PROGRAM_ID, treasuryPda } from "@holdfast/chain";
import { getCoin, getWalletLaunch, isExcluded, type Db } from "@holdfast/db";

import { ValidationError } from "../src/metadata.js";
import { walletLaunchHandler } from "../src/walletLaunch.js";
import { WALLET_LAUNCH_TTL_MS } from "../src/worker.js";
import { defaultForm, freshDb, Harness, resetDb, SOL } from "./helpers.js";

let db: Db;
let h: Harness;

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

const decode = (b64: string) => VersionedTransaction.deserialize(Buffer.from(b64, "base64"));

describe("wallet-signed launch (the creator's wallet pays and signs, like a pump.fun create)", () => {
  it("co-signs one transaction the wallet only has to sign; once it lands the coin is registered", async () => {
    const wallet = Keypair.generate();
    h.chain.airdrop(wallet.publicKey, 2n * SOL);
    const launcherBefore = await h.chain.getBalance(h.launcher.publicKey);
    const prepared = await h.worker.prepareWalletLaunch({ ...defaultForm(), description: "woof", devBuySol: 0.5 }, wallet.publicKey.toBase58());
    const mint = new PublicKey(prepared.mint);

    const tx = decode(prepared.transaction);
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58());
    expect(signers[0]).toBe(wallet.publicKey.toBase58()); // fee payer
    expect(new Set(signers)).toEqual(new Set([wallet.publicKey.toBase58(), mint.toBase58(), h.launcher.publicKey.toBase58()]));
    expect(tx.signatures[0]!.every((b) => b === 0)).toBe(true); // only the wallet's signature is missing
    expect(tx.signatures.slice(1).every((s) => s.some((b) => b !== 0))).toBe(true);
    expect((await getWalletLaunch(db, prepared.mint))?.status).toBe("pending");

    // nothing is registered before the wallet sends it
    await h.tick();
    expect(await getCoin(db, prepared.mint)).toBeNull();

    await h.chain.sendAndConfirm(tx, [wallet]);
    expect(h.chain.landed.map((t) => t.kind)).toEqual(["launch"]);
    const spent = 2n * SOL - (await h.chain.getBalance(wallet.publicKey));
    expect(spent).toBeGreaterThan(SOL / 2n);
    expect(spent).toBeLessThanOrEqual(BigInt(prepared.maxCostLamports));
    expect(await h.chain.getBalance(h.launcher.publicKey)).toBe(launcherBefore); // reimbursed in the same transaction
    expect(h.chain.curve(mint).creator.equals(treasuryPda(mint))).toBe(true);
    expect(h.chain.vaultCreators.get(prepared.mint)).toBe(wallet.publicKey.toBase58());
    expect(h.chain.tokenBalance(wallet.publicKey, mint)).toBe(h.freshCurveQuote(treasuryPda(mint), SOL / 2n).tokens);

    await h.tick();
    expect((await getWalletLaunch(db, prepared.mint))?.status).toBe("live");
    const coin = await getCoin(db, prepared.mint);
    expect(coin).toMatchObject({ name: defaultForm().name, ticker: defaultForm().ticker, description: "woof", creator: wallet.publicKey.toBase58(), vault: coinKeys(mint, TOKEN_2022_PROGRAM_ID).vault.toBase58() });
    // the creator's wallet is a regular holder; the launcher never earns
    expect(await isExcluded(db, wallet.publicKey.toBase58())).toBe(false);
    expect(await isExcluded(db, h.launcher.publicKey.toBase58())).toBe(true);
  });

  it("records the form's creator wallet instead of the paying wallet", async () => {
    const wallet = Keypair.generate();
    const creatorWallet = Keypair.generate().publicKey.toBase58();
    h.chain.airdrop(wallet.publicKey, SOL);
    const prepared = await h.worker.prepareWalletLaunch({ ...defaultForm(), creatorWallet }, wallet.publicKey.toBase58());
    await h.chain.sendAndConfirm(decode(prepared.transaction), [wallet]);
    expect(h.chain.vaultCreators.get(prepared.mint)).toBe(creatorWallet);
    await h.tick();
    expect((await getCoin(db, prepared.mint))?.creator).toBe(creatorWallet);
  });

  it("expires when the wallet never sends it", async () => {
    const wallet = Keypair.generate();
    const prepared = await h.worker.prepareWalletLaunch(defaultForm(), wallet.publicKey.toBase58());
    h.advance(WALLET_LAUNCH_TTL_MS - 1_000);
    await h.tick();
    expect((await getWalletLaunch(db, prepared.mint))?.status).toBe("pending");
    h.advance(2_000);
    await h.tick();
    expect((await getWalletLaunch(db, prepared.mint))?.status).toBe("expired");
    expect(await getCoin(db, prepared.mint)).toBeNull();
  });

  it("refuses invalid launches and wallets", async () => {
    await expect(h.worker.prepareWalletLaunch(defaultForm(), "not-a-wallet")).rejects.toBeInstanceOf(ValidationError);
    await expect(h.worker.prepareWalletLaunch({ ...defaultForm(), triggerBps: 1234 as never }, Keypair.generate().publicKey.toBase58())).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("POST /wallet-launch handler", () => {
  it("answers 200 with the transaction, 422 for an unacceptable launch, 400 without a wallet", async () => {
    const handler = walletLaunchHandler(h.worker, h.logger);
    const wallet = Keypair.generate().publicKey.toBase58();
    const ok = await handler({ ...defaultForm(), wallet });
    expect(ok.status).toBe(200);
    expect((ok.body as { mint: string }).mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(await handler({ ...defaultForm(), name: "", wallet })).toMatchObject({ status: 422 });
    expect(await handler(defaultForm())).toMatchObject({ status: 400 });
    expect(await handler(null)).toMatchObject({ status: 400 });
  });

  it("needs the lookup table: without one the launch cannot be one transaction", async () => {
    const split = await Harness.create(db);
    try {
      await expect(walletLaunchHandler(split.worker, split.logger)({ ...defaultForm(), wallet: Keypair.generate().publicKey.toBase58() })).rejects.toThrow(/lookup table/);
    } finally {
      await split.close();
    }
  });
});
