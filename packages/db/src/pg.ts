import pg from "pg";
import { quoteIdent, type Db, type ListenOptions, type Queryable, type QueryResult, type Unlisten } from "./db.js";

export interface PgDbOptions {
  connectionString: string;
  max?: number;
  /** Called for background errors (idle clients, LISTEN reconnects). */
  onError?: (err: Error) => void;
  /** How often a LISTEN connection proves it is still alive (a half-open socket never errors). */
  listenProbeMs?: number;
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
    async listen(channel: string, onPayload: (payload: string) => void, listenOptions: ListenOptions = {}): Promise<Unlisten> {
      const probeMs = options.listenProbeMs ?? 30_000;
      let closed = false;
      let started = false;
      let client: pg.Client | null = null;
      let retry: NodeJS.Timeout | null = null;
      let probe: NodeJS.Timeout | null = null;
      // Consecutive failures since the last good connection: every outage starts again at the short delay.
      let failures = 0;

      const connect = async (): Promise<void> => {
        // A connect that never completes must fail too, or nothing would schedule the next attempt.
        const c = new pg.Client({
          connectionString: options.connectionString,
          keepAlive: true,
          keepAliveInitialDelayMillis: 10_000,
          query_timeout: 10_000,
          connectionTimeoutMillis: 10_000,
        });
        let dead = false;
        // A drop can surface both as an 'error' event and as a rejected query: retry once per connection.
        const drop = (err: Error) => {
          if (dead) return;
          dead = true;
          onError(err);
          listeners.delete(c);
          if (client === c) client = null;
          if (probe) clearInterval(probe);
          probe = null;
          c.end().catch(() => {});
          if (started && !closed) schedule();
        };
        c.on("notification", (msg) => {
          if (msg.channel === channel) onPayload(msg.payload ?? "");
        });
        c.on("error", drop);
        try {
          await c.connect();
          await c.query(`LISTEN ${quoteIdent(channel)}`);
        } catch (err) {
          drop(err as Error);
          throw err;
        }
        if (dead) throw new Error("LISTEN connection dropped while starting");
        if (closed) {
          await c.end().catch(() => {});
          return;
        }
        const reconnected = started;
        started = true;
        failures = 0;
        client = c;
        listeners.add(c);
        let probing = false;
        probe = setInterval(() => {
          if (probing) return;
          probing = true;
          c.query("SELECT 1").then(
            () => (probing = false),
            (err: Error) => drop(err),
          );
        }, probeMs);
        probe.unref();
        if (reconnected) listenOptions.onReconnect?.();
      };
      const schedule = () => {
        if (retry) clearTimeout(retry);
        const delay = Math.min(30_000, 500 * 2 ** Math.min(failures, 6));
        failures++;
        retry = setTimeout(() => {
          retry = null;
          if (!closed) connect().catch(() => {});
        }, delay);
        retry.unref();
      };

      await connect();
      return async () => {
        closed = true;
        if (retry) clearTimeout(retry);
        if (probe) clearInterval(probe);
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
