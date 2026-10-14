/**
 * holdfast_events notifications → Telegram messages, plus the periodic weight-milestone sweep.
 *
 * - round (closed): each watched wallet paid in the round gets its payout; coin followers get the totals.
 * - trade (side 'vault'): coin followers get the floor defence.
 * - coin (graduated): coin followers get the graduation.
 * - weight milestones: a watched wallet's position in a coin crossing 0.5x and 1.0x average weight.
 *
 * Every message goes through the Outbox with a stable event key, so the same event reaching us
 * twice (the payout worker and the indexer both announce a closed round; catch-up replays) or a
 * restart never sends it twice.
 */
import { fixedToSolPerToken, tradePrice, weightedAmount, type WeightedLot } from "@holdfast/core";
import {
  chatsWatchingCoin,
  chatsWatchingWallets,
  getCoin,
  getCoins,
  getRoundRow,
  getTradesBySig,
  getVaultState,
  HOLDFAST_EVENTS_CHANNEL,
  listPayouts,
  listWalletSubscriptions,
  openLotsByWallet,
  parseNotification,
  recentNotifierEvents,
  type Db,
  type HoldfastNotification,
  type Queryable,
  type Unlisten,
  type Watcher,
} from "@holdfast/db";

import type { Links } from "./format.js";
import { defendMessage, graduatedMessage, milestoneMessage, payoutMessage, roundSummaryMessage, type Milestone } from "./messages.js";
import type { Outbox } from "./outbox.js";

/** Events older than this are never announced (re-indexed history, very late replays). */
export const MAX_EVENT_AGE_MS = 24 * 3600_000;
/** An event that happened shortly before a chat subscribed still reaches it; older ones do not. */
export const SUBSCRIBE_GRACE_MS = 10 * 60_000;

export const MILESTONES: readonly { label: Milestone; ppm: bigint }[] = [
  { label: "0.5", ppm: 500_000n },
  { label: "1.0", ppm: 1_000_000n },
];

interface Logger {
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

export interface EventMetrics {
  event(kind: string): void;
  error(source: string): void;
}

export interface NotifierDeps {
  db: Queryable;
  outbox: Outbox;
  links: Links;
  now?: () => number;
  log?: Logger;
  metrics?: EventMetrics;
}

interface Outgoing {
  chatId: number;
  key: string;
  html: string;
}

/** Average weight of `lots` in parts per million (0 for an empty position). */
export function multiplierPpm(lots: readonly WeightedLot[], atMs: number): bigint {
  const total = lots.reduce((s, l) => s + l.amount, 0n);
  return total === 0n ? 0n : weightedAmount(lots, atMs) / total;
}

/**
 * Milestones the average weight of `lots` reached between `fromMs` and `toMs`, lowest first. Lots
 * bought after `fromMs` count at their starting weight (0.1x) then, so a dip caused by a new buy and
 * the climb back are seen as a crossing too. Exact integer comparison: Σ amount × weight ≥ Σ amount × milestone.
 */
export function crossedMilestones(lots: readonly WeightedLot[], fromMs: number, toMs: number): Milestone[] {
  const total = lots.reduce((s, l) => s + l.amount, 0n);
  if (total === 0n) return [];
  const before = weightedAmount(lots, fromMs);
  const after = weightedAmount(lots, toMs);
  return MILESTONES.filter((m) => after >= total * m.ppm && before < total * m.ppm).map((m) => m.label);
}

export class Notifier {
  private readonly now: () => number;

