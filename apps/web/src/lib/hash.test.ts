import { describe, expect, it } from "vitest";
import { hashString, mascotPalette, seededRandom } from "./hash";

describe("hashString", () => {
  it("is deterministic FNV-1a", () => {
    expect(hashString("")).toBe(0x811c9dc5);
    expect(hashString("a")).toBe(0xe40c292c);
    expect(hashString("mint")).toBe(hashString("mint"));
    expect(hashString("mintA")).not.toBe(hashString("mintB"));
  });
});

describe("seededRandom", () => {
  it("repeats for the same seed and stays in [0, 1)", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("mascotPalette", () => {
  it("derives stable, distinct palettes from mints", () => {
    const one = mascotPalette("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    expect(mascotPalette("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toEqual(one);
    const hues = new Set(Array.from({ length: 20 }, (_, i) => mascotPalette(`mint-${i}`).hue));
    expect(hues.size).toBeGreaterThan(12);
    expect(one.body).toMatch(/^hsl\(/);
    expect(["round", "happy", "wink"]).toContain(one.eyes);
  });
});
