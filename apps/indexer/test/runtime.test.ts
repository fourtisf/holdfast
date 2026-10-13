import { afterEach, beforeEach, describe, expect, it } from "vitest";
import bs58 from "bs58";
import { getCursor, getTradesBySig, isProcessed, type Db } from "@holdfast/db";
import { buildWebhookServer, fromRawTransactionJson, loadConfig, Poller, reductionOrderFrom, serialProcessor, type ChainSource, type SignatureInfo } from "../src/index.js";
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

/** In-memory chain: per-address signature lists (newest first) and transactions. */
class FakeChain implements ChainSource {
  readonly byAddress = new Map<string, SignatureInfo[]>();
  readonly txs = new Map<string, ParsedTx>();
  readonly unavailable = new Set<string>();
  fetched: string[] = [];

  add(tx: ParsedTx, addresses: string[]) {
    this.txs.set(tx.signature, tx);
    for (const a of addresses) {
      const list = this.byAddress.get(a) ?? [];
      list.unshift({ signature: tx.signature, slot: tx.slot, err: tx.err });
      this.byAddress.set(a, list);
    }
  }

  async getSignaturesForAddress(address: string, opts: { before?: string; until?: string; limit: number }) {
    let list = this.byAddress.get(address) ?? [];
    if (opts.before) list = list.slice(list.findIndex((s) => s.signature === opts.before) + 1);
    if (opts.until) {
      const i = list.findIndex((s) => s.signature === opts.until);
      if (i >= 0) list = list.slice(0, i);
    }
    return list.slice(0, opts.limit);
  }

  async getTransaction(signature: string) {
    this.fetched.push(signature);
    if (this.unavailable.has(signature)) return null;
    return this.txs.get(signature) ?? null;
  }
}

describe("Poller", () => {
  it("indexes new signatures oldest first, advances cursors, retries failures", async () => {
    const chain = new FakeChain();
    const launch = launchTx(coin, { launcher: wallet(), depositor: wallet(), slot: 10, ts: T0, devBuy: 1n });
    chain.add(launch, [HOLDFAST, coin.mint, coin.bondingCurve]);
    const poller = new Poller({ db, source: chain, process: h.run, log: silentLog, holdfastProgramId: HOLDFAST, pageSize: 2 });

    let r = await poller.tick();
    expect(r).toMatchObject({ processed: 1, failed: 0 });
    expect(await getCursor(db, `sigs:${HOLDFAST}`)).toMatchObject({ lastSig: launch.signature, lastSlot: 10 });

    // The coin is known now: its mint and curve are polled too.
    const a = wallet();
    const buy1 = new TxBuilder(11, T0 + 10, a).curveTrade({ mint: coin.mint, user: a, isBuy: true, sol: 1n, tokens: 10n }).balance(coin.mint, coin.ata(a), a, null, 10n).build();
    const buy2 = new TxBuilder(12, T0 + 20, a).curveTrade({ mint: coin.mint, user: a, isBuy: true, sol: 1n, tokens: 5n }).balance(coin.mint, coin.ata(a), a, 10n, 15n).build();
    const buy3 = new TxBuilder(13, T0 + 30, a).curveTrade({ mint: coin.mint, user: a, isBuy: true, sol: 1n, tokens: 1n }).balance(coin.mint, coin.ata(a), a, 15n, 16n).build();
    for (const tx of [buy1, buy2, buy3]) chain.add(tx, [coin.mint, coin.bondingCurve]);
    chain.unavailable.add(buy2.signature);
    chain.fetched = [];

    r = await poller.tick();
    expect(r).toMatchObject({ processed: 2, failed: 1 });
    expect(chain.fetched).toEqual([buy1.signature, buy2.signature, buy3.signature]);
    expect(await getCursor(db, `sigs:${coin.mint}`)).toMatchObject({ lastSig: buy1.signature });
    expect(await isProcessed(db, buy3.signature)).toBe(true);

    chain.unavailable.clear();
    chain.fetched = [];
    r = await poller.tick();
    expect(r).toMatchObject({ processed: 1, failed: 0 });
    expect(chain.fetched).toEqual([buy2.signature]);
    expect(await getCursor(db, `sigs:${coin.bondingCurve}`)).toMatchObject({ lastSig: buy3.signature, lastSlot: 13 });

    chain.fetched = [];
    r = await poller.tick();
    expect(r).toMatchObject({ signatures: 0, processed: 0 });
  });

  it("marks failed transactions processed without fetching them", async () => {
    const chain = new FakeChain();
    const launch = launchTx(coin, { launcher: wallet(), depositor: wallet(), slot: 10, ts: T0, devBuy: 1n });
    chain.add({ ...launch, err: { InstructionError: [0, "Custom"] } }, [HOLDFAST]);
    const poller = new Poller({ db, source: chain, process: h.run, log: silentLog, holdfastProgramId: HOLDFAST });
    await poller.tick();
    expect(chain.fetched).toEqual([]);
    expect(await isProcessed(db, launch.signature)).toBe(true);
  });
});

