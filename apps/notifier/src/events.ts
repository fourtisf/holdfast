/**
 * holdfast_events notifications → Telegram messages, plus the periodic weight-milestone sweep.
 *
 * - round (closed): each watched wallet paid in the round gets its payout; coin followers get the totals.
 * - trade (side 'vault'): coin followers get the floor defence.
 * - coin (graduated): coin followers get the graduation.
 * - weight milestones: a watched wallet's position in a coin crossing 0.5x and 1.0x average weight.
 * - trade (side 'buy'): groups with the buy bot on for the coin get the buy (throttled per group, at most 2 minutes old).
 * - launch: the chat that started a launch from the bot hears about its progress (paid, live, refunded).
 * - burn: the burn channel (NOTIFIER_BURN_CHAT_ID) gets every $MOATPAD buy & burn.
 *
 * Every message goes through the Outbox with a stable event key, so the same event reaching us
 * twice (the payout worker and the indexer both announce a closed round; catch-up replays) or a
 * restart never sends it twice.
 */
import { fixedToSolPerToken, marketCapSol, tradePrice, weightedAmount, type WeightedLot } from "@holdfast/core";
import {
  buybotsForMint,
  chatForLaunch,
  chatsWatchingCoin,
  getHoldBurn,
  getLaunch,
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
  type CoinRow,
  type Db,
  type HoldfastNotification,
  type ListenOptions,
  type Queryable,
  type TradeRow,
  type Unlisten,
  type Watcher,
} from "@holdfast/db";

import {
  burnAlert,
  buyAlert,
  defendMessage,
  graduatedMessage,
  launchStatusMessage,
  milestoneMessage,
  payoutMessage,
  roundSummaryMessage,
  type BotLinks,
  type Milestone,
} from "./messages.js";
import type { Outbox } from "./outbox.js";
import type { Keyboard } from "./telegram.js";

/** Telegram allows a bot about 20 messages a minute in one group: buy alerts stay under that. */
export const BUY_ALERTS_PER_MINUTE = 15;

/** Sliding one-minute window per group; buys over the limit are counted and mentioned in the next alert. */
export class BuyThrottle {
  private readonly sent = new Map<number, number[]>();
  private readonly skipped = new Map<number, number>();

  constructor(private readonly perMinute = BUY_ALERTS_PER_MINUTE) {}

  /** Null when this buy is dropped; otherwise how many were dropped since the last alert. */
  take(chatId: number, now: number): number | null {
    const recent = (this.sent.get(chatId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.perMinute) {
      this.sent.set(chatId, recent);
      this.skipped.set(chatId, (this.skipped.get(chatId) ?? 0) + 1);
      return null;
    }
    recent.push(now);
    this.sent.set(chatId, recent);
    const skipped = this.skipped.get(chatId) ?? 0;
    this.skipped.delete(chatId);
    return skipped;
  }
}

/** Events older than this are never announced (re-indexed history, very late replays). */
export const MAX_EVENT_AGE_MS = 24 * 3600_000;
/** Buy alerts are live news: older buys (an indexer backfill, a late replay) are not posted, and do not use up a group's throttle. */
export const MAX_BUY_ALERT_AGE_MS = 2 * 60_000;
/**
 * A live event that happened shortly before a chat subscribed still reaches it (block time and indexing
 * lag); older ones do not. Replays (catch-up) use no grace: the event was likely handled live before the
 * chat subscribed, so it goes only to chats that were subscribed when it happened.
 */
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
  links: BotLinks;
  /** Channel or group that gets every $MOATPAD burn; null = none. */
  burnChatId?: number | null;
  now?: () => number;
  log?: Logger;
  metrics?: EventMetrics;
}

interface Outgoing {
  chatId: number;
  key: string;
  html: string;
  buttons?: Keyboard;
  /** The key was claimed already (by this handler). */
  claimed?: boolean;
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

/**
 * The coin's market cap right after a buy: its spot price (as on the coin page) while no later trade has moved
 * it; otherwise (a burst of buys, a replayed one) the buy's own price, which is closer than the price now.
 */
export function buyMarketCapSol(coin: Pick<CoinRow, "lastPrice" | "lastTradeAt">, t: Pick<TradeRow, "price" | "ts">): number {
  const spot = coin.lastPrice ?? 0;
  const afterThisBuy = spot > 0 && (coin.lastTradeAt === null || coin.lastTradeAt <= t.ts);
  return marketCapSol(afterThisBuy ? spot : t.price);
}

export class Notifier {
  private readonly now: () => number;
  private readonly throttle = new BuyThrottle();

