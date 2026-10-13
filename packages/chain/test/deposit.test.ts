import { describe, expect, it } from "vitest";
import { deriveDepositKeypair, parseMasterSecret } from "../src/deposit.js";

const SECRET = parseMasterSecret("11".repeat(32));

describe("deposit derivation", () => {
  it("is deterministic and unique per index", () => {
    const a = deriveDepositKeypair(SECRET, 1n).publicKey.toBase58();
    expect(deriveDepositKeypair(SECRET, 1n).publicKey.toBase58()).toBe(a);
    expect(deriveDepositKeypair(SECRET, 2n).publicKey.toBase58()).not.toBe(a);
    expect(deriveDepositKeypair(parseMasterSecret("22".repeat(32)), 1n).publicKey.toBase58()).not.toBe(a);
  });

  it("rejects malformed secrets", () => {
    expect(() => parseMasterSecret("abc")).toThrow();
    expect(() => deriveDepositKeypair(Buffer.alloc(16), 1n)).toThrow();
  });
});
