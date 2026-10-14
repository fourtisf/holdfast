import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  blockImage,
  countOpenReports,
  getCoin,
  getGlobalStats,
  insertReport,
  isImageBlocked,
  listCoinMetrics,
  listModeratedCoins,
  listModerationLog,
  listReports,
  logModeration,
  resolveReports,
  setCoinHidden,
  setCoinNeedsReview,
  type Db,
} from "../src/index.js";
import { freshDb, resetDb, seedCoin } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await db.close();
});

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

describe("moderation", () => {
  it("counts one report per reporter and resolves them together", async () => {
    const c = await seedCoin(db, "aa", { createdAt: NOW });
    const base = { targetType: "coin" as const, targetId: c.mint, mint: c.mint, reason: "scam" as const };
    expect(await insertReport(db, { ...base, reporterHash: "r1" })).toBe(true);
    expect(await insertReport(db, { ...base, reporterHash: "r1", reason: "nsfw" })).toBe(false); // same reporter
    expect(await insertReport(db, { ...base, reporterHash: "r2", details: "fake team" })).toBe(true);
    expect(await countOpenReports(db, "coin", c.mint)).toBe(2);
    expect((await listReports(db, { limit: 10 })).map((r) => r.details).sort()).toEqual(["", "fake team"]);
    expect(await resolveReports(db, { targetType: "coin", targetId: c.mint }, "hidden")).toBe(2);
    expect(await countOpenReports(db, "coin", c.mint)).toBe(0);
    expect(await listReports(db, { limit: 10 })).toHaveLength(0);
    expect(await listReports(db, { open: false, limit: 10 })).toHaveLength(2);
  });

  it("hidden coins leave listings and stats but stay readable", async () => {
    const a = await seedCoin(db, "aa", { createdAt: NOW - 1000 });
    const b = await seedCoin(db, "bb", { createdAt: NOW });
    await setCoinHidden(db, b.mint, true, "illegal image");
    expect((await listCoinMetrics(db, { sort: "newest", limit: 10, now: NOW })).map((m) => m.coin.mint)).toEqual([a.mint]);
    expect((await listCoinMetrics(db, { sort: "newest", limit: 10, now: NOW, includeHidden: true })).map((m) => m.coin.mint)).toEqual([b.mint, a.mint]);
    expect((await getGlobalStats(db, NOW)).coins).toBe(1);
    expect(await getCoin(db, b.mint)).toMatchObject({ hidden: true, hiddenReason: "illegal image" });

    await setCoinNeedsReview(db, a.mint, true);
    expect((await listModeratedCoins(db, 10)).map((m) => [m.mint, m.hidden, m.needsReview])).toEqual(
      expect.arrayContaining([
        [a.mint, false, true],
        [b.mint, true, false],
      ]),
    );
    await setCoinHidden(db, b.mint, false, null);
    expect(await getCoin(db, b.mint)).toMatchObject({ hidden: false, hiddenReason: null });
  });

  it("blocks image hashes and keeps an audit log", async () => {
    expect(await isImageBlocked(db, "ff".repeat(32))).toBe(false);
    await blockImage(db, "ff".repeat(32), "nsfw");
    await blockImage(db, "ff".repeat(32), "again");
    expect(await isImageBlocked(db, "ff".repeat(32))).toBe(true);
    await logModeration(db, { action: "hide", target: "mint", actor: "admin", reason: "x" });
    expect(await listModerationLog(db, 5)).toMatchObject([{ action: "hide", target: "mint", actor: "admin", reason: "x" }]);
  });
});
