import type { Db } from "./db.js";
import { createPgDb } from "./pg.js";
import { createPgliteDb } from "./pglite.js";

/**
 * Open the database named by a URL: `postgres://…` (node-postgres pool), `pglite://<dir>` (persistent
 * PGlite) or `pglite://memory` (in-memory PGlite).
 */
export async function connectDb(url: string, opts: { max?: number; onError?: (err: Error) => void } = {}): Promise<Db> {
  if (url.startsWith("pglite:")) {
    const dir = url.replace(/^pglite:(\/\/)?/, "");
    return createPgliteDb({ dataDir: dir === "" || dir === "memory" ? undefined : dir });
  }
  return createPgDb({ connectionString: url, max: opts.max, onError: opts.onError });
}
