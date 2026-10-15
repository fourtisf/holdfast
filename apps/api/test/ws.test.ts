import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import type { LaunchResponse, WsServerMessage } from "@holdfast/core";
import { insertTrade, updateLaunchStatus, type Db } from "@holdfast/db";
import { SubscriptionHub, type HubClient } from "../src/index.js";
import { freshDb, makeApi, NOW, type TestApi } from "./helpers.js";
import { seedMarket, type MarketFixture } from "./fixtures.js";

let db: Db;
let api: TestApi;
let f: MarketFixture;
let url: string;

beforeAll(async () => {
  db = await freshDb();
  f = await seedMarket(db);
  api = await makeApi(db, { statsIntervalMs: 100 });
  await api.app.listen({ port: 0, host: "127.0.0.1" });
  url = `ws://127.0.0.1:${(api.app.server.address() as AddressInfo).port}/ws`;
});
afterAll(async () => {
  await api.app.close();
  await db.close();
});

class Client {
  readonly messages: WsServerMessage[] = [];
  private waiters: { pred: (m: WsServerMessage) => boolean; resolve: (m: WsServerMessage) => void }[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as WsServerMessage;
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => (w.pred(msg) ? (w.resolve(msg), false) : true));
    });
  }
  static async open(): Promise<Client> {
    const ws = new WebSocket(url);
    const c = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return c;
  }
  send(msg: unknown) {
    this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  next(pred: (m: WsServerMessage) => boolean, timeoutMs = 3000): Promise<WsServerMessage> {
    const seen = this.messages.find(pred);
    if (seen) {
      this.messages.splice(this.messages.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          this.messages.splice(this.messages.indexOf(m), 1);
          resolve(m);
        },
      });
    });
  }
  close() {
    this.ws.close();
  }
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("WebSocket /ws", () => {
  it("ping → pong with server time; invalid messages → error", async () => {
    const c = await Client.open();
    c.send({ type: "ping" });
    expect(await c.next((m) => m.channel === "pong")).toEqual({ channel: "pong", serverTime: NOW });
    c.send("not json");
    expect(await c.next((m) => m.channel === "error")).toEqual({ channel: "error", message: "Invalid message" });
    c.send({ type: "subscribe", channel: "trades", mint: "nope" });
    expect((await c.next((m) => m.channel === "error")).channel).toBe("error");
    c.close();
  });

  it("trades subscription receives trades, vault and round updates for its mint", async () => {
    const c = await Client.open();
    c.send({ type: "subscribe", channel: "trades", mint: f.mint });
    await settle();

    const sig = "LiveTradeSig1111111111111111111111111111111111111111111111111111";
    await insertTrade(db, { sig, ixIndex: 0, mint: f.mint, wallet: f.alice, side: "buy", sol: 250_000_000n, tokens: 1_000_000_000n, price: 2.5e-7, ts: NOW, slot: 500, source: "curve" });
    api.events.emit({ kind: "trade", mint: f.mint, sig });
    expect(await c.next((m) => m.channel === "trades")).toEqual({
      channel: "trades",
      mint: f.mint,
      data: { sig, ixIndex: 0, slot: 500, wallet: f.alice, side: "buy", sol: 0.25, tokens: 1000, price: 2.5e-7, ts: NOW, source: "curve" },
    });

    api.events.emit({ kind: "vault", mint: f.mint });
    const vault = await c.next((m) => m.channel === "vault");
    expect(vault).toMatchObject({ channel: "vault", mint: f.mint, data: { floorSol: 10, holderSol: 1, defendCount: 1 } });

    api.events.emit({ kind: "round", mint: f.mint, roundId: 1 });
    expect(await c.next((m) => m.channel === "round")).toMatchObject({ channel: "round", mint: f.mint, data: { roundId: 1, status: "closed", solPot: 0.5 } });

    // Other mints are not delivered.
    api.events.emit({ kind: "vault", mint: f.other });
    await settle();
    await api.ctx.feed.idle();
    expect(c.messages.filter((m) => m.channel === "vault")).toEqual([]);
    c.close();
  });

  it("tells every coin subscriber to resync after the change feed reconnects", async () => {
    const c = await Client.open();
    const s = await Client.open();
    c.send({ type: "subscribe", channel: "trades", mint: f.mint });
    s.send({ type: "subscribe", channel: "stats" });
    await settle();
    api.events.reconnect();
    expect(await c.next((m) => m.channel === "resync")).toEqual({ channel: "resync", mint: f.mint });
    await settle();
    expect(s.messages.filter((m) => m.channel === "resync")).toEqual([]);
    c.close();
    s.close();
  });

  it("subscriptions are ref-counted per client", async () => {
    const c = await Client.open();
    c.send({ type: "subscribe", channel: "trades", mint: f.other });
    c.send({ type: "subscribe", channel: "trades", mint: f.other });
    c.send({ type: "unsubscribe", channel: "trades", mint: f.other });
    await settle();
    api.events.emit({ kind: "vault", mint: f.other });
    expect((await c.next((m) => m.channel === "vault")).channel).toBe("vault");
    c.send({ type: "unsubscribe", channel: "trades", mint: f.other });
    await settle();
    api.events.emit({ kind: "vault", mint: f.other });
    await settle();
    await api.ctx.feed.idle();
    expect(c.messages.filter((m) => m.channel === "vault")).toEqual([]);
    c.close();
    await settle();
    expect(api.ctx.hub.has(`trades:${f.other}`)).toBe(false);
  });

  it("deposit-status: current status on subscribe, then updates", async () => {
    const created = (await api.app.inject({ method: "POST", url: "/launch", payload: { name: "Dog", ticker: "DOG", triggerBps: 2500 } })).json<LaunchResponse>();
    const c = await Client.open();
    c.send({ type: "subscribe", channel: "deposit-status", launchId: created.launchId });
    expect(await c.next((m) => m.channel === "deposit-status")).toMatchObject({ channel: "deposit-status", launchId: created.launchId, data: { status: "awaiting_deposit" } });
    await updateLaunchStatus(db, created.launchId, "deposit_received", { receivedLamports: 20_000_000n, sender: "S" });
    api.events.emit({ kind: "launch", launchId: created.launchId });
    expect(await c.next((m) => m.channel === "deposit-status")).toMatchObject({ data: { status: "deposit_received", receivedLamports: "20000000" } });
    c.send({ type: "subscribe", channel: "deposit-status", launchId: "unknown" });
    expect(await c.next((m) => m.channel === "error")).toEqual({ channel: "error", message: "Unknown launch" });
    c.close();
  });

  it("stats: snapshot on subscribe and periodic broadcasts", async () => {
    const c = await Client.open();
    c.send({ type: "subscribe", channel: "stats" });
    const first = await c.next((m) => m.channel === "stats");
    expect(first).toMatchObject({ channel: "stats", data: { coins: 2, totalVaultSol: 10 } });
    const tick = await c.next((m) => m.channel === "stats", 2000);
    expect(tick.channel).toBe("stats");
    c.close();
  });
});

