import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTradesBySig, isProcessed, type Db } from "@holdfast/db";
import { LiveIngest, Poller, resolveWsUrl, type ChainSource, type LogSource } from "../src/index.js";
import type { ParsedTx } from "../src/tx.js";
import { coinFixture, harness, HOLDFAST, launchTx, silentLog, TxBuilder, wallet, type CoinFixture, type Harness } from "./fixtures.js";

const T0 = 1_760_000_000;
let h: Harness;
let db: Db;
let coin: CoinFixture;

beforeEach(async () => {
  h = await harness();
  db = h.db;
  coin = coinFixture();
});
afterEach(async () => {
  await db.close();
});

/** Push side of the node: `emit` delivers a signature to whoever watches one of its addresses. */
class FakeLogs implements LogSource {
  private nextId = 1;
  readonly subs = new Map<number, { address: string; onLog: (sig: string, err: unknown | null) => void }>();
  subscribe(address: string, onLog: (sig: string, err: unknown | null) => void) {
    const id = this.nextId++;
    this.subs.set(id, { address, onLog });
    return id;
  }
  async unsubscribe(id: number) {
    this.subs.delete(id);
  }
  get addresses() {
    return [...this.subs.values()].map((s) => s.address);
  }
  emit(sig: string, addresses: string[], err: unknown | null = null) {
    for (const s of this.subs.values()) if (addresses.includes(s.address)) s.onLog(sig, err);
  }
}

/** Transactions by signature; `lateBy` makes a body appear only after that many fetches. */
class FakeChain implements ChainSource {
  readonly txs = new Map<string, ParsedTx>();
  readonly lateBy = new Map<string, number>();
  fetched: string[] = [];
  async getSignaturesForAddress() {
    return [];
  }
  async getTransaction(signature: string) {
    this.fetched.push(signature);
    const late = this.lateBy.get(signature) ?? 0;
    if (late > 0) {
      this.lateBy.set(signature, late - 1);
      return null;
    }
    return this.txs.get(signature) ?? null;
  }
}

function setup(opts: { retryDelaysMs?: number[] } = {}) {
  const logs = new FakeLogs();
  const chain = new FakeChain();
  const results: string[] = [];
  const live = new LiveIngest({
    db,
    logs,
    chain,
    process: h.run,
    log: silentLog,
    holdfastProgramId: HOLDFAST,
    retryDelaysMs: opts.retryDelaysMs ?? [0, 1, 1],
    onResult: (s) => results.push(s),
  });
  return { logs, chain, live, results };
}

