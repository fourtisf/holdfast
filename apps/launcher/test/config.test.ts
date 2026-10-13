import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { loadConfig, loadKeypair, redactUrl } from "../src/config.js";

const kp = Keypair.generate();
const file = JSON.stringify(Array.from(kp.secretKey));
const env = {
  DATABASE_URL: "pglite://memory",
  DEPOSIT_MASTER_SECRET: "11".repeat(32),
  LAUNCHER_KEYPAIR: "./keys/launcher.json",
  METADATA_STORE: "./data/metadata",
  PUBLIC_METADATA_BASE_URL: "https://api.holdfast.fun/metadata/",
};

describe("config", () => {
  it("loads the launcher keypair from a file or inline", () => {
    expect(loadKeypair("./keys/launcher.json", () => file).publicKey.equals(kp.publicKey)).toBe(true);
    expect(loadKeypair(file).publicKey.equals(kp.publicKey)).toBe(true);
    expect(() => loadKeypair("[1,2,3]")).toThrow(/64-byte/);
    expect(() => loadKeypair("x", () => "nope")).toThrow(/JSON/);
  });

  it("parses the environment", () => {
    const c = loadConfig(env, () => file);
    expect(c.settings.launcher.publicKey.equals(kp.publicKey)).toBe(true);
    expect(c.settings.masterSecret).toEqual(Buffer.alloc(32, 0x11));
    expect(c.settings.metadata.publicBaseUrl).toBe("https://api.holdfast.fun/metadata");
    expect(c.settings.metadata.siteUrl).toBe("https://api.holdfast.fun");
    expect(c.settings.metadata.storeDir.endsWith("/data/metadata")).toBe(true);
    expect(c.settings.priority.microLamports).toBe(50_000n);
    expect(loadConfig({ ...env, PUBLIC_SITE_URL: "https://holdfast.fun/", LAUNCHER_PRIORITY_FEE_MICROLAMPORTS: "0" }, () => file).settings).toMatchObject({
      metadata: { siteUrl: "https://holdfast.fun" },
      priority: { microLamports: 0n },
    });
  });

  it("rejects missing secrets and unsupported stores", () => {
    expect(() => loadConfig({ ...env, DEPOSIT_MASTER_SECRET: "" }, () => file)).toThrow(/DEPOSIT_MASTER_SECRET/);
    expect(() => loadConfig({ ...env, DEPOSIT_MASTER_SECRET: "abc" }, () => file)).toThrow(/32 bytes/);
    expect(() => loadConfig({ ...env, METADATA_STORE: "s3://bucket/metadata" }, () => file)).toThrow(/local directory/);
    expect(() => loadConfig({ ...env, LAUNCHER_MAX_ATTEMPTS: "0" }, () => file)).toThrow(/LAUNCHER_MAX_ATTEMPTS/);
  });

  it("never prints RPC credentials", () => {
    expect(redactUrl("https://mainnet.helius-rpc.com/?api-key=SECRET")).toBe("https://mainnet.helius-rpc.com");
    expect(redactUrl("https://x.quiknode.pro/SECRET/")).toBe("https://x.quiknode.pro/…");
  });
});
