import { describe, expect, it } from "vitest";

import { botUsernameMismatch, loadConfig, resolveDatabaseUrl } from "../src/config.js";

const BASE = { TELEGRAM_BOT_TOKEN: "123456:abc-DEF_ghi", DATABASE_URL: "postgres://h/db" };

describe("loadConfig", () => {
  it("applies the defaults", () => {
    expect(loadConfig(BASE)).toEqual({
      botToken: "123456:abc-DEF_ghi",
      telegramApiUrl: "https://api.telegram.org",
      databaseUrl: "postgres://h/db",
      webUrl: "http://localhost:3000",
      apiUrl: "http://localhost:4000",
      internalApiToken: null,
      burnChatId: null,
      moatCa: "4qLdhoVDiAkXVXqU4D3rSPp6pMMnJzRJr38do55Hpump",
      cluster: "mainnet-beta",
      opsPort: 9104,
      milestoneIntervalMs: 600_000,
      pollTimeoutSec: 30,
      privateReplies: { perMinute: 20, burst: 3 },
      catchUpMs: 900_000,
      migrate: true,
      logLevel: "info",
    });
  });

  it("reads the launch bot settings", () => {
    const cfg = loadConfig({ ...BASE, API_INTERNAL_URL: "http://api:4000/", NOTIFIER_BURN_CHAT_ID: "-1001234567890", MOAT_CA: "Moat111" });
    expect(cfg).toMatchObject({ apiUrl: "http://api:4000", burnChatId: -1001234567890, moatCa: "Moat111" });
    expect(() => loadConfig({ ...BASE, NOTIFIER_BURN_CHAT_ID: "@channel" })).toThrow(/NOTIFIER_BURN_CHAT_ID/);
  });

  it("reads INTERNAL_API_TOKEN and refuses a short one", () => {
    const token = "a".repeat(64);
    expect(loadConfig({ ...BASE, INTERNAL_API_TOKEN: ` ${token}\n` }).internalApiToken).toBe(token);
    expect(loadConfig({ ...BASE, INTERNAL_API_TOKEN: "" }).internalApiToken).toBeNull();
    expect(() => loadConfig({ ...BASE, INTERNAL_API_TOKEN: "short" })).toThrow("INTERNAL_API_TOKEN must be at least 24 characters");
  });

  it("reads overrides", () => {
    const cfg = loadConfig({
      ...BASE,
      WEB_URL: "https://holdfast.example/",
      SOLANA_CLUSTER: "devnet",
      NOTIFIER_OPS_PORT: "0",
      NOTIFIER_MILESTONE_INTERVAL_MS: "60000",
      NOTIFIER_PRIVATE_REPLIES_PER_MINUTE: "30",
      NOTIFIER_PRIVATE_REPLY_BURST: "5",
      NOTIFIER_MIGRATE: "0",
      LOG_LEVEL: "debug",
    });
    expect(cfg).toMatchObject({ webUrl: "https://holdfast.example", cluster: "devnet", opsPort: 0, milestoneIntervalMs: 60_000, privateReplies: { perMinute: 30, burst: 5 }, migrate: false, logLevel: "debug" });
    expect(loadConfig({ ...BASE, PUBLIC_SITE_URL: "https://site.example" }).webUrl).toBe("https://site.example");
    expect(loadConfig({ ...BASE, SOLANA_CLUSTER: "mainnet" }).cluster).toBe("mainnet-beta");
  });

  it("rejects missing or malformed settings", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://h/db" })).toThrow("TELEGRAM_BOT_TOKEN is required");
    expect(() => loadConfig({ ...BASE, TELEGRAM_BOT_TOKEN: "nope" })).toThrow("does not look like a bot token");
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: BASE.TELEGRAM_BOT_TOKEN })).toThrow("DATABASE_URL is required");
    expect(() => loadConfig({ ...BASE, SOLANA_CLUSTER: "moon" })).toThrow("SOLANA_CLUSTER must be one of");
    expect(() => loadConfig({ ...BASE, WEB_URL: "holdfast.example" })).toThrow("WEB_URL must be an absolute http(s) URL");
    expect(() => loadConfig({ ...BASE, NOTIFIER_OPS_PORT: "70000" })).toThrow("NOTIFIER_OPS_PORT");
    expect(() => loadConfig({ ...BASE, NOTIFIER_MILESTONE_INTERVAL_MS: "10" })).toThrow("NOTIFIER_MILESTONE_INTERVAL_MS");
    expect(() => loadConfig({ ...BASE, NOTIFIER_PRIVATE_REPLY_BURST: "0" })).toThrow("NOTIFIER_PRIVATE_REPLY_BURST must be an integer ≥ 1");
  });

  it("refuses a TELEGRAM_API_URL that is not an absolute http(s) URL (fetch would log the URL with the token)", () => {
    expect(loadConfig({ ...BASE, TELEGRAM_API_URL: "http://127.0.0.1:8081/" }).telegramApiUrl).toBe("http://127.0.0.1:8081");
    for (const bad of ["127.0.0.1:8081", "api.telegram.org", "ftp://bot.local", "localhost:8081"]) {
      const err = (() => {
        try {
          loadConfig({ ...BASE, TELEGRAM_API_URL: bad });
        } catch (e) {
          return e as Error;
        }
        return null;
      })();
      expect(err?.message, bad).toBe("TELEGRAM_API_URL must be an absolute http(s) URL, like http://127.0.0.1:8081");
      expect(err?.message).not.toContain(BASE.TELEGRAM_BOT_TOKEN);
    }
  });

  it("notices when the website's NEXT_PUBLIC_TELEGRAM_BOT is another bot", () => {
    expect(botUsernameMismatch({ NEXT_PUBLIC_TELEGRAM_BOT: "@MoatpadBot" }, "moatpadbot")).toBeNull();
    expect(botUsernameMismatch({ NEXT_PUBLIC_TELEGRAM_BOT: "MoatpadTestBot" }, "MoatpadBot")).toBe("MoatpadTestBot");
    expect(botUsernameMismatch({}, "MoatpadBot")).toBeNull();
    expect(botUsernameMismatch({ NEXT_PUBLIC_TELEGRAM_BOT: "MoatpadBot" }, undefined)).toBeNull();
  });

  it("resolves relative PGlite directories against INIT_CWD", () => {
    expect(resolveDatabaseUrl("pglite://data/pg", { INIT_CWD: "/srv/holdfast" })).toBe("pglite:///srv/holdfast/data/pg");
    expect(resolveDatabaseUrl("pglite://memory", { INIT_CWD: "/srv/holdfast" })).toBe("pglite://memory");
    expect(resolveDatabaseUrl("pglite:///abs/dir", { INIT_CWD: "/srv/holdfast" })).toBe("pglite:///abs/dir");
    expect(resolveDatabaseUrl("postgres://u@h/db", { INIT_CWD: "/srv/holdfast" })).toBe("postgres://u@h/db");
  });
});
