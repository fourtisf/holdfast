import type { WsClientMessage, WsServerMessage } from "@holdfast/core";
import type { SocketLike } from "../ws";
import { mockLaunchStatus } from "./api";
import * as market from "./market";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/** Simulated server socket: speaks the real WsClientMessage / WsServerMessage protocol in-process. */
export class MockSocket implements SocketLike {
  readyState = CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  private feeds = new Map<string, () => void>();

  constructor() {
    setTimeout(() => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      this.onopen?.({ type: "open" } as Event);
    }, 80);
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error("MockSocket is not open");
    const msg = JSON.parse(data) as WsClientMessage;
    if (msg.type === "ping") {
      this.emit({ channel: "pong", serverTime: Date.now() });
      return;
    }
    const key = msg.channel === "trades" ? `trades:${msg.mint}` : msg.channel === "deposit-status" ? `deposit:${msg.launchId}` : "stats";
    if (msg.type === "unsubscribe") {
      this.feeds.get(key)?.();
      this.feeds.delete(key);
      return;
    }
    if (this.feeds.has(key)) return;
    if (msg.channel === "trades") this.feeds.set(key, this.tradesFeed(msg.mint));
    else if (msg.channel === "deposit-status") this.feeds.set(key, this.depositFeed(msg.launchId));
    else this.feeds.set(key, this.statsFeed());
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    for (const stop of this.feeds.values()) stop();
    this.feeds.clear();
    setTimeout(() => this.onclose?.({ type: "close", code: 1000 } as CloseEvent), 0);
  }

  private emit(msg: WsServerMessage) {
    if (this.readyState === OPEN) this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }

  private tradesFeed(mint: string): () => void {
    let timer: ReturnType<typeof setTimeout>;
    let lastRound = market.roundState(mint)?.roundId ?? 0;
    const tick = () => {
      const result = market.simulateTrade(mint);
      if (result) {
        for (const trade of result.trades) this.emit({ channel: "trades", mint, data: trade });
        this.emit({ channel: "vault", mint, data: result.vault });
      }
      timer = setTimeout(tick, 900 + Math.random() * 2600);
    };
    timer = setTimeout(tick, 600);
    const roundTimer = setInterval(() => {
      const state = market.roundState(mint);
      if (!state || state.roundId === lastRound) return;
      lastRound = state.roundId;
      if (state.lastRound) this.emit({ channel: "round", mint, data: state.lastRound });
      this.emit({ channel: "vault", mint, data: state.vault });
    }, 1000);
    return () => {
      clearTimeout(timer);
      clearInterval(roundTimer);
    };
  }

  private depositFeed(launchId: string): () => void {
    let last = "";
    const check = () => {
      try {
        const status = mockLaunchStatus(launchId);
        if (status.status !== last) {
          last = status.status;
          this.emit({ channel: "deposit-status", launchId, data: status });
        }
      } catch {
        this.emit({ channel: "error", message: `unknown launch ${launchId}` });
      }
    };
    const timer = setInterval(check, 500);
    setTimeout(check, 50);
    return () => clearInterval(timer);
  }

  private statsFeed(): () => void {
    const timer = setInterval(() => this.emit({ channel: "stats", data: market.stats() }), 10_000);
    return () => clearInterval(timer);
  }
}