  constructor(private readonly deps: NotifierDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Handles one notification (`replay`: from catch-up); returns the number of messages sent. Never throws (errors are logged). */
  async handle(n: HoldfastNotification, opts: { replay?: boolean } = {}): Promise<number> {
    this.deps.metrics?.event(n.kind);
    const grace = opts.replay ? 0 : SUBSCRIBE_GRACE_MS;
    try {
      switch (n.kind) {
        case "round":
          return await this.roundChanged(n.mint, n.roundId, grace);
        case "trade":
          return await this.tradeRecorded(n.mint, n.sig, grace);
        case "coin":
          return await this.coinChanged(n.mint, grace);
        case "launch":
          return await this.launchChanged(n.launchId);
        case "burn":
          return await this.burned(n.mint, n.sig);
        default:
          return 0;
      }
    } catch (err) {
      this.deps.metrics?.error("event");
      this.deps.log?.error({ event: n, err: err instanceof Error ? err.message : String(err) }, "notification failed");
      return 0;
    }
  }

  /**
   * Re-handles what happened since `sinceMs` (startup after downtime, a dropped LISTEN connection);
   * already-sent messages are skipped. Buys count from MAX_BUY_ALERT_AGE_MS ago at most.
   */
  async catchUp(sinceMs: number): Promise<number> {
    let sent = 0;
    const missed = await recentNotifierEvents(this.deps.db, sinceMs, { buysSinceMs: this.now() - MAX_BUY_ALERT_AGE_MS });
    for (const n of missed) sent += await this.handle(n, { replay: true });
    return sent;
  }

  private stale(atMs: number): boolean {
    return atMs < this.now() - MAX_EVENT_AGE_MS;
  }

  private static isNewFor(w: Watcher, atMs: number, grace: number): boolean {
    return atMs >= w.createdAt - grace;
  }

  private async send(out: readonly Outgoing[], kind: string): Promise<number> {
    let sent = 0;
    for (const o of out) if ((await this.deps.outbox.deliver(o.chatId, o.key, o.html, kind, o.buttons, { claimed: o.claimed })) === "sent") sent++;
    return sent;
  }

  /** A closed round: payouts to watched wallets, totals to coin followers. Other statuses are ignored. */
  async roundChanged(mint: string, roundId: number, grace = SUBSCRIBE_GRACE_MS): Promise<number> {
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
      for (const w of watchers) if (Notifier.isNewFor(w, round.ts, grace)) payouts.push({ chatId: w.chatId, key: `round:${mint}:${id}:${wallet}`, html });
    }
    let sent = await this.send(payouts, "payout");

    const followers = (await chatsWatchingCoin(db, mint)).filter((w) => Notifier.isNewFor(w, round.ts, grace));
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

  /** Trades of `sig`: a vault buyback (side 'vault') is a floor defence; buys go to the coin's buy bot groups. */
  async tradeRecorded(mint: string, sig: string, grace = SUBSCRIBE_GRACE_MS): Promise<number> {
    const { db, links, outbox } = this.deps;
    const all = (await getTradesBySig(db, sig)).filter((t) => t.mint === mint);
    const first = all[0];
    if (!first || this.stale(first.ts)) return 0;
    const followers = (await chatsWatchingCoin(db, mint)).filter((w) => Notifier.isNewFor(w, first.ts, grace));
    const groups = await buybotsForMint(db, mint);
    if (followers.length === 0 && groups.length === 0) return 0;
    const coin = await getCoin(db, mint);
    if (!coin) return 0;
    const vault = await getVaultState(db, mint);
    let sent = 0;

    const defends = all.filter((t) => t.side === "vault");
    if (defends.length > 0) {
      const sol = defends.reduce((s, t) => s + t.sol, 0n);
      const tokens = defends.reduce((s, t) => s + t.tokens, 0n);
      const floorPrice = vault && vault.floor > 0n ? fixedToSolPerToken(vault.floor, coin.decimals) : null;
      const html = defendMessage(links, { coin, sol, price: tradePrice(sol, tokens, coin.decimals), floorPrice, sig });
      const chats = new Set([...followers.map((w) => w.chatId), ...groups.filter((g) => g.createdAt <= first.ts + grace).map((g) => g.chatId)]);
      sent += await this.send(
        [...chats].map((chatId) => ({ chatId, key: `defend:${mint}:${sig}`, html })),
        "defend",
      );
    }

    for (const t of all.filter((x) => x.side === "buy" && x.ts >= this.now() - MAX_BUY_ALERT_AGE_MS)) {
      const targets = groups.filter((g) => t.sol >= g.minLamports && Notifier.isNewFor({ chatId: g.chatId, createdAt: g.createdAt }, t.ts, grace));
      for (const g of targets) {
        const key = `buy:${sig}:${t.ixIndex}`;
        // Claimed before the throttle: a buy handled already (a repeated NOTIFY, a catch-up replay) takes no slot.
        if (!(await outbox.claim(g.chatId, key, "buy"))) continue;
        const skipped = this.throttle.take(g.chatId, this.now());
        // A dropped buy keeps its claim: the next alert counts it, so a replay must not post it as well.
        if (skipped === null) continue;
        const alert = buyAlert(links, {
          coin,
          sol: Number(t.sol) / 1e9,
          tokens: t.tokens,
          wallet: t.wallet,
          sig,
          marketCapSol: buyMarketCapSol(coin, t),
          floorSol: vault ? Number(vault.floorSol) / 1e9 : null,
          skipped,
        });
        sent += await this.send([{ chatId: g.chatId, key, html: alert.html, buttons: alert.buttons, claimed: true }], "buy");
      }
    }
    return sent;
  }

  /** A launch started from the bot changed status: tell the chat that started it. */
  async launchChanged(launchId: string): Promise<number> {
    const { db, links } = this.deps;
    const chatId = await chatForLaunch(db, launchId);
    if (chatId === null) return 0;
    const l = await getLaunch(db, launchId);
    if (!l) return 0;
    const msg = launchStatusMessage(links, {
      status: l.status,
      ticker: l.form.ticker,
      mint: l.mint,
      receivedSol: Number(l.receivedLamports) / 1e9,
      refundSig: l.refundSig,
      error: l.error,
    });
    if (!msg) return 0;
    // The launcher moves on to "creating" milliseconds after the deposit arrives: by the time the deposit's
    // notification is handled the row usually says "creating". Both are the one "payment received" message.
    const stage = l.status === "creating" ? "deposit_received" : l.status;
    return this.send([{ chatId, key: `launch:${launchId}:${stage}`, html: msg.html, buttons: msg.buttons }], "launch");
  }

  /** A vault bought and burned $MOATPAD: post it to the burn channel. */
  async burned(mint: string, sig: string): Promise<number> {
    const { db, links, burnChatId } = this.deps;
    if (burnChatId === undefined || burnChatId === null) return 0;
    const burn = await getHoldBurn(db, sig, mint);
    if (!burn || this.stale(burn.ts)) return 0;
    const coin = await getCoin(db, mint);
    const html = burnAlert(links, { ticker: coin?.ticker ?? null, mint, tokensBurned: Number(burn.holdBurned) / 1e6, solSpent: Number(burn.solSpent) / 1e9, sig });
    return this.send([{ chatId: burnChatId, key: `burn:${sig}:${mint}`, html }], "burn");
  }

  /** Coin rows change for many reasons; only the graduation is announced. */
  async coinChanged(mint: string, grace = SUBSCRIBE_GRACE_MS): Promise<number> {
    const { db, links } = this.deps;
    const followers = await chatsWatchingCoin(db, mint);
    if (followers.length === 0) return 0;
    const coin = await getCoin(db, mint);
    if (!coin?.graduated) return 0;
    const at = coin.graduatedAt ?? this.now();
    if (this.stale(at)) return 0;
    const html = graduatedMessage(links, coin);
    return this.send(
      followers.filter((w) => Notifier.isNewFor(w, at, grace)).map((w) => ({ chatId: w.chatId, key: `graduated:${mint}`, html })),
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

/**
 * LISTEN holdfast_events (the same subscription as the API's pgEventSource). Notifications sent while the
 * connection was down are lost: `onReconnect` runs once it is back, to catch up on them.
 */
export function listenForEvents(db: Pick<Db, "listen">, handler: (n: HoldfastNotification) => void, opts: ListenOptions = {}): Promise<Unlisten> {
  return db.listen(
    HOLDFAST_EVENTS_CHANNEL,
    (payload) => {
      const n = parseNotification(payload);
      if (n) handler(n);
    },
    opts,
  );
}
