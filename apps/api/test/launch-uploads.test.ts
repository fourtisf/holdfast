import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { LaunchQuote, LaunchResponse, LaunchStatus } from "@holdfast/core";
import { getLaunch, isExcluded, updateLaunchStatus, type Db } from "@holdfast/db";
import { deriveDepositKeypair, launchPlanFromEnv, parseMasterSecret } from "@holdfast/chain";
import { hkdfDepositAllocator, lamportsToSolString, parseLaunchRequest, sniffImage, solanaPayUrl, tokensToRaw } from "../src/index.js";
import { launchCost, toLaunchQuote } from "../src/launch/cost.js";
import { launchCostSettings } from "../src/launch/settings.js";
import { freshDb, makeApi, NOW, resetDb, type TestApi } from "./helpers.js";

let db: Db;
let api: TestApi;

beforeAll(async () => {
  db = await freshDb();
  api = await makeApi(db);
});
beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await api.app.close();
  await db.close();
});

const valid = { name: "Dog Coin", ticker: "DOG", triggerBps: 2500 };

describe("GET /launch/quote", () => {
  it("quotes the launcher's real cost (rent + fees, never below the spec's 0.015 SOL)", async () => {
    const base = (await api.app.inject({ method: "GET", url: "/launch/quote" })).json<LaunchQuote>();
    expect(base.specFeeSol).toBe(0.015);
    expect(base.launchFeeSol).toBeGreaterThanOrEqual(0.015);
    expect(base.requiredSol).toBe(base.launchFeeSol);
    expect(base.exceedsSpecFee).toBe(true);
    const withBuy = (await api.app.inject({ method: "GET", url: "/launch/quote?devBuySol=1&name=Dog%20Coin&ticker=DOG" })).json<LaunchQuote>();
    expect(withBuy.devBuySol).toBe(1);
    expect(withBuy.devBuyExtraSol).toBeGreaterThan(0);
    expect(withBuy.requiredSol).toBeCloseTo(withBuy.launchFeeSol + 1 + withBuy.devBuyExtraSol, 9);
    // shorter metadata than the worst case costs slightly less rent
    expect(withBuy.launchFeeSol).toBeLessThanOrEqual(base.launchFeeSol);
    expect((await api.app.inject({ method: "GET", url: "/launch/quote?devBuySol=50" })).statusCode).toBe(400);
  });

  it("an atomic launcher with IPFS metadata charges exactly the spec's 0.015 SOL for a typical coin", () => {
    const plan = launchPlanFromEnv({ LAUNCHER_LOOKUP_TABLE: "11111111111111111111111111111111", METADATA_STORAGE: "pinata" }, { publicMetadataBaseUrl: "http://localhost:4000/metadata" });
    expect(plan.mode).toBe("atomic");
    const quote = toLaunchQuote(launchCost(plan, { name: "Dog Coin", ticker: "DOG" }));
    expect(quote).toMatchObject({ launchFeeSol: 0.015, requiredSol: 0.015, exceedsSpecFee: false });
    // even the longest name and ticker stay within 0.015 SOL of real cost
    expect(launchCost(plan, {}).consumed).toBeLessThanOrEqual(15_000_000n);
  });
});

