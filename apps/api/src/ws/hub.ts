import type { WsServerMessage } from "@holdfast/core";

export type SubscriptionTarget = { channel: "trades"; mint: string } | { channel: "deposit-status"; launchId: string } | { channel: "stats" };

export interface HubClient {
  send(msg: WsServerMessage): void;
}

export function subscriptionKey(sub: SubscriptionTarget): string {
  switch (sub.channel) {
    case "trades":
      return `trades:${sub.mint}`;
    case "deposit-status":
      return `deposit-status:${sub.launchId}`;
    case "stats":
      return "stats";
  }
}

/**
 * Ref-counted subscriptions: a client may subscribe to the same channel more than once and stays
 * subscribed until it unsubscribed as many times (or disconnects).
 */
export class SubscriptionHub {
  private readonly byKey = new Map<string, Map<HubClient, number>>();
  private readonly byClient = new Map<HubClient, Set<string>>();

  /** Returns true when this is the client's first subscription to `key`. */
  subscribe(client: HubClient, key: string): boolean {
    let clients = this.byKey.get(key);
    if (!clients) {
      clients = new Map();
      this.byKey.set(key, clients);
    }
    const count = clients.get(client) ?? 0;
    clients.set(client, count + 1);
    let keys = this.byClient.get(client);
    if (!keys) {
      keys = new Set();
      this.byClient.set(client, keys);
    }
    keys.add(key);
    return count === 0;
  }

  /** Returns true when the client no longer listens to `key`. */
  unsubscribe(client: HubClient, key: string): boolean {
    const clients = this.byKey.get(key);
    const count = clients?.get(client);
    if (!clients || count === undefined) return false;
    if (count > 1) {
      clients.set(client, count - 1);
      return false;
    }
    clients.delete(client);
    if (clients.size === 0) this.byKey.delete(key);
    const keys = this.byClient.get(client);
    keys?.delete(key);
    if (keys && keys.size === 0) this.byClient.delete(client);
    return true;
  }

  removeClient(client: HubClient): void {
    for (const key of this.byClient.get(client) ?? []) {
      const clients = this.byKey.get(key);
      clients?.delete(client);
      if (clients && clients.size === 0) this.byKey.delete(key);
    }
    this.byClient.delete(client);
  }

  clients(key: string): HubClient[] {
    return [...(this.byKey.get(key)?.keys() ?? [])];
  }

  has(key: string): boolean {
    return (this.byKey.get(key)?.size ?? 0) > 0;
  }

  broadcast(key: string, msg: WsServerMessage): number {
    const targets = this.clients(key);
    for (const c of targets) c.send(msg);
    return targets.length;
  }

  get size(): number {
    return this.byClient.size;
  }
}
