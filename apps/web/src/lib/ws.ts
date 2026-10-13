import type { WsClientMessage, WsServerMessage } from "@holdfast/core";
import { USE_MOCKS, WS_URL } from "./config";

export type Subscription = { channel: "trades"; mint: string } | { channel: "deposit-status"; launchId: string } | { channel: "stats" };

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/** The subset of the browser WebSocket the client relies on (lets mocks and tests plug in). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
}

export type SocketFactory = () => SocketLike | Promise<SocketLike>;
export type MessageHandler = (msg: WsServerMessage) => void;

const OPEN = 1;

export function subscriptionKey(sub: Subscription): string {
  switch (sub.channel) {
    case "trades":
      return `trades:${sub.mint}`;
    case "deposit-status":
      return `deposit-status:${sub.launchId}`;
    case "stats":
      return "stats";
  }
}

/** Which subscription a server message belongs to (`vault` and `round` ride on the `trades` channel). */
export function messageKey(msg: WsServerMessage): string | null {
  switch (msg.channel) {
    case "trades":
    case "vault":
    case "round":
      return `trades:${msg.mint}`;
    case "deposit-status":
      return `deposit-status:${msg.launchId}`;
    case "stats":
      return "stats";
    default:
      return null;
  }
}

function subscribeMessage(sub: Subscription, type: "subscribe" | "unsubscribe"): WsClientMessage {
  return { type, ...sub } as WsClientMessage;
}

export interface WsClientOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  pingIntervalMs?: number;
  random?: () => number;
}

interface Entry {
  sub: Subscription;
  handlers: Set<{ fn: MessageHandler }>;
}

/**
 * One shared, lazily-connected socket for the whole app. Subscriptions are ref-counted per channel key:
 * the first subscriber sends `subscribe`, the last one to leave sends `unsubscribe`, and every active
 * subscription is replayed after a reconnect.
 */
export class WsClient {
  private socket: SocketLike | null = null;
  private entries = new Map<string, Entry>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private pongListeners = new Set<(serverTime: number) => void>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUser = false;
  private pending = false;
  private generation = 0;
  private _state: ConnectionState = "idle";
  private readonly opts: Required<WsClientOptions>;

  constructor(
    private readonly factory: SocketFactory,
    opts: WsClientOptions = {},
  ) {
    this.opts = { baseDelayMs: 500, maxDelayMs: 15_000, pingIntervalMs: 25_000, random: Math.random, ...opts };
  }

  get state(): ConnectionState {
    return this._state;
  }

  /** Number of distinct channel subscriptions currently held (for tests / diagnostics). */
  get activeChannels(): string[] {
    return [...this.entries.keys()];
  }

  subscribe(sub: Subscription, fn: MessageHandler): () => void {
    const key = subscriptionKey(sub);
    const token = { fn };
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { sub, handlers: new Set() };
      this.entries.set(key, entry);
      this.send(subscribeMessage(sub, "subscribe"));
    }
    entry.handlers.add(token);
    this.ensureConnected();

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.entries.get(key);
      if (!current) return;
      current.handlers.delete(token);
      if (current.handlers.size === 0) {
        this.entries.delete(key);
        this.send(subscribeMessage(sub, "unsubscribe"));
      }
    };
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onPong(listener: (serverTime: number) => void): () => void {
    this.pongListeners.add(listener);
    return () => this.pongListeners.delete(listener);
  }

  close(): void {
    this.closedByUser = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.generation++;
    socket?.close();
    this.setState("closed");
  }

  private ensureConnected(): void {
    if (this.socket || this.reconnectTimer || this.pending) return;
    this.closedByUser = false;
    void this.connect();
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    let socket: SocketLike;
    this.pending = true;
    try {
      socket = await this.factory();
    } catch {
      if (generation === this.generation) this.scheduleReconnect();
      return;
    } finally {
      this.pending = false;
    }
    if (generation !== this.generation || this.closedByUser) {
      socket.close();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (generation !== this.generation) return;
      this.attempt = 0;
      this.setState("open");
      for (const entry of this.entries.values()) this.send(subscribeMessage(entry.sub, "subscribe"));
      this.startPing();
    };
    socket.onmessage = (ev) => {
      if (generation !== this.generation) return;
      this.dispatch(ev.data);
    };
    socket.onerror = () => {
      // onclose follows; reconnect is handled there.
    };
    socket.onclose = () => {
      if (generation !== this.generation) return;
      this.socket = null;
      this.stopPing();
      if (this.closedByUser) {
        this.setState("closed");
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.socket = null;
    if (this.closedByUser) return;
    const exp = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** this.attempt);
    const delay = Math.round(exp * (0.5 + this.opts.random() * 0.5));
    this.attempt++;
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private dispatch(raw: unknown): void {
    if (typeof raw !== "string") return;
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(raw) as WsServerMessage;
    } catch {
      return;
    }
    if (msg.channel === "pong") {
      for (const l of this.pongListeners) l(msg.serverTime);
      return;
    }
    const key = messageKey(msg);
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    for (const { fn } of [...entry.handlers]) {
      try {
        fn(msg);
      } catch (err) {
        console.warn("[ws] handler failed", err);
      }
    }
  }

  private send(msg: WsClientMessage): void {
    if (this.socket && this.socket.readyState === OPEN) this.socket.send(JSON.stringify(msg));
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), this.opts.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    for (const l of this.stateListeners) l(state);
  }
}

let shared: WsClient | null = null;

/** The app-wide socket. In mock mode the transport is an in-browser simulation. */
export function getWsClient(): WsClient {
  if (!shared) {
    shared = new WsClient(USE_MOCKS ? () => import("./mocks/socket").then((m) => new m.MockSocket()) : () => new WebSocket(WS_URL));
  }
  return shared;
}
