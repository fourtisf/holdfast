import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { treasuryPda } from "@holdfast/chain";

import {
  assertUriFits,
  buildMetadataJson,
  metadataUriLength,
  normalizeForm,
  validateImageUrl,
  ValidationError,
  writeMetadata,
} from "../src/metadata.js";
import { defaultForm } from "./helpers.js";

const BASE = "https://api.holdfast.test/metadata";

describe("validateImageUrl", () => {
  it("accepts files under the metadata base and null", () => {
    expect(validateImageUrl(`${BASE}/images/a.png`, BASE)).toBe(`${BASE}/images/a.png`);
    expect(validateImageUrl(`${BASE}/a.webp`, `${BASE}/`)).toBe(`${BASE}/a.webp`);
    expect(validateImageUrl(undefined, BASE)).toBeNull();
    expect(validateImageUrl(null, BASE)).toBeNull();
    expect(validateImageUrl("  ", BASE)).toBeNull();
  });

  it.each([
    "https://evil.example/metadata/a.png",
    "http://api.holdfast.test/metadata/a.png",
    "https://api.holdfast.test/metadata-evil/a.png",
    "https://api.holdfast.test/other/a.png",
    `${BASE}/`,
    `${BASE}/../secret.png`,
    `${BASE}/images/%2e%2e/%2e%2e/x.png`,
    `${BASE}/a%2Fb.png`,
    `${BASE}/a.png?x=1`,
    `${BASE}/a.png#frag`,
    "https://user:pw@api.holdfast.test/metadata/a.png",
    "javascript:alert(1)",
    "not a url",
  ])("rejects %s", (url) => {
    expect(() => validateImageUrl(url, BASE)).toThrow(ValidationError);
  });
});

describe("creator wallet", () => {
  it("is optional, must be a valid on-curve address", () => {
    expect(normalizeForm(defaultForm(), BASE).creatorWallet).toBeNull();
    const wallet = Keypair.generate().publicKey.toBase58();
    expect(normalizeForm({ ...defaultForm(), creatorWallet: ` ${wallet} ` }, BASE).creatorWallet).toBe(wallet);
    expect(() => normalizeForm({ ...defaultForm(), creatorWallet: "not-a-wallet" }, BASE)).toThrow(/valid Solana address/);
    // a program address (off-curve) can never sign a claim
    expect(() => normalizeForm({ ...defaultForm(), creatorWallet: treasuryPda(Keypair.generate().publicKey).toBase58() }, BASE)).toThrow(/regular wallet/);
  });
});

describe("normalizeForm", () => {
  it("trims, keeps socials that are set, validates pump.fun limits", () => {
    const form = normalizeForm({ ...defaultForm(), name: "  Holdfast  ", socials: { x: " https://x.com/h ", telegram: "" } }, BASE);
    expect(form.name).toBe("Holdfast");
    expect(form.socials).toEqual({ x: "https://x.com/h" });
    expect(() => normalizeForm({ ...defaultForm(), name: "x".repeat(33) }, BASE)).toThrow(/name/);
    expect(() => normalizeForm({ ...defaultForm(), name: "é".repeat(17) }, BASE)).toThrow(/name/); // 34 bytes
    expect(() => normalizeForm({ ...defaultForm(), ticker: "" }, BASE)).toThrow(/ticker/);
    expect(() => normalizeForm({ ...defaultForm(), ticker: "T".repeat(14) }, BASE)).toThrow(/ticker/);
    expect(() => normalizeForm({ ...defaultForm(), triggerBps: 2000 as never }, BASE)).toThrow(/trigger/);
  });
});

describe("metadata JSON", () => {
  it("has pump.fun's shape and is written content-addressed, idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meta-"));
    const form = normalizeForm(defaultForm(), BASE);
    const json = buildMetadataJson(form, "https://holdfast.test");
    expect(Object.keys(json)).toEqual(["name", "symbol", "description", "image", "showName", "createdOn", "twitter", "telegram", "website"]);
    expect(json).toMatchObject({ name: "Holdfast Test", symbol: "HFT", showName: true, createdOn: "https://holdfast.test", image: `${BASE}/images/abc123.png` });

    const settings = { storeDir: join(dir, "nested"), publicBaseUrl: BASE, siteUrl: "https://holdfast.test" };
    const doc = await writeMetadata(json, settings);
    const body = readFileSync(doc.path, "utf8");
    expect(JSON.parse(body)).toEqual(json);
    expect(doc.file).toBe(`${createHash("sha256").update(body).digest("hex")}.json`);
    expect(doc.uri).toBe(`${BASE}/${doc.file}`);
    expect(doc.uri.length).toBe(metadataUriLength(BASE));
    expect(await writeMetadata(json, settings)).toEqual(doc);
    expect(readdirSync(settings.storeDir)).toEqual([doc.file]); // no temp files left behind
    rmSync(dir, { recursive: true, force: true });

    const bare = buildMetadataJson({ ...form, imageUrl: null, socials: {} }, "https://holdfast.test");
    expect(bare).toEqual({ name: "Holdfast Test", symbol: "HFT", description: form.description, showName: true, createdOn: "https://holdfast.test" });
  });

  it("refuses a base URL whose metadata URIs would exceed pump.fun's 200 bytes", () => {
    expect(() => assertUriFits(`https://x.example/${"a".repeat(120)}`)).toThrow(/too long/);
    expect(() => assertUriFits(BASE)).not.toThrow();
  });
});
