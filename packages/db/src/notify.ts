import type { Queryable } from "./db.js";

/** pg NOTIFY channel the indexer / payout worker / launcher publish on and the API listens to. */
export const HOLDFAST_EVENTS_CHANNEL = "holdfast_events";

export type HoldfastNotification =
  /** New trade rows for `mint` in transaction `sig`. */
  | { kind: "trade"; mint: string; sig: string }
  /** vault_state of `mint` changed. */
  | { kind: "vault"; mint: string }
  /** Payout round `roundId` of `mint` changed status. */
  | { kind: "round"; mint: string; roundId: number }
  /** Coin row created or updated (graduation, metadata). */
  | { kind: "coin"; mint: string }
  /** Launch `launchId` changed status. */
  | { kind: "launch"; launchId: string }
  /** The vault of `mint` bought and burned $MOATPAD in transaction `sig` (hold_burns row). */
  | { kind: "burn"; mint: string; sig: string };

/** Send notifications on `q`. Inside a transaction they are delivered on commit. */
export async function notify(q: Queryable, events: HoldfastNotification | readonly HoldfastNotification[]): Promise<void> {
  const list = Array.isArray(events) ? events : [events as HoldfastNotification];
  for (const event of dedupeNotifications(list)) {
    await q.query("SELECT pg_notify($1, $2)", [HOLDFAST_EVENTS_CHANNEL, JSON.stringify(event)]);
  }
}

export function dedupeNotifications(events: readonly HoldfastNotification[]): HoldfastNotification[] {
  const seen = new Set<string>();
  const out: HoldfastNotification[] = [];
  for (const e of events) {
    const key = JSON.stringify(e);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

export function parseNotification(payload: string): HoldfastNotification | null {
  try {
    const v = JSON.parse(payload) as Record<string, unknown>;
    switch (v.kind) {
      case "trade":
        return typeof v.mint === "string" && typeof v.sig === "string" ? { kind: "trade", mint: v.mint, sig: v.sig } : null;
      case "vault":
      case "coin":
        return typeof v.mint === "string" ? { kind: v.kind, mint: v.mint } : null;
      case "round":
        return typeof v.mint === "string" && typeof v.roundId === "number" ? { kind: "round", mint: v.mint, roundId: v.roundId } : null;
      case "launch":
        return typeof v.launchId === "string" ? { kind: "launch", launchId: v.launchId } : null;
      case "burn":
        return typeof v.mint === "string" && typeof v.sig === "string" ? { kind: "burn", mint: v.mint, sig: v.sig } : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
