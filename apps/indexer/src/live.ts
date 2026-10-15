import { PublicKey, type Connection } from "@solana/web3.js";
import { filterUnprocessed, listCoins, type Db } from "@holdfast/db";
import type { ChainSource } from "./poller.js";
import type { Logger, ProcessResult } from "./process.js";
import type { ParsedTx } from "./tx.js";

/** Confirmed transactions that mention an address, pushed by the RPC node (`logsSubscribe`). */
export interface LogSource {
  subscribe(address: string, onLog: (signature: string, err: unknown | null) => void): Promise<number> | number;
  unsubscribe(id: number): Promise<void>;
}

/** web3.js keeps one socket for all subscriptions, pings it and resubscribes after a reconnect. */
export function rpcLogSource(connection: Connection): LogSource {
  return {
    subscribe: (address, onLog) => connection.onLogs(new PublicKey(address), (logs) => onLog(logs.signature, logs.err), "confirmed"),
    unsubscribe: (id) => connection.removeOnLogsListener(id),
  };
}

export interface LiveIngestOptions {
  db: Db;
  logs: LogSource;
  chain: ChainSource;
  process: (tx: ParsedTx) => Promise<ProcessResult>;
  log: Logger;
  holdfastProgramId: string;
  /** Waits between getTransaction attempts: a signature is pushed before every node can serve its body. */
  retryDelaysMs?: number[];
  /** Upper bound on watched addresses (the program first, then the newest coins). */
  maxSubscriptions?: number;
  /** Signatures fetched at the same time; the rest wait in a queue. */
  maxConcurrent?: number;
  /** Queue bound: past it, pushes are dropped (left to the poller) instead of piling up RPC calls. */
  maxBacklog?: number;
  onResult?: (status: ProcessResult["status"] | "unavailable" | "error" | "dropped") => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Near-realtime ingestion next to the poller: a subscription per coin mint (every pump.fun and PumpSwap
 * trade lists the mint) and one for the Holdfast program. Each pushed signature is fetched and indexed at
 * once instead of waiting for the next poll. The poller stays the source of truth: it writes the cursors
 * and picks up anything this path misses or fails (indexing is idempotent and tolerates any order).
 */
export class LiveIngest {
  private readonly subs = new Map<string, number>();
  private readonly seen = new Set<string>();
  private readonly queue: string[] = [];
  private running = 0;
  private drained: (() => void)[] = [];
  private stopped = false;
  private syncing: Promise<void> | null = null;

  constructor(private readonly opts: LiveIngestOptions) {}

  /** Addresses currently watched. */
  get watching(): string[] {
    return [...this.subs.keys()];
  }

  /** Watch the program and every coin's mint; drop subscriptions for coins that are gone. */
  sync(): Promise<void> {
    this.syncing ??= this.doSync().finally(() => (this.syncing = null));
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    if (this.stopped) return;
    const { db, logs, log, holdfastProgramId } = this.opts;
    const coins = await listCoins(db);
    const max = this.opts.maxSubscriptions ?? 1000;
    const wanted = [holdfastProgramId, ...[...coins].reverse().map((c) => c.mint)].slice(0, max);
    const keep = new Set(wanted);
    for (const [address, id] of this.subs) {
      if (keep.has(address)) continue;
      this.subs.delete(address);
      void logs.unsubscribe(id).catch((err: unknown) => log.warn({ err, address }, "logs unsubscribe failed"));
    }
    for (const address of wanted) {
      if (this.stopped || this.subs.has(address)) continue;
      try {
        this.subs.set(address, await logs.subscribe(address, (sig, err) => this.push(sig, err)));
      } catch (err) {
        log.warn({ err, address }, "logs subscribe failed; the poller still covers it");
      }
    }
  }

  /** A signature pushed by the node. Failed transactions are left to the poller (it marks them processed). */
  push(signature: string, err: unknown | null): void {
    if (this.stopped || err || this.seen.has(signature)) return;
    this.seen.add(signature);
    if (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value!);
    if (this.queue.length >= (this.opts.maxBacklog ?? 500)) {
      this.opts.onResult?.("dropped");
      return;
    }
    this.queue.push(signature);
    this.drain();
  }

  private drain(): void {
    while (!this.stopped && this.running < (this.opts.maxConcurrent ?? 4) && this.queue.length) {
      const signature = this.queue.shift()!;
      this.running++;
      void this.handle(signature).finally(() => {
        this.running--;
        this.drain();
        if (this.running === 0 && (this.queue.length === 0 || this.stopped)) for (const done of this.drained.splice(0)) done();
      });
    }
  }

  private async handle(signature: string): Promise<void> {
    const { db, chain, log, onResult } = this.opts;
    try {
      if ((await filterUnprocessed(db, [signature])).length === 0) return;
      let tx: ParsedTx | null = null;
      for (const wait of this.opts.retryDelaysMs ?? [0, 250, 500, 1000, 2000]) {
        if (wait) await sleep(wait);
        if (this.stopped) return;
        tx = await chain.getTransaction(signature);
        if (tx) break;
      }
      if (!tx) {
        onResult?.("unavailable");
        return;
      }
      const result = await this.opts.process(tx);
      onResult?.(result.status);
      if (result.status === "processed") log.debug({ sig: signature, trades: result.trades }, "indexed live");
    } catch (err) {
      onResult?.("error");
      log.warn({ err, sig: signature }, "live indexing failed; the poller retries it");
    }
  }

  /** Resolves when every pushed signature so far has been handled (tests, shutdown). */
  idle(): Promise<void> {
    if (this.running === 0 && (this.queue.length === 0 || this.stopped)) return Promise.resolve();
    return new Promise((resolve) => this.drained.push(resolve));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    const ids = [...this.subs.values()];
    this.subs.clear();
    // Shutting down: do not hang on a socket that no longer answers.
    const bounded = (p: Promise<unknown>) => Promise.race([p.catch(() => {}), sleep(2_000)]);
    await bounded(Promise.all([this.syncing, ...ids.map((id) => this.opts.logs.unsubscribe(id))]));
    await bounded(this.idle());
  }
}
