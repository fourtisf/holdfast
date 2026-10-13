import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { bondingCurveSpot, decodeBondingCurve, decodePool, decodeTokenAccount, poolSpot } from "../src/accounts.js";
import { WSOL_MINT } from "../src/constants.js";

describe("pump account decoders", () => {
  it("decodes a BondingCurve and prices it like the program", () => {
    const creator = Keypair.generate().publicKey;
    const d = Buffer.alloc(166);
    Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(d, 0);
    d.writeBigUInt64LE(1_073_000_000_000_000n, 8);
    d.writeBigUInt64LE(30_000_000_000n, 16);
    d.writeBigUInt64LE(793_100_000_000_000n, 24);
    creator.toBuffer().copy(d, 49);
    const c = decodeBondingCurve(d);
    expect(c.creator.equals(creator)).toBe(true);
    expect(c.complete).toBe(false);
    expect(c.solQuoted).toBe(true);
    expect(bondingCurveSpot(c)).toBe((30_000_000_000n * 10n ** 18n) / 1_073_000_000_000_000n);
    WSOL_MINT.toBuffer().copy(d, 83);
    expect(decodeBondingCurve(d).solQuoted).toBe(true);
    Keypair.generate().publicKey.toBuffer().copy(d, 83);
    expect(decodeBondingCurve(d).solQuoted).toBe(false);
    expect(() => decodeBondingCurve(Buffer.alloc(166))).toThrow();
  });

  it("decodes a Pool with signed virtual quote reserves", () => {
    const d = Buffer.alloc(300);
    Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(d, 0);
    const base = Keypair.generate().publicKey;
    base.toBuffer().copy(d, 43);
    WSOL_MINT.toBuffer().copy(d, 75);
    // −10 SOL as i128 little endian
    const v = -10_000_000_000n;
    d.writeBigUInt64LE(BigInt.asUintN(64, v), 245);
    d.writeBigInt64LE(v < 0n ? -1n : 0n, 253);
    const p = decodePool(d);
    expect(p.baseMint.equals(base)).toBe(true);
    expect(p.virtualQuoteReserves).toBe(v);
    expect(poolSpot(p, 100n, 50_000_000_000n)).toBe((40_000_000_000n * 10n ** 18n) / 100n);
  });

  it("decodes token accounts", () => {
    const d = Buffer.alloc(165);
    const mint = Keypair.generate().publicKey;
    mint.toBuffer().copy(d, 0);
    d.writeBigUInt64LE(42n, 64);
    d[108] = 1;
    const t = decodeTokenAccount(d);
    expect(t.mint.equals(mint)).toBe(true);
    expect(t.amount).toBe(42n);
    expect(t.initialized).toBe(true);
  });
});
