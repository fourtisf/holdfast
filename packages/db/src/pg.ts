import pg from "pg";
import { quoteIdent, type Db, type Queryable, type QueryResult, type Unlisten } from "./db.js";

export interface PgDbOptions {
  connectionString: string;
  max?: number;
  /** Called for background errors (idle clients, LISTEN reconnects). */
  onError?: (err: Error) => void;
}

// int8 and numeric stay strings (the default); make it explicit so nobody flips it globally.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);

function wrap(client: pg.Pool | pg.PoolClient): Queryable {
  return {
    async query<T>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
      const res = await client.query(sql, params as unknown[] | undefined);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
    },
    async exec(sql: string): Promise<void> {
      await client.query(sql);
    },
  };
}

export function createPgDb(options: PgDbOptions): Db {
  const pool = new pg.Pool({ connectionString: options.connectionString, max: options.max ?? 10 });
  const onError = options.onError ?? (() => {});
  pool.on("error", onError);
  const base = wrap(pool);
  const listeners = new Set<pg.Client>();

  return {
    kind: "pg",
    query: base.query,
    exec: base.exec,
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(wrap(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async listen(channel: string, onPayload: (payload: string) => void): Promise<Unlisten> {
      let closed = false;
      let client: pg.Client | null = null;
      let retry: NodeJS.Timeout | null = null;

      const connect = async (attempt: number): Promise<void> => {
        const c = new pg.Client({ connectionString: options.connectionString });
        c.on("notification", (msg) => {
          if (msg.channel === channel) onPayload(msg.payload ?? "");
        });
        c.on("error", (err) => {
          onError(err);
          listeners.delete(c);
          c.end().catch(() => {});
          if (!closed) schedule(attempt + 1);
        });
        await c.connect();
        await c.query(`LISTEN ${quoteIdent(channel)}`);
        client = c;
        listeners.add(c);
      };
      const schedule = (attempt: number) => {
        const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
        retry = setTimeout(() => {
          connect(attempt).catch((err: Error) => {
            onError(err);
            if (!closed) schedule(attempt + 1);
          });
        }, delay);
      };

      await connect(0);
      return async () => {
        closed = true;
        if (retry) clearTimeout(retry);
        if (client) {
          listeners.delete(client);
          await client.end().catch(() => {});
        }
      };
    },
    async close(): Promise<void> {
      await Promise.all([...listeners].map((c) => c.end().catch(() => {})));
      listeners.clear();
      await pool.end();
    },
  };
}
