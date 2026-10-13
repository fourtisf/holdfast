import { createHash } from "node:crypto";
import { base58 } from "@scure/base";
import { createPgliteDb, migrate, insertCoin, type Db, type NewCoin } from "../src/index.js";

export async function freshDb(): Promise<Db> {
  const db = await createPgliteDb();
  await migrate(db);
  return db;
}

/** Empty every table (keeps the schema), much faster than booting a new PGlite. */
export async function resetDb(db: Db): Promise<void> {
  const res = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'",
  );
  await db.exec(`TRUNCATE ${res.rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

export function addr(label: string): string {
  return base58.encode(createHash("sha256").update(label).digest());
}

export function sig(label: string): string {
  return base58.encode(Buffer.concat([createHash("sha256").update(`a${label}`).digest(), createHash("sha256").update(`b${label}`).digest()]));
}

export function coinFixture(label: string, overrides: Partial<NewCoin> = {}): NewCoin {
  return {
    mint: addr(`mint:${label}`),
    name: `${label} coin`,
    ticker: label.toUpperCase().slice(0, 10),
    triggerBps: 2500,
    vault: addr(`vault:${label}`),
    treasury: addr(`treasury:${label}`),
    bondingCurve: addr(`curve:${label}`),
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    ...overrides,
  };
}

export async function seedCoin(db: Db, label: string, overrides: Partial<NewCoin> = {}): Promise<NewCoin> {
  const coin = coinFixture(label, overrides);
  await insertCoin(db, coin);
  return coin;
}
