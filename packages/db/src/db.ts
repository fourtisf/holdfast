/**
 * Minimal database abstraction shared by every Holdfast service. Two implementations:
 * `createPgDb` (node-postgres pool, production) and `createPgliteDb` (Postgres compiled to WASM,
 * tests and local dev). Both return int8 / numeric columns as strings and timestamptz as Date;
 * repositories convert to bigint / unix ms.
 */

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  /** Run one or more statements without parameters (migrations). */
  exec(sql: string): Promise<void>;
}

export type Unlisten = () => Promise<void>;

export interface ListenOptions {
  /**
   * Called after a dropped LISTEN connection is back. Notifications sent while it was down are lost,
   * so listeners use this to tell their own consumers to catch up.
   */
  onReconnect?: () => void;
}

export interface Db extends Queryable {
  readonly kind: "pg" | "pglite";
  /**
   * Run `fn` in a transaction. Inside `fn`, use only the queryable it receives: on PGlite, calling
   * `db.query` while a transaction is open waits for that same transaction and deadlocks.
   */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** LISTEN on a channel; `onPayload` gets each NOTIFY payload. */
  listen(channel: string, onPayload: (payload: string) => void, options?: ListenOptions): Promise<Unlisten>;
  close(): Promise<void>;
}

export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`invalid identifier: ${name}`);
  return `"${name}"`;
}
