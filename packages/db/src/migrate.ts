import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

/** `packages/db/migrations`, resolved from both `src/` (tsx) and `dist/` (built). */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(join(dir, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

/**
 * Apply pending migrations in filename order, each in its own transaction guarded by an advisory
 * lock so concurrent services can call this at startup. Returns the names applied now.
 */
export async function migrate(db: Db, options: { dir?: string; log?: (msg: string) => void } = {}): Promise<string[]> {
  const log = options.log ?? (() => {});
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )`);
  const migrations = await loadMigrations(options.dir);
  const applied: string[] = [];
  for (const m of migrations) {
    const done = await db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(7243120001)");
      const existing = await q.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE name = $1", [m.name]);
      const row = existing.rows[0];
      if (row) {
        if (row.checksum !== m.checksum) log(`warning: migration ${m.name} changed after it was applied`);
        return false;
      }
      await q.exec(m.sql);
      await q.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [m.name, m.checksum]);
      return true;
    });
    if (done) {
      applied.push(m.name);
      log(`applied ${m.name}`);
    }
  }
  return applied;
}
