import { describe, expect, it } from "vitest";

import { loadConfig, resolveDatabaseUrl } from "../src/config.js";

const BASE = { TELEGRAM_BOT_TOKEN: "123456:abc-DEF_ghi", DATABASE_URL: "postgres://h/db" };

describe("loadConfig", () => {
  it("applies the defaults", () => {
    expect(loadConfig(BASE)).toEqual({
      botToken: "123456:abc-DEF_ghi",
      telegramApiUrl: "https://api.telegram.org",
      databaseUrl: "postgres://h/db",
      webUrl: "http://localhost:3000",
      cluster: "mainnet-beta",
      opsPort: 9104,
      milestoneIntervalMs: 600_000,
      pollTimeoutSec: 30,
      catchUpMs: 900_000,
      migrate: true,
      logLevel: "info",
    });
  });

  it("reads overrides", () => {
    const cfg = loadConfig({
      ...BASE,
      WEB_URL: "https://holdfast.example/",
      SOLANA_CLUSTER: "devnet",
      NOTIFIER_OPS_PORT: "0",
      NOTIFIER_MILESTONE_INTERVAL_MS: "60000",
      NOTIFIER_MIGRATE: "0",
      LOG_LEVEL: "debug",
    });
    expect(cfg).toMatchObject({ webUrl: "https://holdfast.example", cluster: "devnet", opsPort: 0, milestoneIntervalMs: 60_000, migrate: false, logLevel: "debug" });
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
  });

  it("resolves relative PGlite directories against INIT_CWD", () => {
    expect(resolveDatabaseUrl("pglite://data/pg", { INIT_CWD: "/srv/holdfast" })).toBe("pglite:///srv/holdfast/data/pg");
    expect(resolveDatabaseUrl("pglite://memory", { INIT_CWD: "/srv/holdfast" })).toBe("pglite://memory");
    expect(resolveDatabaseUrl("pglite:///abs/dir", { INIT_CWD: "/srv/holdfast" })).toBe("pglite:///abs/dir");
    expect(resolveDatabaseUrl("postgres://u@h/db", { INIT_CWD: "/srv/holdfast" })).toBe("postgres://u@h/db");
  });
});
