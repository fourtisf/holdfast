import type { WsClientMessage, WsServerMessage } from "@holdfast/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsClient, messageKey, subscriptionKey, type SocketLike } from "./ws";

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: WsClientMessage[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor() {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as WsClientMessage);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
  push(msg: WsServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("keys", () => {
  it("maps subscriptions and messages to the same channel key", () => {
    expect(subscriptionKey({ channel: "trades", mint: "M" })).toBe("trades:M");
    expect(subscriptionKey({ channel: "deposit-status", launchId: "L" })).toBe("deposit-status:L");
    expect(subscriptionKey({ channel: "stats" })).toBe("stats");
    expect(messageKey({ channel: "vault", mint: "M", data: {} as never })).toBe("trades:M");
    expect(messageKey({ channel: "round", mint: "M", data: {} as never })).toBe("trades:M");
    expect(messageKey({ channel: "pong", serverTime: 1 })).toBeNull();
  });
});

describe("WsClient", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
  });
  afterEach(() => vi.useRealTimers());

  const make = () => new WsClient(() => new FakeSocket(), { random: () => 1, baseDelayMs: 100, maxDelayMs: 1000, pingIntervalMs: 10_000 });

  it("connects lazily and subscribes once per channel (ref-counted)", async () => {
    const client = make();
    expect(FakeSocket.instances).toHaveLength(0);
    const a = vi.fn();
    const b = vi.fn();
    const offA = client.subscribe({ channel: "trades", mint: "M" }, a);
    const offB = client.subscribe({ channel: "trades", mint: "M" }, b);
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    const socket = FakeSocket.instances[0]!;
    socket.open();
    expect(socket.sent).toEqual([{ type: "subscribe", channel: "trades", mint: "M" }]);

    socket.push({ channel: "trades", mint: "M", data: { sig: "1" } as never });
    socket.push({ channel: "vault", mint: "M", data: {} as never });
    socket.push({ channel: "trades", mint: "OTHER", data: { sig: "2" } as never });
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);

    offA();
    expect(socket.sent).toHaveLength(1);
    offB();
    expect(socket.sent[1]).toEqual({ type: "unsubscribe", channel: "trades", mint: "M" });
    offB(); // idempotent
    expect(socket.sent).toHaveLength(2);
    expect(client.activeChannels).toEqual([]);
  });

  it("reconnects with backoff and replays active subscriptions", async () => {
    const client = make();
    const states: string[] = [];
    client.onStateChange((s) => states.push(s));
    client.subscribe({ channel: "stats" }, () => {});
    client.subscribe({ channel: "deposit-status", launchId: "L" }, () => {});
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    FakeSocket.instances[0]!.open();

    FakeSocket.instances[0]!.drop();
    expect(client.state).toBe("reconnecting");
    vi.advanceTimersByTime(99);
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await flush();
    expect(FakeSocket.instances).toHaveLength(2);
    const second = FakeSocket.instances[1]!;
    second.open();
    expect(second.sent).toEqual([
      { type: "subscribe", channel: "stats" },
      { type: "subscribe", channel: "deposit-status", launchId: "L" },
    ]);
    expect(states).toEqual(["connecting", "open", "reconnecting", "open"]);
  });

  it("backs off exponentially up to the cap", async () => {
    const client = make();
    client.subscribe({ channel: "stats" }, () => {});
    for (let attempt = 0; attempt < 6; attempt++) {
      await flush();
      expect(FakeSocket.instances).toHaveLength(attempt + 1);
      FakeSocket.instances[attempt]!.drop();
      const delay = Math.min(1000, 100 * 2 ** attempt);
      vi.advanceTimersByTime(delay - 1);
      await flush();
      expect(FakeSocket.instances).toHaveLength(attempt + 1);
      vi.advanceTimersByTime(1);
    }
  });

  it("pings while open and reports pongs", async () => {
    const client = make();
    const pong = vi.fn();
    client.onPong(pong);
    client.subscribe({ channel: "stats" }, () => {});
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    const socket = FakeSocket.instances[0]!;
    socket.open();
    vi.advanceTimersByTime(10_000);
    expect(socket.sent.at(-1)).toEqual({ type: "ping" });
    socket.push({ channel: "pong", serverTime: 123 });
    expect(pong).toHaveBeenCalledWith(123);
  });

  it("stops reconnecting after close()", async () => {
    const client = make();
    client.subscribe({ channel: "stats" }, () => {});
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    FakeSocket.instances[0]!.open();
    client.close();
    expect(client.state).toBe("closed");
    vi.advanceTimersByTime(5000);
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("ignores malformed frames and isolates handler errors", async () => {
    const client = make();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = vi.fn();
    client.subscribe({ channel: "stats" }, () => {
      throw new Error("boom");
    });
    client.subscribe({ channel: "stats" }, good);
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.onmessage?.({ data: "not json" } as MessageEvent);
    socket.push({ channel: "stats", data: {} as never });
    expect(good).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
