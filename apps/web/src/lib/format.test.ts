import { describe, expect, it } from "vitest";
import {
  formatAgo,
  formatBpsAsPct,
  formatCompact,
  formatCountdown,
  formatDuration,
  formatMarketCap,
  formatMultiplier,
  formatPct,
  formatPrice,
  formatRelativeTime,
  formatShare,
  formatSol,
  formatTokens,
  shortAddress,
  formatSolExact,
  formatSignedSol,
  formatUsd,
} from "./format";
import { toggleInList } from "./watchlist";
import { walletBrowseLinks } from "../components/layout/WalletButton";

describe("formatCompact", () => {
  it("abbreviates thousands, millions, billions", () => {
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(1234)).toBe("1.23K");
    expect(formatCompact(2_500_000)).toBe("2.5M");
    expect(formatCompact(123_456_789)).toBe("123.5M");
    expect(formatCompact(1_000_000_000)).toBe("1B");
    expect(formatCompact(-4200)).toBe("-4.2K");
  });
  it("keeps small decimals and handles non-finite", () => {
    expect(formatCompact(12.345)).toBe("12.35");
    expect(formatCompact(Number.NaN)).toBe("–");
  });
});

describe("formatSol", () => {
  it("adapts precision to magnitude", () => {
    expect(formatSol(0)).toBe("0 SOL");
    expect(formatSol(0.015)).toBe("0.015 SOL");
    expect(formatSol(0.01534)).toBe("0.015 SOL");
    expect(formatSol(0.00123)).toBe("0.0012 SOL");
    expect(formatSol(1.5)).toBe("1.5 SOL");
    expect(formatSol(12.345)).toBe("12.35 SOL");
    expect(formatSol(512.34)).toBe("512.3 SOL");
    expect(formatSol(25_400)).toBe("25.4K SOL");
  });
  it("keeps dust readable", () => {
    expect(formatSol(0.0000123)).toBe("0.000012 SOL");
    expect(formatSol(0.0000000123)).toBe("<0.000001 SOL");
  });
});

describe("formatPrice", () => {
  it("uses subscript-zero notation for tiny prices", () => {
    expect(formatPrice(0.0000000281)).toBe("0.0₇281");
    expect(formatPrice(0.00000002815)).toBe("0.0₇2815");
    expect(formatPrice(0.0001234)).toBe("0.0₃1234");
  });
  it("rounds up across a power of ten", () => {
    expect(formatPrice(0.000000099999)).toBe("0.0₆1");
  });
  it("prints regular prices with 4 significant digits", () => {
    expect(formatPrice(0.001234)).toBe("0.001234");
    expect(formatPrice(0.5)).toBe("0.5");
    expect(formatPrice(12.3456)).toBe("12.3456");
    expect(formatPrice(0)).toBe("0");
  });
});

describe("percentages and multipliers", () => {
  it("formats percent units", () => {
    expect(formatPct(12.345)).toBe("12.3%");
    expect(formatPct(3.456, { signed: true })).toBe("+3.46%");
    expect(formatPct(-0.5, { signed: true })).toBe("-0.5%");
    expect(formatPct(250)).toBe("250%");
  });
  it("formats fractional shares", () => {
    expect(formatShare(0.1234)).toBe("12.3%");
    expect(formatShare(0.00005)).toBe("<0.01%");
    expect(formatShare(0)).toBe("0%");
  });
  it("formats weight and bps", () => {
    expect(formatMultiplier(0.1)).toBe("0.10×");
    expect(formatMultiplier(1)).toBe("1.00×");
    expect(formatBpsAsPct(2500)).toBe("25%");
    expect(formatBpsAsPct(1550)).toBe("15.5%");
  });
  it("formats market caps and tokens", () => {
    expect(formatMarketCap(28)).toBe("28 SOL");
    expect(formatMarketCap(4.567)).toBe("4.57 SOL");
    expect(formatMarketCap(1520)).toBe("1.52K SOL");
    expect(formatTokens(12_345_678)).toBe("12.35M");
    expect(formatTokens(950)).toBe("950");
  });
});

describe("addresses and time", () => {
  it("shortens addresses", () => {
    expect(shortAddress("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toBe("7xKX…gAsU");
    expect(shortAddress("short")).toBe("short");
  });
  it("formats relative time", () => {
    const now = 1_700_000_000_000;
    expect(formatAgo(now - 2000, now)).toBe("now");
    expect(formatAgo(now - 42_000, now)).toBe("42s");
    expect(formatAgo(now - 5 * 60_000, now)).toBe("5m");
    expect(formatAgo(now - 3 * 3600_000, now)).toBe("3h");
    expect(formatAgo(now - 2 * 86_400_000, now)).toBe("2d");
    expect(formatAgo(now + 10_000, now)).toBe("now");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now, now)).toBe("just now");
  });
  it("formats durations", () => {
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(45 * 60_000)).toBe("45m");
    expect(formatDuration(3 * 3600_000 + 12 * 60_000)).toBe("3h 12m");
    expect(formatDuration(6 * 86_400_000 + 4 * 3600_000)).toBe("6d 4h");
    expect(formatDuration(-5)).toBe("0s");
  });
  it("formats countdowns", () => {
    expect(formatCountdown(120_000)).toBe("02:00");
    expect(formatCountdown(61_001)).toBe("01:02");
    expect(formatCountdown(999)).toBe("00:01");
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(-500)).toBe("00:00");
    expect(formatCountdown(3_725_000)).toBe("1:02:05");
  });
});

describe("formatSolExact", () => {
  it("never rounds a deposit amount", () => {
    expect(formatSolExact(0.025329)).toBe("0.025329");
    expect(formatSolExact(0.556341)).toBe("0.556341");
    expect(formatSolExact(1)).toBe("1");
  });
});

describe("USD, signed SOL, watchlist, wallet links", () => {
  it("formats dollars", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(1.5)).toBe("$1.5");
    expect(formatUsd(76.104)).toBe("$76.1");
    expect(formatUsd(12_345)).toBe("$12.35K");
    expect(formatUsd(-3.2)).toBe("-$3.2");
  });

  it("signs PnL", () => {
    expect(formatSignedSol(0.42)).toBe("+0.42 SOL");
    expect(formatSignedSol(-1.2)).toBe("-1.2 SOL");
    expect(formatSignedSol(0)).toBe("0 SOL");
  });

  it("toggles watchlist entries, newest first", () => {
    expect(toggleInList([], "a")).toEqual(["a"]);
    expect(toggleInList(["a"], "b")).toEqual(["b", "a"]);
    expect(toggleInList(["b", "a"], "b")).toEqual(["a"]);
  });

  it("builds wallet-app browse links", () => {
    const [phantom, solflare] = walletBrowseLinks("https://holdfast.app/coin/X?y=1", "https://holdfast.app");
    expect(phantom!.href).toBe("https://phantom.app/ul/browse/https%3A%2F%2Fholdfast.app%2Fcoin%2FX%3Fy%3D1?ref=https%3A%2F%2Fholdfast.app");
    expect(solflare!.href).toContain("https://solflare.com/ul/v1/browse/https%3A%2F%2Fholdfast.app");
  });
});
