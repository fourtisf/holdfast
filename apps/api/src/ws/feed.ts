import type { Stats, WsServerMessage } from "@holdfast/core";
import { getCoinMetrics, type Db, type HoldfastNotification } from "@holdfast/db";
import type { LaunchService } from "../launch/service.js";
import type { SolPriceSource } from "../services/price.js";
import { toCoinSummary } from "../present.js";
import { roundSummary, stats, tradesBySig } from "../services/market.js";
import type { EventSource } from "./events.js";
import type { HubClient, SubscriptionHub } from "./hub.js";

interface FeedLogger {
  warn(obj: object, msg?: string): void;
}

/**
 * Turns change notifications into WebSocket messages for subscribed clients (in arrival order)
 * and broadcasts stats periodically while anyone listens.
 */
export class LiveFeed {
  private queue: Promise<void> = Promise.resolve();
  private unsubscribe: (() => Promise<void>) | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      db: Db;
      hub: SubscriptionHub;
      launches: LaunchService;
      prices?: SolPriceSource;
      now: () => number;
      log: FeedLogger;
      statsIntervalMs: number;
    },
  ) {}

  async start(source: EventSource): Promise<void> {
    this.unsubscribe = await source.subscribe((n) => this.enqueue(n));
    if (this.deps.statsIntervalMs > 0) {
      this.timer = setInterval(() => void this.broadcastStats(), this.deps.statsIntervalMs);
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.unsubscribe?.();
    await this.queue;
  }

  /** Resolves once every notification received so far has been delivered. */
  idle(): Promise<void> {
    return this.queue;
  }

  enqueue(n: HoldfastNotification): void {
    this.queue = this.queue.then(() => this.handle(n)).catch((err) => this.deps.log.warn({ err, notification: n }, "ws feed failed"));
  }

  async handle(n: HoldfastNotification): Promise<void> {
    const { db, hub } = this.deps;
    switch (n.kind) {
      case "trade": {
        const key = `trades:${n.mint}`;
        if (!hub.has(key)) return;
        for (const data of await tradesBySig(db, n.mint, n.sig)) hub.broadcast(key, { channel: "trades", mint: n.mint, data });
        return;
      }
      case "vault":
      case "coin": {
        const key = `trades:${n.mint}`;
        if (!hub.has(key)) return;
        const m = await getCoinMetrics(db, n.mint, this.deps.now());
        if (m) hub.broadcast(key, { channel: "vault", mint: n.mint, data: toCoinSummary(m).vault });
        return;
      }
      case "round": {
        const key = `trades:${n.mint}`;
        if (!hub.has(key)) return;
        const data = await roundSummary(db, n.mint, n.roundId);
        if (data) hub.broadcast(key, { channel: "round", mint: n.mint, data });
        return;
      }
      case "launch": {
        const key = `deposit-status:${n.launchId}`;
        if (!hub.has(key)) return;
        const data = await this.deps.launches.get(n.launchId);
        if (data) hub.broadcast(key, { channel: "deposit-status", launchId: n.launchId, data });
        return;
      }
    }
  }

  async currentStats(): Promise<Stats> {
    return stats(this.deps.db, this.deps.now(), this.deps.prices?.solUsd() ?? null);
  }

  async broadcastStats(): Promise<void> {
    if (!this.deps.hub.has("stats")) return;
    try {
      const data = await this.currentStats();
      this.deps.hub.broadcast("stats", { channel: "stats", data });
    } catch (err) {
      this.deps.log.warn({ err }, "stats broadcast failed");
    }
  }

  /** Initial message for a new subscription (current stats / launch status). */
  async snapshotFor(client: HubClient, sub: { channel: string; launchId?: string }): Promise<void> {
    let msg: WsServerMessage | null = null;
    if (sub.channel === "stats") msg = { channel: "stats", data: await this.currentStats() };
    if (sub.channel === "deposit-status" && sub.launchId) {
      const data = await this.deps.launches.get(sub.launchId);
      msg = data ? { channel: "deposit-status", launchId: sub.launchId, data } : { channel: "error", message: "Unknown launch" };
    }
    if (msg) client.send(msg);
  }
}
