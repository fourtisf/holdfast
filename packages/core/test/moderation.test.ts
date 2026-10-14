import { describe, expect, it } from "vitest";

import { moderateLaunchText, normalizeForModeration, parseBlocklist, withExtraBlocked, DEFAULT_MODERATION_LISTS } from "../src/moderation.js";

describe("moderation", () => {
  it("normalizes leetspeak, accents, separators and repeated letters", () => {
    expect(normalizeForModeration("P3D0")).toBe("pedo");
    expect(normalizeForModeration("p.e.d.o")).toBe("pedo");
    expect(normalizeForModeration("Ｐｅｄｏ")).toBe("pedo"); // full-width
    expect(normalizeForModeration("pédoooo")).toBe("pedo");
    expect(normalizeForModeration("FREE $OL")).toBe("fresol");
  });

  it("blocks terms in any field, as words or (long ones) anywhere", () => {
    expect(moderateLaunchText({ name: "Doge", ticker: "DOGE" })).toEqual({ action: "allow" });
    expect(moderateLaunchText({ name: "P3d0 coin", ticker: "X" }).action).toBe("block");
    expect(moderateLaunchText({ name: "ok", ticker: "OK", description: "Claim airdrop now!!" }).action).toBe("block");
    expect(moderateLaunchText({ name: "ok", ticker: "OK", socials: { website: "https://seed-phrase.example" } }).action).toBe("block");
    // no false positives on words that merely contain a short term
    expect(moderateLaunchText({ name: "Torpedo", ticker: "TORP", description: "speedometer to the moon" })).toEqual({ action: "allow" });
  });

  it("flags reserved tickers and names for review instead of blocking", () => {
    const v = moderateLaunchText({ name: "USD Coin", ticker: "$USDC" });
    expect(v.action).toBe("review");
    expect(moderateLaunchText({ name: "Holdfast", ticker: "HF" }).action).toBe("review");
    expect(moderateLaunchText({ name: "Solana Dog", ticker: "SOLDOG" })).toEqual({ action: "allow" });
  });

  it("reads operator blocklists (comments, blank lines) and merges them", () => {
    const extra = parseBlocklist("# hate terms\nbadword\n\n  Other Term  # inline\n");
    expect(extra).toEqual(["badword", "otherterm"]);
    const lists = withExtraBlocked(DEFAULT_MODERATION_LISTS, extra);
    expect(moderateLaunchText({ name: "b4dw0rd", ticker: "X" }, lists).action).toBe("block");
    expect(moderateLaunchText({ name: "fine", ticker: "X", description: "some other term here" }, lists).action).toBe("block");
  });
});