describe("LiveIngest", () => {
  it("watches the program and each coin's mint, and indexes pushed trades at once", async () => {
    const { logs, chain, live, results } = setup();
    await live.sync();
    expect(logs.addresses).toEqual([HOLDFAST]);

    const launch = launchTx(coin, {
      launcher: wallet(),
      depositor: wallet(),
      slot: 10,
      ts: T0,
      devBuy: 1n,
    });
    chain.txs.set(launch.signature, launch);
    logs.emit(launch.signature, [HOLDFAST, coin.mint]);
    await live.idle();
    expect(await isProcessed(db, launch.signature)).toBe(true);

    await live.sync();
    expect(logs.addresses).toEqual([HOLDFAST, coin.mint]);

    const a = wallet();
    const buy = new TxBuilder(11, T0 + 10, a)
      .curveTrade({
        mint: coin.mint,
        user: a,
        isBuy: true,
        sol: 1n,
        tokens: 10n,
      })
      .balance(coin.mint, coin.ata(a), a, null, 10n)
      .build();
    chain.txs.set(buy.signature, buy);
    logs.emit(buy.signature, [coin.mint]);
    logs.emit(buy.signature, [coin.mint]); // pushed twice (two subscriptions, a resubscribe): handled once
    await live.idle();
    expect(await getTradesBySig(db, buy.signature)).toHaveLength(1);
    expect(chain.fetched.filter((s) => s === buy.signature)).toHaveLength(1);
    expect(h.publisher.events.some((e) => e.kind === "trade" && e.sig === buy.signature)).toBe(true);
    expect(results.filter((r) => r === "processed")).toHaveLength(2);
  });

  it("retries a body that is not served yet, then leaves it to the poller", async () => {
    const { logs, chain, live, results } = setup({ retryDelaysMs: [0, 1, 1] });
    await live.sync();
    const launch = launchTx(coin, {
      launcher: wallet(),
      depositor: wallet(),
      slot: 10,
      ts: T0,
      devBuy: 1n,
    });
    chain.txs.set(launch.signature, launch);
    chain.lateBy.set(launch.signature, 2);
    logs.emit(launch.signature, [HOLDFAST]);
    await live.idle();
    expect(await isProcessed(db, launch.signature)).toBe(true);

    const other = launchTx(coinFixture(), {
      launcher: wallet(),
      depositor: wallet(),
      slot: 12,
      ts: T0 + 5,
      devBuy: 1n,
    });
    chain.txs.set(other.signature, other);
    chain.lateBy.set(other.signature, 5);
    logs.emit(other.signature, [HOLDFAST]);
    await live.idle();
    expect(await isProcessed(db, other.signature)).toBe(false);
    expect(results).toEqual(["processed", "unavailable"]);
  });

  it("skips failed and already indexed transactions; the poller does not index them twice", async () => {
    const { logs, chain, live } = setup();
    await live.sync();
    const launch = launchTx(coin, {
      launcher: wallet(),
      depositor: wallet(),
      slot: 10,
      ts: T0,
      devBuy: 1n,
    });
    chain.txs.set(launch.signature, launch);
    logs.emit("FailedSig1111111111111111111111111111111111111111111111111111111", [HOLDFAST], { InstructionError: [0, "Custom"] });
    logs.emit(launch.signature, [HOLDFAST]);
    await live.idle();
    expect(chain.fetched).toEqual([launch.signature]);

    // The poller lists the same signature afterwards: it is filtered out, not fetched again.
    const polled: string[] = [];
    const poller = new Poller({
      db,
      log: silentLog,
      holdfastProgramId: HOLDFAST,
      process: h.run,
      source: {
        getSignaturesForAddress: async (address) => (address === HOLDFAST ? [{ signature: launch.signature, slot: 10, err: null }] : []),
        getTransaction: async (sig) => (polled.push(sig), chain.txs.get(sig) ?? null),
      },
    });
    expect(await poller.tick()).toMatchObject({ processed: 0, failed: 0 });
    expect(polled).toEqual([]);
  });

  it("fetches at most maxConcurrent signatures at once and drops pushes past the backlog", async () => {
    const logs = new FakeLogs();
    let active = 0;
    let peak = 0;
    const results: string[] = [];
    const slowChain: ChainSource = {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return null;
      },
    };
    const live = new LiveIngest({
      db,
      logs,
      chain: slowChain,
      process: h.run,
      log: silentLog,
      holdfastProgramId: HOLDFAST,
      retryDelaysMs: [0],
      maxConcurrent: 2,
      maxBacklog: 3,
      onResult: (s) => results.push(s),
    });
    await live.sync();
    for (let i = 0; i < 8; i++) logs.emit(`Burst${i}`.padEnd(64, "1"), [HOLDFAST]);
    await live.idle();
    expect(peak).toBe(2);
    expect(results.filter((r) => r === "dropped")).toHaveLength(3); // 2 running + 3 queued, the other 3 dropped
    expect(results.filter((r) => r === "unavailable")).toHaveLength(5);
  });

  it("stops watching on stop()", async () => {
    const { logs, live } = setup();
    await live.sync();
    await live.stop();
    expect(logs.addresses).toEqual([]);
    logs.emit("x", [HOLDFAST]);
    await live.sync();
    expect(logs.addresses).toEqual([]);
  });
});

describe("resolveWsUrl", () => {
  it("derives the WebSocket from the RPC URL and ignores one on another host", () => {
    const rpc = "https://mainnet.helius-rpc.com/?api-key=k";
    expect(resolveWsUrl(rpc, null)).toEqual({ url: "wss://mainnet.helius-rpc.com/?api-key=k", ignored: null });
    expect(resolveWsUrl(rpc, "wss://mainnet.helius-rpc.com/?api-key=k")).toEqual({ url: "wss://mainnet.helius-rpc.com/?api-key=k", ignored: null });
    expect(resolveWsUrl(rpc, "wss://api.mainnet-beta.solana.com")).toEqual({ url: "wss://mainnet.helius-rpc.com/?api-key=k", ignored: "api.mainnet-beta.solana.com" });
    expect(resolveWsUrl("http://127.0.0.1:8899", "nonsense")).toEqual({ url: "ws://127.0.0.1:8899", ignored: "invalid URL" });
  });
});
