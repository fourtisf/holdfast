import { PublicKey, type Connection, type Finality } from "@solana/web3.js";
import { filterUnprocessed, getCursor, listCoins, markProcessed, setCursor, type Db } from "@holdfast/db";
import { fromVersionedTransactionResponse } from "./adapters/web3.js";
import type { Logger, ProcessResult } from "./process.js";
import type { ParsedTx } from "./tx.js";

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown | null;
}

/** The two RPC calls the poller needs; injectable so tests run without a node. */
export interface ChainSource {
  /** Newest first, like `getSignaturesForAddress`. */
  getSignaturesForAddress(address: string, opts: { before?: string; until?: string; limit: number }): Promise<SignatureInfo[]>;
  getTransaction(signature: string): Promise<ParsedTx | null>;
}

export function rpcChainSource(connection: Connection, opts: { commitment?: Finality; maxSupportedTransactionVersion?: number } = {}): ChainSource {
  const commitment = opts.commitment ?? "confirmed";
  return {
    async getSignaturesForAddress(address, o) {
      const res = await connection.getSignaturesForAddress(new PublicKey(address), { before: o.before, until: o.until, limit: o.limit }, commitment);
      return res.map((r) => ({ signature: r.signature, slot: r.slot, err: r.err }));
    },
    async getTransaction(signature) {
      const res = await connection.getTransaction(signature, { commitment, maxSupportedTransactionVersion: opts.maxSupportedTransactionVersion ?? 0 });
      return res ? fromVersionedTransactionResponse(res) : null;
    },
  };
}

export interface PollerOptions {
  db: Db;
  source: ChainSource;
  process: (tx: ParsedTx) => Promise<ProcessResult>;
  log: Logger;
  holdfastProgramId: string;
  intervalMs?: number;
  pageSize?: number;
  /** Upper bound of signature pages fetched per address and tick. */
  maxPages?: number;
  /** Transactions fetched in parallel (processing itself is sequential, in chain order). */
  fetchConcurrency?: number;
  /** Called after every completed tick (health / metrics). */
  onTick?: (r: TickResult) => void;
}

export interface TickResult {
  addresses: number;
  signatures: number;
  processed: number;
  failed: number;
}

const cursorName = (address: string) => `sigs:${address}`;

/**
 * Polls `getSignaturesForAddress` for the Holdfast program and every coin's mint, bonding curve
 * and pool. New signatures of all sources are merged, processed oldest first, and each source's
 * cursor only advances past a signature once it and everything older succeeded, so failures are
 * retried on the next tick.
 */
export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;

  constructor(private readonly opts: PollerOptions) {}

  async addresses(): Promise<string[]> {
    const set = new Set<string>([this.opts.holdfastProgramId]);
    for (const c of await listCoins(this.opts.db)) {
      set.add(c.mint);
      set.add(c.bondingCurve);
      if (c.ammPool) set.add(c.ammPool);
    }
    return [...set];
  }

  private async fetchNew(address: string): Promise<SignatureInfo[]> {
    const { source, log } = this.opts;
    const pageSize = this.opts.pageSize ?? 1000;
    const maxPages = this.opts.maxPages ?? 100;
    const cursor = await getCursor(this.opts.db, cursorName(address));
    const out: SignatureInfo[] = [];
    let before: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const batch = await source.getSignaturesForAddress(address, { before, until: cursor?.lastSig ?? undefined, limit: pageSize });
      out.push(...batch);
      if (batch.length < pageSize) return out;
      before = batch[batch.length - 1]!.signature;
    }
    log.warn({ address, fetched: out.length }, "signature backlog larger than maxPages; older history skipped (balances reconcile on next sight)");
    return out;
  }

  async tick(): Promise<TickResult> {
    const { db, source, log } = this.opts;
    const addresses = await this.addresses();
    const perAddress = new Map<string, SignatureInfo[]>();
    const all = new Map<string, { info: SignatureInfo; rank: number }>();
    for (const address of addresses) {
      let sigs: SignatureInfo[];
      try {
        sigs = await this.fetchNew(address);
      } catch (err) {
        log.warn({ err, address }, "getSignaturesForAddress failed");
        continue;
      }
      perAddress.set(address, sigs);
      sigs.forEach((info, i) => {
        // Lists are newest first: a larger index is older within the same slot.
        if (!all.has(info.signature)) all.set(info.signature, { info, rank: -i });
      });
    }

    const ordered = [...all.values()].sort((a, b) => a.info.slot - b.info.slot || a.rank - b.rank).map((x) => x.info);
    const pending = new Set(await filterUnprocessed(db, ordered.map((s) => s.signature)));
    const failed = new Set<string>();
    let processed = 0;

    const work = ordered.filter((s) => pending.has(s.signature));
    const concurrency = Math.max(1, this.opts.fetchConcurrency ?? 4);
    const fetches = new Map<string, Promise<ParsedTx | null>>();
    const prefetch = (i: number) => {
      const s = work[i];
      if (s && !s.err && !fetches.has(s.signature)) fetches.set(s.signature, source.getTransaction(s.signature));
    };
    for (let i = 0; i < concurrency; i++) prefetch(i);

    for (let i = 0; i < work.length; i++) {
      const s = work[i]!;
      prefetch(i + concurrency);
      try {
        if (s.err) {
          await markProcessed(db, s.signature, s.slot);
        } else {
          const tx = await fetches.get(s.signature)!;
          fetches.delete(s.signature);
          if (!tx) throw new Error("transaction not available yet");
          const result = await this.opts.process(tx);
          if (result.status === "processed") log.debug({ sig: s.signature, ...result, notifications: undefined }, "indexed");
        }
        processed++;
      } catch (err) {
        failed.add(s.signature);
        log.error({ err, sig: s.signature, slot: s.slot }, "failed to index transaction; will retry");
      }
    }

    for (const [address, sigs] of perAddress) {
      let good: SignatureInfo | null = null;
      for (let i = sigs.length - 1; i >= 0; i--) {
        const s = sigs[i]!;
        if (failed.has(s.signature)) break;
        good = s;
      }
      if (good) await setCursor(db, cursorName(address), good.signature, good.slot);
    }
    return { addresses: addresses.length, signatures: ordered.length, processed, failed: failed.size };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      this.running = this.tick()
        .then((r) => {
          this.opts.onTick?.(r);
          if (r.processed || r.failed) this.opts.log.info(r, "poll tick");
        })
        .catch((err) => this.opts.log.error({ err }, "poll tick failed"));
      await this.running;
      if (!this.stopped) this.timer = setTimeout(loop, this.opts.intervalMs ?? 3000);
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