describe("Helius webhook endpoint", () => {
  it("authenticates and processes raw deliveries idempotently", async () => {
    await h.run(launchTx(coin, { launcher: wallet(), depositor: wallet(), slot: 10, ts: T0, devBuy: 1n }));
    const app = buildWebhookServer({ secret: "s3cret", process: h.run });
    const a = wallet();
    const built = new TxBuilder(20, T0 + 5, a).curveTrade({ mint: coin.mint, user: a, isBuy: true, sol: 7n, tokens: 70n }).balance(coin.mint, coin.ata(a), a, null, 70n).build();
    // Serialize as the JSON-RPC shape Helius raw webhooks deliver.
    const keys = built.accountKeys;
    const raw = {
      slot: built.slot,
      blockTime: built.blockTime! / 1000,
      transaction: {
        signatures: [built.signature],
        message: {
          accountKeys: keys,
          header: { numRequiredSignatures: 1 },
          instructions: built.instructions.map((ix) => ({ programIdIndex: keys.indexOf(ix.programId), accounts: [], data: bs58.encode(ix.data) })),
        },
      },
      meta: {
        err: null,
        logMessages: built.logMessages,
        innerInstructions: built.innerInstructions.map((g) => ({
          index: g.index,
          instructions: g.instructions.map((ix) => ({ programIdIndex: keys.indexOf(ix.programId), accounts: [], data: bs58.encode(ix.data) })),
        })),
        preTokenBalances: [],
        postTokenBalances: built.postTokenBalances.map((b) => ({ accountIndex: b.accountIndex, mint: b.mint, owner: b.owner, uiTokenAmount: { amount: b.amount.toString(), decimals: 6 } })),
        preBalances: keys.map(() => 0),
        postBalances: keys.map(() => 0),
      },
    };
    expect(fromRawTransactionJson(raw as never).signature).toBe(built.signature);

    expect((await app.inject({ method: "POST", url: "/webhooks/helius", payload: [raw] })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/webhooks/helius", headers: { authorization: "nope" }, payload: [raw] })).statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/webhooks/helius", headers: { authorization: "s3cret" }, payload: [raw, { junk: true }] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ received: 2, processed: 1 });
    const again = await app.inject({ method: "POST", url: "/webhooks/helius", headers: { authorization: "Bearer s3cret" }, payload: [raw] });
    expect(again.json()).toMatchObject({ duplicate: 1 });
    expect(await getTradesBySig(db, built.signature)).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ ok: true });

    const failing = buildWebhookServer({ secret: "s3cret", process: async () => { throw new Error("db down"); } });
    expect((await failing.inject({ method: "POST", url: "/webhooks/helius", headers: { authorization: "s3cret" }, payload: [raw] })).statusCode).toBe(500);
    const closed = buildWebhookServer({ secret: null, process: h.run });
    expect((await closed.inject({ method: "POST", url: "/webhooks/helius", headers: { authorization: "" }, payload: [] })).statusCode).toBe(401);
  });
});

describe("serialProcessor", () => {
  it("processes concurrent deliveries one at a time, each exactly once", async () => {
    await h.run(launchTx(coin, { launcher: wallet(), depositor: wallet(), slot: 10, ts: T0, devBuy: 1n }));
    const run = serialProcessor(h.deps);
    const a = wallet();
    const tx = new TxBuilder(20, T0 + 5, a).curveTrade({ mint: coin.mint, user: a, isBuy: true, sol: 1n, tokens: 10n }).balance(coin.mint, coin.ata(a), a, null, 10n).build();
    const results = await Promise.all([run(tx), run(tx), run(tx)]);
    expect(results.map((r) => r.status)).toEqual(["processed", "duplicate", "duplicate"]);
  });
});

describe("config", () => {
  it("reads env", () => {
    const c = loadConfig({ DATABASE_URL: "pglite://memory", LOT_REDUCTION_ORDER: "LIFO", INDEXER_POLL: "0", LAUNCHER_ADDRESS: "a, b" });
    expect(c).toMatchObject({ reductionOrder: "lifo", poll: false, launcherAddresses: ["a", "b"], port: 4100 });
    expect(reductionOrderFrom(undefined)).toBe("fifo");
    expect(() => reductionOrderFrom("random")).toThrow();
    expect(() => loadConfig({})).toThrow("DATABASE_URL");
  });
});
