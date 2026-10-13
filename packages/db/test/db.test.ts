import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HOLDFAST_EVENTS_CHANNEL,
  connectDb,
  dedupeNotifications,
  filterUnprocessed,
  getCursor,
  isProcessed,
  loadMigrations,
  markProcessed,
  migrate,
  notify,
  parseNotification,
  setCursor,
  type Db,
  type HoldfastNotification,
} from "../src/index.js";
import { freshDb, sig } from "./helpers.js";

describe("migrations", () => {
  it("applies every migration once, in order", async () => {
    const db = await connectDb("pglite://memory");
    try {
      const names = (await loadMigrations()).map((m) => m.name);
      expect(names[0]).toBe("001_init.sql");
      expect(names).toContain("002_indexer.sql");
      expect(await migrate(db)).toEqual(names);
      expect(await migrate(db)).toEqual([]);
      const applied = await db.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
      expect(applied.rows.map((r) => r.name)).toEqual(names);
      const cols = await db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'coins' AND column_name = 'last_price'",
      );
      expect(cols.rows).toHaveLength(1);
      const tables = await db.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      );
      expect(tables.rows.map((r) => r.table_name)).toEqual(
        expect.arrayContaining(["coins", "trades", "lots", "wallet_balances", "token_accounts", "price_candles", "payout_carry", "launches"]),
      );
    } finally {
      await db.close();
    }
  });
});

describe("Db (PGlite)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it("returns numeric/int8 as strings and rolls back failed transactions", async () => {
    const r = await db.query<{ n: string; b: string }>("SELECT 18446744073709551615::numeric(20,0) AS n, 9007199254740993::bigint AS b");
    expect(r.rows[0]).toEqual({ n: "18446744073709551615", b: "9007199254740993" });
    await expect(
      db.tx(async (q) => {
        await q.query("INSERT INTO processed_txs (sig, slot) VALUES ('x', 1)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await isProcessed(db, "x")).toBe(false);
  });

  it("processed_txs and cursors", async () => {
    const a = sig("a");
    const b = sig("b");
    expect(await markProcessed(db, a, 10)).toBe(true);
    expect(await markProcessed(db, a, 10)).toBe(false);
    expect(await isProcessed(db, a)).toBe(true);
    expect(await filterUnprocessed(db, [b, a])).toEqual([b]);
    expect(await getCursor(db, "sigs:x")).toBeNull();
    await setCursor(db, "sigs:x", a, 10);
    await setCursor(db, "sigs:x", b, 12);
    expect(await getCursor(db, "sigs:x")).toEqual({ name: "sigs:x", lastSig: b, lastSlot: 12 });
  });

  it("delivers notifications on commit", async () => {
    const got: HoldfastNotification[] = [];
    const unlisten = await db.listen(HOLDFAST_EVENTS_CHANNEL, (payload) => {
      const n = parseNotification(payload);
      if (n) got.push(n);
    });
    await db.tx(async (q) => {
      await notify(q, [
        { kind: "trade", mint: "M", sig: "S" },
        { kind: "trade", mint: "M", sig: "S" },
        { kind: "vault", mint: "M" },
      ]);
    });
    await notify(db, { kind: "launch", launchId: "L" });
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual([
      { kind: "trade", mint: "M", sig: "S" },
      { kind: "vault", mint: "M" },
      { kind: "launch", launchId: "L" },
    ]);
    await unlisten();
  });
});

describe("notifications", () => {
  it("parses only well-formed payloads", () => {
    expect(parseNotification('{"kind":"round","mint":"M","roundId":3}')).toEqual({ kind: "round", mint: "M", roundId: 3 });
    expect(parseNotification('{"kind":"round","mint":"M"}')).toBeNull();
    expect(parseNotification("not json")).toBeNull();
    expect(parseNotification('{"kind":"coin","mint":"M"}')).toEqual({ kind: "coin", mint: "M" });
    expect(dedupeNotifications([{ kind: "coin", mint: "a" }, { kind: "coin", mint: "a" }])).toHaveLength(1);
  });
});