describe("SubscriptionHub", () => {
  it("counts per client and cleans up", () => {
    const hub = new SubscriptionHub();
    const sent: unknown[] = [];
    const a: HubClient = { send: (m) => sent.push(["a", m]) };
    const b: HubClient = { send: (m) => sent.push(["b", m]) };
    expect(hub.subscribe(a, "stats")).toBe(true);
    expect(hub.subscribe(a, "stats")).toBe(false);
    expect(hub.subscribe(b, "stats")).toBe(true);
    expect(hub.broadcast("stats", { channel: "pong", serverTime: 1 })).toBe(2);
    expect(hub.unsubscribe(a, "stats")).toBe(false);
    expect(hub.unsubscribe(a, "stats")).toBe(true);
    expect(hub.clients("stats")).toEqual([b]);
    hub.removeClient(b);
    expect(hub.has("stats")).toBe(false);
    expect(hub.size).toBe(0);
    expect(sent).toHaveLength(2);
  });
});

describe("WebSocket /ws and the REST rate limit", () => {
  it("socket upgrades have their own budget, apart from the REST one", async () => {
    const limited = await makeApi(db, { rateLimitPerMinute: 2 });
    await limited.app.listen({ port: 0, host: "127.0.0.1" });
    const wsUrl = `ws://127.0.0.1:${(limited.app.server.address() as AddressInfo).port}/ws`;
    try {
      const sockets = await Promise.all(
        Array.from({ length: 4 }, () => {
          const ws = new WebSocket(wsUrl);
          return new Promise<WebSocket>((resolve, reject) => {
            ws.once("open", () => resolve(ws));
            ws.once("error", reject);
          });
        }),
      );
      expect(sockets).toHaveLength(4);
      for (const ws of sockets) ws.close();
      // REST still has its own (spent) limit.
      const codes = [];
      for (let i = 0; i < 3; i++) codes.push((await limited.app.inject({ method: "GET", url: "/stats" })).statusCode);
      expect(codes).toEqual([200, 200, 429]);
    } finally {
      await limited.app.close();
    }
  });
});
