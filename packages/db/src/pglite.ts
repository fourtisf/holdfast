import { PGlite, types, type Transaction } from "@electric-sql/pglite";
import type { Db, Queryable, QueryResult, Unlisten } from "./db.js";

export interface PgliteDbOptions {
  /** Directory for a persistent database; in-memory when omitted. */
  dataDir?: string;
}

/** Same column conventions as node-postgres: int8 and numeric as strings. */
const parsers = {
  [types.INT8]: (v: string) => v,
  [types.NUMERIC]: (v: string) => v,
};

function wrap(target: PGlite | Transaction): Queryable {
  return {
    async query<T>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
      const res = await target.query<T>(sql, params ? [...params] : undefined);
      return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
    },
    async exec(sql: string): Promise<void> {
      await target.exec(sql);
    },
  };
}

export async function createPgliteDb(options: PgliteDbOptions = {}): Promise<Db> {
  const pglite = await PGlite.create({ dataDir: options.dataDir, parsers });
  const base = wrap(pglite);
  return {
    kind: "pglite",
    query: base.query,
    exec: base.exec,
    tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      return pglite.transaction((t) => fn(wrap(t)));
    },
    // One in-process database: the connection cannot drop, so ListenOptions.onReconnect never fires.
    async listen(channel: string, onPayload: (payload: string) => void): Promise<Unlisten> {
      const unsubscribe = await pglite.listen(channel, onPayload);
      return async () => {
        await unsubscribe();
      };
    },
    async close(): Promise<void> {
      await pglite.close();
    },
  };
}
