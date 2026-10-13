import { hkdfSync } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { deriveDepositKeypair } from "@holdfast/chain";
import { describe, expect, it } from "vitest";

import { decryptMintSecret, encryptMintSecret, mintSecretKey } from "../src/crypto.js";

const master = Buffer.alloc(32, 9);
const id = "6f0f5a4e-2d5f-4f7e-9a39-0d8b1c2e3f40";

describe("mint secret encryption", () => {
  it("round-trips the mint keypair", () => {
    const key = mintSecretKey(master);
    const kp = Keypair.generate();
    const blob = encryptMintSecret(key, id, kp);
    expect(blob).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(decryptMintSecret(key, id, blob).publicKey.equals(kp.publicKey)).toBe(true);
    expect(encryptMintSecret(key, id, kp)).not.toBe(blob); // random IV
  });

  it("is bound to the launch id and the master secret", () => {
    const key = mintSecretKey(master);
    const blob = encryptMintSecret(key, id, Keypair.generate());
    expect(() => decryptMintSecret(key, "00000000-0000-4000-8000-000000000000", blob)).toThrow();
    expect(() => decryptMintSecret(mintSecretKey(Buffer.alloc(32, 1)), id, blob)).toThrow();
    const tampered = blob.slice(0, -2) + (blob.endsWith("A") ? "B" : "A") + blob.slice(-1);
    expect(() => decryptMintSecret(key, id, tampered)).toThrow();
  });

  it("uses its own HKDF domain (not a deposit key)", () => {
    const key = mintSecretKey(master);
    const depositSeed = deriveDepositKeypair(master, 0n).secretKey.subarray(0, 32);
    expect(Buffer.compare(key, Buffer.from(depositSeed))).not.toBe(0);
    expect(key.equals(Buffer.from(hkdfSync("sha256", master, Buffer.from("holdfast:launcher:v1"), Buffer.from("holdfast:mint-secret:v1"), 32)))).toBe(true);
  });
});
