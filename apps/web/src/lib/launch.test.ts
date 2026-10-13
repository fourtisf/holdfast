import { describe, expect, it } from "vitest";
import { normalizeSocial, normalizeTicker, parseDevBuy, requiredDepositSol, toLaunchRequest, validateLaunch, type LaunchForm } from "./launch";

const base: LaunchForm = { name: "Kelp Lord", ticker: "KELP", description: "", imageUrl: null, x: "", telegram: "", website: "", triggerBps: 2500, devBuy: "" };

describe("normalizeTicker", () => {
  it("uppercases and strips non-alphanumerics", () => {
    expect(normalizeTicker("$kelp lord!")).toBe("KELPLORD");
    expect(normalizeTicker("abcdefghijklmnop")).toBe("ABCDEFGHIJ");
  });
});

describe("normalizeSocial", () => {
  it("turns handles into links", () => {
    expect(normalizeSocial("x", "@kelplord")).toBe("https://x.com/kelplord");
    expect(normalizeSocial("telegram", "kelplord")).toBe("https://t.me/kelplord");
  });
  it("accepts matching URLs and rejects foreign hosts", () => {
    expect(normalizeSocial("x", "https://twitter.com/kelp")).toBe("https://twitter.com/kelp");
    expect(normalizeSocial("telegram", "t.me/kelp")).toBe("https://t.me/kelp");
    expect(normalizeSocial("x", "https://example.com/kelp")).toBeNull();
  });
  it("adds https to websites", () => {
    expect(normalizeSocial("website", "kelplord.fun")).toBe("https://kelplord.fun/");
    expect(normalizeSocial("website", "not a url")).toBeNull();
    expect(normalizeSocial("website", "  ")).toBeNull();
  });
});

describe("deposit amount", () => {
  it("adds the 0.015 SOL launch cost to the dev buy", () => {
    // fallback (spec fee) until the quote loads, then the quoted amount
    expect(requiredDepositSol(0)).toBe(0.015);
    expect(requiredDepositSol(0.5)).toBe(0.515);
    expect(requiredDepositSol(0.1 + 0.2)).toBe(0.315);
    const quote = { launchFeeSol: 0.025329, devBuySol: 0.5, devBuyExtraSol: 0.031, requiredSol: 0.556329, requiredLamports: "556329000", specFeeSol: 0.015, exceedsSpecFee: true };
    expect(requiredDepositSol(0.5, quote)).toBe(0.556329);
  });
  it("parses dev buy input", () => {
    expect(parseDevBuy("")).toBe(0);
    expect(parseDevBuy("1.5")).toBe(1.5);
    expect(parseDevBuy("-1")).toBeNull();
    expect(parseDevBuy("abc")).toBeNull();
  });
});

describe("validateLaunch", () => {
  it("accepts a minimal form", () => {
    expect(validateLaunch(base)).toEqual({});
  });
  it("flags missing and invalid fields", () => {
    const errors = validateLaunch({ ...base, name: " ", ticker: "", website: "nope", devBuy: "500" });
    expect(Object.keys(errors).sort()).toEqual(["devBuy", "name", "ticker", "website"]);
  });
});

describe("toLaunchRequest", () => {
  it("normalises socials and omits empty optionals", () => {
    expect(toLaunchRequest(base)).toEqual({
      name: "Kelp Lord",
      ticker: "KELP",
      description: undefined,
      imageUrl: undefined,
      socials: undefined,
      triggerBps: 2500,
      devBuySol: undefined,
    });
    const req = toLaunchRequest({ ...base, x: "@kelp", devBuy: "0.5", description: " hi ", imageUrl: "https://img" });
    expect(req.socials).toEqual({ x: "https://x.com/kelp" });
    expect(req.devBuySol).toBe(0.5);
    expect(req.description).toBe("hi");
    expect(req.imageUrl).toBe("https://img");
  });
});
