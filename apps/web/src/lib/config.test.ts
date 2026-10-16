import { afterEach, describe, expect, it, vi } from "vitest";

const MINT = "AoQ8JbmpVdE7GEjsMLiNe8PiYwQwQME9CDJznHhwQ3ND";
const WALLET = "EWLsJmxainEgDtCU7Ejq2xpEzRnQNE97f5Y2KU9FJhiQ";

async function loadConfig(bot: string | undefined) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_TELEGRAM_BOT", bot);
  return import("./config");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("botUrl", () => {
  it("builds private-chat and add-to-group deep links", async () => {
    const { botUrl, TELEGRAM_BOT } = await loadConfig("@MoatpadTestBot");
    expect(TELEGRAM_BOT).toBe("MoatpadTestBot");
    expect(botUrl()).toBe("https://t.me/MoatpadTestBot");
    expect(botUrl("launch")).toBe("https://t.me/MoatpadTestBot?start=launch");
    expect(botUrl(`follow_${MINT}`)).toBe(`https://t.me/MoatpadTestBot?start=follow_${MINT}`);
    expect(botUrl(`watch_${WALLET}`)).toBe(`https://t.me/MoatpadTestBot?start=watch_${WALLET}`);
    expect(botUrl(`buybot_${MINT}`, true)).toBe(`https://t.me/MoatpadTestBot?startgroup=buybot_${MINT}`);
  });

  it("keeps every payload for a 44-character address within Telegram's limits", async () => {
    const { botUrl } = await loadConfig("MoatpadTestBot");
    for (const [payload, group] of [[`buybot_${MINT}`, true], [`follow_${MINT}`, false], [`watch_${WALLET}`, false]] as const) {
      const url = new URL(botUrl(payload, group)!);
      const value = url.searchParams.get(group ? "startgroup" : "start")!;
      expect(value).toBe(payload);
      expect(value.length).toBeLessThanOrEqual(64);
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("gives no link for a payload Telegram would drop", async () => {
    const { botUrl } = await loadConfig("MoatpadTestBot");
    expect(botUrl("watch_not a wallet!")).toBeNull();
    expect(botUrl(`watch_${"x".repeat(60)}`)).toBeNull();
    expect(botUrl("")).toBeNull();
  });

  it("hides every bot link when no bot is configured", async () => {
    for (const bot of [undefined, "", "  ", "@"]) {
      const { botUrl, TELEGRAM_BOT } = await loadConfig(bot);
      expect(TELEGRAM_BOT).toBe("");
      expect(botUrl()).toBeNull();
      expect(botUrl("launch")).toBeNull();
      expect(botUrl(`buybot_${MINT}`, true)).toBeNull();
    }
  });
});
