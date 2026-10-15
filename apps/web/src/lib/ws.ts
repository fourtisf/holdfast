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

/** Which subscription a server message belongs to (`vault`, `round` and `resync` ride on the `trades` channel). */
export function messageKey(msg: WsServerMessage): string | null {
  switch (msg.channel) {
    case "trades":
    case "vault":
    case "round":
    case "resync":
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
  /** A socket that has not opened by then is abandoned and retried. */
  connectTimeoutMs?: number;
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
 *
 * The server answers every ping, so a socket whose last ping is still unanswered at the next ping is dead
 * (sleep, a network change) even if the browser still calls it open: it is dropped and replaced. This counts
 * pings, not elapsed time, so throttled timers in background tabs do not look like a dead socket.
 */
export class WsClient {
  private socket: SocketLike | null = null;
  private entries = new Map<string, Entry>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private pongListeners = new Set<(serverTime: number) => void>();
  private openListeners = new Set<() => void>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFrameAt = 0;
  private pingSentAt = 0;
  private _serverOffsetMs = 0;
  private closedByUser = false;
  private pending = false;
  private generation = 0;
  private _state: ConnectionState = "idle";
  private readonly opts: Required<WsClientOptions>;

  constructor(
    private readonly factory: SocketFactory,
    opts: WsClientOptions = {},
  ) {
    this.opts = { baseDelayMs: 500, maxDelayMs: 15_000, pingIntervalMs: 25_000, connectTimeoutMs: 10_000, random: Math.random, ...opts };
  }

  get state(): ConnectionState {
    return this._state;
  }

  /** Server clock minus local clock, from the last pong (0 until one arrives). */
  get serverOffsetMs(): number {
    return this._serverOffsetMs;
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

  /**
   * Called each time a socket opens, after the subscriptions were (re)sent. Live messages sent while there
   * was no socket are lost, so subscribers refetch here.
   */
  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  /**
   * The page became visible or the network came back: reconnect now instead of waiting out the backoff,
   * and make sure an "open" socket still answers.
   */
  wake(): void {
    if (this.closedByUser || this.entries.size === 0) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.attempt = 0;
      void this.connect();
      return;
    }
    if (this.socket && this.socket.readyState === OPEN) {
      const since = this.lastFrameAt;
      this.send({ type: "ping" });
      setTimeout(() => {
        if (this.socket && this.lastFrameAt === since) this.restart();
      }, 5_000);
    }
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
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (generation === this.generation && socket.readyState !== OPEN) this.restart();
    }, this.opts.connectTimeoutMs);
    socket.onopen = () => {
      if (generation !== this.generation) return;
      this.clearConnectTimer();
      this.attempt = 0;
      this.lastFrameAt = Date.now();
      this.pingSentAt = 0;
      this.setState("open");
      for (const entry of this.entries.values()) this.send(subscribeMessage(entry.sub, "subscribe"));
      this.startPing();
      this.ping(); // early pong: the server clock offset
      for (const l of [...this.openListeners]) {
        try {
          l();
        } catch (err) {
          console.warn("[ws] open listener failed", err);
        }
      }
    };
    socket.onmessage = (ev) => {
      if (generation !== this.generation) return;
      this.lastFrameAt = Date.now();
      this.dispatch(ev.data);
    };
    socket.onerror = () => {
      // onclose follows; reconnect is handled there.
    };
    socket.onclose = () => {
      if (generation !== this.generation) return;
      this.socket = null;
      this.clearConnectTimer();
      this.stopPing();
      if (this.closedByUser) {
        this.setState("closed");
        return;
      }
      this.scheduleReconnect();
    };
  }

  /** Abandon the current socket (its handlers are detached by the generation bump) and reconnect. */
  private restart(): void {
    const socket = this.socket;
    this.generation++;
    this.socket = null;
    this.clearConnectTimer();
    this.stopPing();
    socket?.close();
    this.scheduleReconnect();
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
      this._serverOffsetMs = msg.serverTime - Date.now();
      for (const l of this.pongListeners) l(msg.serverTime);
      return;
    }
    if (msg.channel === "error") {
      console.warn("[ws] server error:", msg.message);
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
    this.pingTimer = setInterval(() => {
      // The previous ping got no answer (no frame at all since it was sent): the socket is dead.
      if (this.pingSentAt > this.lastFrameAt) {
        this.restart();
        return;
      }
      this.ping();
    }, this.opts.pingIntervalMs);
  }

  private ping(): void {
    this.pingSentAt = Date.now();
    this.send({ type: "ping" });
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearTimers(): void {
    this.stopPing();
    this.clearConnectTimer();
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
    const client = new WsClient(USE_MOCKS ? () => import("./mocks/socket").then((m) => new m.MockSocket()) : () => new WebSocket(WS_URL));
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => client.wake());
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") client.wake();
      });
    }
    shared = client;
  }
  return shared;
}