  constructor(private readonly deps: NotifierDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Handles one notification; returns the number of messages sent. Never throws (errors are logged). */
  async handle(n: HoldfastNotification): Promise<number> {
    this.deps.metrics?.event(n.kind);
    try {
      switch (n.kind) {
        case "round":
          return await this.roundChanged(n.mint, n.roundId);
        case "trade":
          return await this.tradeRecorded(n.mint, n.sig);
        case "coin":
          return await this.coinChanged(n.mint);
        default:
          return 0;
      }
    } catch (err) {
      this.deps.metrics?.error("event");
      this.deps.log?.error({ event: n, err: err instanceof Error ? err.message : String(err) }, "notification failed");
      return 0;
    }
  }

  /** Re-handles what happened since `sinceMs` (startup after downtime); already-sent messages are skipped. */
  async catchUp(sinceMs: number): Promise<number> {
    let sent = 0;
    for (const n of await recentNotifierEvents(this.deps.db, sinceMs)) sent += await this.handle(n);
    return sent;
  }

  private stale(atMs: number): boolean {
    return atMs < this.now() - MAX_EVENT_AGE_MS;
  }

  private static isNewFor(w: Watcher, atMs: number): boolean {
    return atMs >= w.createdAt - SUBSCRIBE_GRACE_MS;
  }

  private async send(out: readonly Outgoing[], kind: string): Promise<number> {
    let sent = 0;
    for (const o of out) if ((await this.deps.outbox.deliver(o.chatId, o.key, o.html, kind)) === "sent") sent++;
    return sent;
  }

  /** A closed round: payouts to watched wallets, totals to coin followers. Other statuses are ignored. */
  async roundChanged(mint: string, roundId: number): Promise<number> {
    const { db, links } = this.deps;
    const round = await getRoundRow(db, mint, roundId);
    if (!round || round.status !== "closed" || this.stale(round.ts)) return 0;
    const coin = await getCoin(db, mint);
    if (!coin) return 0;
    const byWallet = new Map<string, { sol: bigint; tokens: bigint; sig: string | null }>();
    for (const p of await listPayouts(db, mint, roundId)) {
      if (p.status !== "confirmed") continue;
      const e = byWallet.get(p.wallet) ?? { sol: 0n, tokens: 0n, sig: null };
      e.sol += p.sol;
      e.tokens += p.tokens;
      e.sig ??= p.sig;
      byWallet.set(p.wallet, e);
    }
    if (byWallet.size === 0) return 0;
    const id = round.roundId.toString();

    const payouts: Outgoing[] = [];
    for (const [wallet, watchers] of await chatsWatchingWallets(db, [...byWallet.keys()])) {
      const e = byWallet.get(wallet)!;
      const html = payoutMessage(links, { coin, roundId: round.roundId, wallet, sol: e.sol, tokens: e.tokens, sig: e.sig });
      for (const w of watchers) if (Notifier.isNewFor(w, round.ts)) payouts.push({ chatId: w.chatId, key: `round:${mint}:${id}:${wallet}`, html });
    }
    let sent = await this.send(payouts, "payout");

    const followers = (await chatsWatchingCoin(db, mint)).filter((w) => Notifier.isNewFor(w, round.ts));
    if (followers.length > 0) {
      let sol = 0n;
      let tokens = 0n;
      for (const e of byWallet.values()) {
        sol += e.sol;
        tokens += e.tokens;
      }
      const html = roundSummaryMessage(links, { coin, roundId: round.roundId, sol, tokens, holders: byWallet.size, closeSig: round.closeSig });
      sent += await this.send(
        followers.map((w) => ({ chatId: w.chatId, key: `round:${mint}:${id}:coin`, html })),
        "round",
      );
    }
    return sent;
  }

  /** Trades of `sig`: a vault buyback (side 'vault') is a floor defence. */
  async tradeRecorded(mint: string, sig: string): Promise<number> {
    const { db, links } = this.deps;
    const trades = (await getTradesBySig(db, sig)).filter((t) => t.mint === mint && t.side === "vault");
    const first = trades[0];
    if (!first || this.stale(first.ts)) return 0;
    const followers = (await chatsWatchingCoin(db, mint)).filter((w) => Notifier.isNewFor(w, first.ts));
    if (followers.length === 0) return 0;
    const coin = await getCoin(db, mint);
    if (!coin) return 0;
    const sol = trades.reduce((s, t) => s + t.sol, 0n);
    const tokens = trades.reduce((s, t) => s + t.tokens, 0n);
    const vault = await getVaultState(db, mint);
    const floorPrice = vault && vault.floor > 0n ? fixedToSolPerToken(vault.floor, coin.decimals) : null;
    const html = defendMessage(links, { coin, sol, price: tradePrice(sol, tokens, coin.decimals), floorPrice, sig });
    return this.send(
      followers.map((w) => ({ chatId: w.chatId, key: `defend:${mint}:${sig}`, html })),
      "defend",
    );
  }

  /** Coin rows change for many reasons; only the graduation is announced. */
  async coinChanged(mint: string): Promise<number> {
    const { db, links } = this.deps;
    const followers = await chatsWatchingCoin(db, mint);
    if (followers.length === 0) return 0;
    const coin = await getCoin(db, mint);
    if (!coin?.graduated) return 0;
    const at = coin.graduatedAt ?? this.now();
    if (this.stale(at)) return 0;
    const html = graduatedMessage(links, coin);
    return this.send(
      followers.filter((w) => Notifier.isNewFor(w, at)).map((w) => ({ chatId: w.chatId, key: `graduated:${mint}`, html })),
      "graduated",
    );
  }

  /**
   * Weight milestones of every watched wallet's open lots, measured since the chat started watching.
   * The key is anchored on the position's oldest open lot: a milestone is announced once per
   * position, and again only after the wallet sold out and bought back in.
   */
  async checkMilestones(): Promise<number> {
    const { db, links, outbox } = this.deps;
    const now = this.now();
    try {
      const subs = await listWalletSubscriptions(db);
      if (subs.length === 0) return 0;
      const lots = await openLotsByWallet(db, subs.map((s) => s.target));
      const mints = new Set<string>();
      for (const positions of lots.values()) for (const mint of positions.keys()) mints.add(mint);
      const coins = await getCoins(db, [...mints]);

      const out: Outgoing[] = [];
      for (const sub of subs) {
        for (const [mint, position] of lots.get(sub.target) ?? []) {
          const coin = coins.get(mint);
          const oldest = position[0];
          if (!coin || !oldest) continue;
          const crossed = crossedMilestones(position, Math.min(sub.createdAt, now), now);
          const top = crossed[crossed.length - 1];
          if (!top) continue;
          const key = (m: Milestone) => `weight:${sub.target}:${mint}:${m}:${BigInt(oldest.id).toString()}`;
          // A lower milestone crossed since the last sweep is claimed silently: it must never arrive after the higher one.
          for (const m of crossed.slice(0, -1)) await outbox.claim(sub.chatId, key(m));
          out.push({ chatId: sub.chatId, key: key(top), html: milestoneMessage(links, { coin, wallet: sub.target, milestone: top, multiplierPpm: multiplierPpm(position, now) }) });
        }
      }
      return await this.send(out, "milestone");
    } catch (err) {
      this.deps.metrics?.error("milestones");
      this.deps.log?.error({ err: err instanceof Error ? err.message : String(err) }, "weight milestone sweep failed");
      return 0;
    }
  }
}

/** LISTEN holdfast_events (the same subscription as the API's pgEventSource). */
export function listenForEvents(db: Pick<Db, "listen">, handler: (n: HoldfastNotification) => void): Promise<Unlisten> {
  return db.listen(HOLDFAST_EVENTS_CHANNEL, (payload) => {
    const n = parseNotification(payload);
    if (n) handler(n);
  });
}