describe("POST /launch", () => {
  it("creates a launch with a deposit address and a solana: pay URL", async () => {
    const res = await api.app.inject({
      method: "POST",
      url: "/launch",
      payload: { ...valid, description: "woof", devBuySol: 0.5, socials: { x: "@dogcoin", telegram: "https://t.me/dogcoin", website: "https://dog.example" } },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<LaunchResponse>();
    // the launcher's real cost model: launch rent/fees (≥ 0.015 SOL) + dev buy + dev-buy accounts and float
    const required = launchCost(launchCostSettings(api.config), { name: "Dog Coin", ticker: "DOG", devBuySol: 0.5 }).requiredLamports;
    expect(required).toBeGreaterThan(515_000_000n);
    expect(body).toMatchObject({ requiredLamports: required.toString(), requiredSol: Number(required) / 1e9, expiresAt: NOW + 30 * 60_000 });
    expect(body.solanaPayUrl).toBe(`solana:${body.depositAddress}?amount=${lamportsToSolString(required)}&label=Moatpad&message=Launch%20%24DOG`);
    expect(await isExcluded(db, body.depositAddress)).toBe(true);

    const row = await getLaunch(db, body.launchId);
    expect(row).toMatchObject({ status: "awaiting_deposit", devBuyLamports: 500_000_000n, requiredLamports: required });
    expect(row?.form.socials).toEqual({ x: "https://x.com/dogcoin", telegram: "https://t.me/dogcoin", website: "https://dog.example" });

    const status = await api.app.inject({ method: "GET", url: `/launch/${body.launchId}` });
    expect(status.json<LaunchStatus>()).toEqual({
      launchId: body.launchId,
      status: "awaiting_deposit",
      depositAddress: body.depositAddress,
      requiredLamports: required.toString(),
      receivedLamports: "0",
      sender: null,
      mint: null,
      refundSig: null,
      error: null,
      updatedAt: expect.any(Number),
      // what a payment page opened from the Telegram bot needs
      name: "Dog Coin",
      ticker: "DOG",
      devBuySol: 0.5,
      // nobody named: the creator fees go to the wallet that pays
      creatorWallet: null,
      expiresAt: NOW + 30 * 60_000,
    });
    await updateLaunchStatus(db, body.launchId, "deposit_received", { receivedLamports: 600_000_000n, sender: "Sender1" });
    expect((await api.app.inject({ method: "GET", url: `/launch/${body.launchId}` })).json()).toMatchObject({ status: "deposit_received", receivedLamports: "600000000", sender: "Sender1" });
    expect((await api.app.inject({ method: "GET", url: "/launch/6f1c5c34-8a32-4bb1-9d0e-6a7a0f8b2a11" })).statusCode).toBe(404);
  });

  it("refuses launches while they are paused, and says so in the quote", async () => {
    const paused = await makeApi(db, { launchesPaused: true });
    try {
      const res = await paused.app.inject({ method: "POST", url: "/launch", payload: valid });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: "Launches are not open yet" });
      expect((await paused.app.inject({ method: "GET", url: "/launch/quote" })).json<LaunchQuote>().launchesPaused).toBe(true);
      expect((await api.app.inject({ method: "GET", url: "/launch/quote" })).json<LaunchQuote>().launchesPaused).toBe(false);
    } finally {
      await paused.app.close();
    }
  });

  it("records an optional creator wallet; it must be a regular wallet", async () => {
    const creatorWallet = Keypair.generate().publicKey.toBase58();
    const res = await api.app.inject({ method: "POST", url: "/launch", payload: { ...valid, creatorWallet } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await getLaunch(db, res.json<LaunchResponse>().launchId))?.form.creatorWallet).toBe(creatorWallet);
    // the payment page shows who gets the creator fees
    expect((await api.app.inject({ method: "GET", url: `/launch/${res.json<LaunchResponse>().launchId}` })).json<LaunchStatus>().creatorWallet).toBe(creatorWallet);
    // empty means "the deposit's sender"
    const blank = await api.app.inject({ method: "POST", url: "/launch", payload: { ...valid, creatorWallet: " " } });
    expect(blank.statusCode, blank.body).toBe(200);
    expect((await getLaunch(db, blank.json<LaunchResponse>().launchId))?.form.creatorWallet).toBeUndefined();
    // a program address can never sign a claim
    const pda = PublicKey.findProgramAddressSync([Buffer.from("x")], Keypair.generate().publicKey)[0].toBase58();
    const bad = await api.app.inject({ method: "POST", url: "/launch", payload: { ...valid, creatorWallet: pda } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/creatorWallet/);
  });

  it.each([
    [{ ...valid, name: "x".repeat(33) }, "name"],
    // pump.fun's limit is 32 UTF-8 bytes: 19 Cyrillic letters (36 bytes), accents, emoji
    [{ ...valid, name: "Пушистый Кот Монета" }, "name"],
    [{ ...valid, name: "Crème Brûlée Pâtisserie Royale" }, "name"],
    [{ ...valid, name: "🐸 Frog King of the Pond 🐸👑" }, "name"],
    [{ ...valid, ticker: "TOOLONGTICKER" }, "ticker"],
    [{ ...valid, ticker: "DO-G" }, "ticker"],
    [{ ...valid, triggerBps: 2000 }, "triggerBps"],
    [{ ...valid, devBuySol: 11 }, "devBuySol"],
    [{ ...valid, devBuySol: -1 }, "devBuySol"],
    [{ ...valid, description: "d".repeat(501) }, "description"],
    [{ ...valid, socials: { x: "not a handle!" } }, "socials.x"],
    [{ ...valid, socials: { website: "javascript:alert(1)" } }, "socials.website"],
    [{ ...valid, imageUrl: "ftp://x" }, "imageUrl"],
    [{ ...valid, extra: true }, ""],
  ])("rejects %j", async (payload, field) => {
    const res = await api.app.inject({ method: "POST", url: "/launch", payload });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain(field);
  });

  it("accepts a name of exactly 32 bytes", async () => {
    const name = "Café Moat Dog Coin of the Ponds"; // 31 characters, 32 bytes
    expect(Buffer.byteLength(name)).toBe(32);
    expect(parseLaunchRequest({ ...valid, name }).name).toBe(name);
    expect(() => parseLaunchRequest({ ...valid, name: "🐶".repeat(9) })).toThrow(/at most 32 bytes/);
    expect(parseLaunchRequest({ ...valid, name: "🐶".repeat(8) }).name).toBe("🐶".repeat(8));
  });

  it("normalizes the request", () => {
    expect(parseLaunchRequest({ name: " Dog ", ticker: "$dog", triggerBps: 1500, description: "", socials: { x: "", telegram: "@dogs_tg" } })).toEqual({
      name: "Dog",
      ticker: "DOG",
      triggerBps: 1500,
      socials: { telegram: "https://t.me/dogs_tg" },
    });
  });
});

describe("POST /uploads/image", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest-of-png")]);

  function multipart(content: Buffer, filename = "a.png", type = "image/png", field = "file") {
    const boundary = "----holdfast";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { payload: body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
  }

  it("stores by content hash and serves it under /metadata", async () => {
    const res = await api.app.inject({ method: "POST", url: "/uploads/image", ...multipart(PNG) });
    expect(res.statusCode, res.body).toBe(200);
    const { imageUrl } = res.json<{ imageUrl: string }>();
    expect(imageUrl).toMatch(/^http:\/\/localhost:4000\/metadata\/[0-9a-f]{64}\.png$/);
    const name = imageUrl.split("/").pop()!;
    expect(readFileSync(join(api.config.metadataDir, name))).toEqual(PNG);
    const again = await api.app.inject({ method: "POST", url: "/uploads/image", ...multipart(PNG, "b.jpg", "image/jpeg") });
    expect(again.json()).toEqual({ imageUrl });
    const served = await api.app.inject({ method: "GET", url: `/metadata/${name}` });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.rawPayload).toEqual(PNG);
  });

  it("rejects non-images, oversize files and wrong fields", async () => {
    const text = await api.app.inject({ method: "POST", url: "/uploads/image", ...multipart(Buffer.from("<svg/>"), "x.svg", "image/svg+xml") });
    expect(text.statusCode).toBe(415);
    expect(text.json()).toHaveProperty("error");
    const big = await api.app.inject({ method: "POST", url: "/uploads/image", ...multipart(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])) });
    expect(big.statusCode).toBe(413);
    expect(big.json<{ error: string }>().error).toBeTruthy();
    const field = await api.app.inject({ method: "POST", url: "/uploads/image", ...multipart(PNG, "a.png", "image/png", "image") });
    expect(field.statusCode).toBe(400);
    const json = await api.app.inject({ method: "POST", url: "/uploads/image", payload: { file: "x" } });
    expect(json.statusCode).toBe(415);
    expect(existsSync(api.config.metadataDir)).toBe(true);
  });

  it("sniffs magic bytes", () => {
    expect(sniffImage(PNG)?.ext).toBe("png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe("jpg");
    expect(sniffImage(Buffer.from("GIF89a....."))?.ext).toBe("gif");
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))?.ext).toBe("webp");
    expect(sniffImage(Buffer.from("hello"))).toBeNull();
  });
});

describe("helpers", () => {
  it("deposit addresses use the shared HKDF derivation (launcher can re-derive the key)", async () => {
    const hex = "11".repeat(32);
    const allocate = hkdfDepositAllocator(hex);
    expect(await allocate(7n)).toBe(deriveDepositKeypair(parseMasterSecret(hex), 7n).publicKey.toBase58());
    expect(await allocate(7n)).not.toBe(await allocate(8n));
    expect(() => hkdfDepositAllocator("abcd")).toThrow();
  });

  it("formats amounts", () => {
    expect(lamportsToSolString(15_000_000n)).toBe("0.015");
    expect(lamportsToSolString(2_000_000_000n)).toBe("2");
    expect(tokensToRaw(1.5, 6)).toBe(1_500_000n);
    expect(tokensToRaw(1_000_000, 6)).toBe(1_000_000_000_000n);
    expect(solanaPayUrl("Addr", 15_000_000n, "A B")).toBe("solana:Addr?amount=0.015&label=Moatpad&message=Launch%20%24A%20B");
  });
});
