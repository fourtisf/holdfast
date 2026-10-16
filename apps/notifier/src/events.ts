/**
 * holdfast_events notifications → Telegram messages, plus the periodic weight-milestone sweep.
 *
 * - round (closed): each watched wallet paid in the round gets its payout; coin followers get the totals.
 * - trade (side 'vault'): coin followers get the floor defence.
 * - coin (graduated): coin followers get the graduation.
 * - weight milestones: a watched wallet's position in a coin crossing 0.5x and 1.0x average weight.
 * - trade (side 'buy'): groups with the buy bot on for the coin get the buy (one alert per buying wallet and
 *   transaction, throttled per group, at most 2 minutes old).
 * - launch: the chat that started a launch from the bot hears about its progress (paid, live, refunded).
 * - burn: the burn channel (NOTIFIER_BURN_CHAT_ID) gets every $MOATPAD buy & burn.
 *
 * Every message goes through the Outbox with a stable event key, so the same event reaching us
 * twice (the payout worker and the indexer both announce a closed round; catch-up replays) or a
 * restart never sends it twice. A delivery that failed in a way a later attempt may fix is retried by
 * handling its event again for just that chat and key (`retryFailed`). In a forum supergroup each alert goes
 * to the topic it was set up in (/buybot, /follow, /watch).
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
  sentKeys,
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
import { deliveryId, type DeliveryResult, type Outbox } from "./outbox.js";
import type { Keyboard } from "./telegram.js";

/** Telegram allows a bot about 20 messages a minute in one group: buy alerts (with the floor defences posted there) stay under that. */
export const BUY_ALERTS_PER_MINUTE = 15;

/** Sliding one-minute window per group; buys over the limit are counted and mentioned in the next alert. */
export class BuyThrottle {
  private readonly sent = new Map<number, number[]>();
  private readonly skipped = new Map<number, number>();

  constructor(private readonly perMinute = BUY_ALERTS_PER_MINUTE) {}

  private recent(chatId: number, now: number): number[] {
    const recent = (this.sent.get(chatId) ?? []).filter((t) => now - t < 60_000);
    this.sent.set(chatId, recent);
    return recent;
  }

  /** Null when this buy is dropped; otherwise how many were dropped since the last alert. */
  take(chatId: number, now: number): number | null {
    const recent = this.recent(chatId, now);
    if (recent.length >= this.perMinute) {
      this.missed(chatId, 1);
      return null;
    }
    recent.push(now);
    const skipped = this.skipped.get(chatId) ?? 0;
    this.skipped.delete(chatId);
    return skipped;
  }

  /** `n` buys that were not posted after all (the group is in a Telegram flood wait): the next alert counts them. */
  missed(chatId: number, n: number): void {
    this.skipped.set(chatId, (this.skipped.get(chatId) ?? 0) + n);
  }

  /** Another message posted in the group (a floor defence) uses up a slot too: Telegram's limit counts every message. */
  record(chatId: number, now: number): void {
    this.recent(chatId, now).push(now);
  }
}

/** Events older than this are never announced (re-indexed history, very late replays). */
export const MAX_EVENT_AGE_MS = 24 * 3600_000;
/** Failed deliveries retried in one run at most (the rest wait for the next run): a run must not hold up the event queue for long. */
export const RETRY_BATCH = 50;
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

/** How an event is handled: live, replayed (catch-up), or retried for some of its deliveries. */
interface Scope {
  /** An event this long before a chat subscribed still reaches it (SUBSCRIBE_GRACE_MS live, 0 replayed). */
  grace: number;
  /** The event: a delivery that fails in a way a later attempt may fix is retried with it. */
  event: HoldfastNotification;
  /** A retry: only this delivery (`deliveryId`) is made. */
  only?: string;
}

interface Outgoing {
  chatId: number;
  key: string;
  html: string;
  buttons?: Keyboard;
  /** The key was claimed already (by this handler). */
  claimed?: boolean;
  /** Forum topic to post in (where the buy bot or the subscription was set up). */
  threadId?: number | null;
}

/** One wallet's buys in one transaction: a split buy is one alert, at the price of its last part. */
interface WalletBuy {
  wallet: string;
  sol: bigint;
  tokens: bigint;
  last: TradeRow;
  /** Instruction indexes of its rows. */
  ixIndexes: number[];
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
 * The coin's market cap right after a buy: its spot price (as on the coin page) when that price is from this
 * buy's slot and nothing later in the same transaction moved it; otherwise (a burst of buys, a buy and a sell
 * in one transaction, a replayed buy) the buy's own price, which is closer than the price now. Block times
 * are whole seconds, so only the slot tells trades of the same second apart (two transactions of one slot
 * stay ambiguous).
 */
export function buyMarketCapSol(coin: Pick<CoinRow, "lastPrice" | "lastTradeSlot">, t: Pick<TradeRow, "price" | "slot">, laterInTx = false): number {
  const spot = coin.lastPrice ?? 0;
  const afterThisBuy = spot > 0 && coin.lastTradeSlot === t.slot && !laterInTx;
  return marketCapSol(afterThisBuy ? spot : t.price);
}

/**
 * The buys of one transaction, by wallet: rows of the same wallet are summed (a buy split into several
 * instructions is one buy). A wallet that also sold the coin in that transaction is left out: a buy that is
 * sold back at once (volume or bump bots) is not news.
 */
export function walletBuys(trades: readonly TradeRow[]): WalletBuy[] {
  const sellers = new Set(trades.filter((t) => t.side === "sell").map((t) => t.wallet));
  const byWallet = new Map<string, WalletBuy>();
  for (const t of trades) {
    if (t.side !== "buy" || sellers.has(t.wallet)) continue;
    const b = byWallet.get(t.wallet);
    if (!b) byWallet.set(t.wallet, { wallet: t.wallet, sol: t.sol, tokens: t.tokens, last: t, ixIndexes: [t.ixIndex] });
    else {
      b.sol += t.sol;
      b.tokens += t.tokens;
      b.ixIndexes.push(t.ixIndex);
      if (t.ixIndex > b.last.ixIndex) b.last = t;
    }
  }
  return [...byWallet.values()];
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
    return (await this.run({ grace: opts.replay ? 0 : SUBSCRIBE_GRACE_MS, event: n })) ?? 0;
  }

  /** The messages sent for `scope.event`; null when handling it failed (logged). */
  private async run(scope: Scope): Promise<number | null> {
    const n = scope.event;
    try {
      switch (n.kind) {
        case "round":
          return await this.roundChanged(n.mint, n.roundId, scope);
        case "trade":
          return await this.tradeRecorded(n.mint, n.sig, scope);
        case "coin":
          return await this.coinChanged(n.mint, scope);
        case "launch":
          return await this.launchChanged(n.launchId, scope);
        case "burn":
          return await this.burned(n.mint, n.sig, scope);
        default:
          return 0;
      }
    } catch (err) {
      this.deps.metrics?.error("event");
      this.deps.log?.error({ event: n, err: err instanceof Error ? err.message : String(err) }, "notification failed");
      return null;
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

  private static isNewFor(w: Pick<Watcher, "createdAt">, atMs: number, grace: number): boolean {
    return atMs >= w.createdAt - grace;
  }

  /** Whether `scope` makes this delivery: always, except in a retry that is not for it. */
  private static due(scope: Scope, chatId: number, key: string): boolean {
    return scope.only === undefined || scope.only === deliveryId(chatId, key);
  }

  /** One message (null: not attempted, as a retry is not for it). */
  private async deliver(scope: Scope, o: Outgoing, kind: string): Promise<DeliveryResult | null> {
    if (!Notifier.due(scope, o.chatId, o.key)) return null;
    return this.deps.outbox.deliver(o.chatId, o.key, o.html, kind, o.buttons, { claimed: o.claimed, threadId: o.threadId, event: scope.event });
  }

  private async send(scope: Scope, out: readonly Outgoing[], kind: string): Promise<number> {
    let sent = 0;
    for (const o of out) if ((await this.deliver(scope, o, kind)) === "sent") sent++;
    return sent;
  }

  /**
   * Run once a minute: makes the deliveries that failed in a way a later attempt may fix again, and only those
   * (the event of each is handled again for just that chat and key; claims skip what did arrive meanwhile).
   * At most RETRY_BATCH per run, the least recently failed first; a chat still in a flood wait waits for a later
   * run. A delivery that fails again ends the run (and goes last): Telegram, or that chat, still takes nothing,
   * and the next events must not wait behind more of them. A send that got no answer after it went out ends it too
   * (it is given up, as it may have been posted): Telegram is slow, and each more would wait out a timeout. So does
   * a delivery whose event cannot be handled again (the database, or data that changed since): going last, it never
   * keeps the others from being retried. Given up after MAX_EVENT_AGE_MS. Returns the messages sent.
   */
  async retryFailed(): Promise<number> {
    const { outbox } = this.deps;
    let sent = 0;
    for (const f of outbox.retryDue(RETRY_BATCH)) {
      if (f.since < this.now() - MAX_EVENT_AGE_MS) {
        outbox.retried(f);
        continue;
      }
      const unanswered = outbox.unanswered;
      const n = await this.run({ grace: SUBSCRIBE_GRACE_MS, event: f.event, only: deliveryId(f.chatId, f.eventKey) });
      // Handling the event failed (logged): it goes last, and the rest wait for the next run.
      if (n === null) {
        outbox.postpone(f);
        break;
      }
      sent += n;
      if (outbox.retried(f) || outbox.unanswered !== unanswered) break;
    }
    return sent;
  }

  /** A closed round: payouts to watched wallets, totals to coin followers. Other statuses are ignored. */
  private async roundChanged(mint: string, roundId: number, scope: Scope): Promise<number> {
    const { grace } = scope;
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
      for (const w of watchers) if (Notifier.isNewFor(w, round.ts, grace)) payouts.push({ chatId: w.chatId, key: `round:${mint}:${id}:${wallet}`, html, threadId: w.threadId });
    }
    let sent = await this.send(scope, payouts, "payout");

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
        scope,
        followers.map((w) => ({ chatId: w.chatId, key: `round:${mint}:${id}:coin`, html, threadId: w.threadId })),
        "round",
      );
    }
    return sent;
  }

  /** Trades of `sig`: a vault buyback (side 'vault') is a floor defence; buys go to the coin's buy bot groups. */
  private async tradeRecorded(mint: string, sig: string, scope: Scope): Promise<number> {
    const { grace } = scope;
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
    const buybotChats = new Set(groups.map((g) => g.chatId));
    let sent = 0;

    const defends = all.filter((t) => t.side === "vault");
    if (defends.length > 0) {
      const sol = defends.reduce((s, t) => s + t.sol, 0n);
      const tokens = defends.reduce((s, t) => s + t.tokens, 0n);
      const floorPrice = vault && vault.floor > 0n ? fixedToSolPerToken(vault.floor, coin.decimals) : null;
      const html = defendMessage(links, { coin, sol, price: tradePrice(sol, tokens, coin.decimals), floorPrice, sig });
      // Once per chat: in the buy bot's topic when the chat has a buy bot (next to its buys), else where it followed the coin.
      const chats = new Map(followers.map((w) => [w.chatId, w.threadId]));
      for (const g of groups) if (chats.has(g.chatId) || g.createdAt <= first.ts + grace) chats.set(g.chatId, g.threadId);
      for (const [chatId, threadId] of chats) {
        const result = await this.deliver(scope, { chatId, key: `defend:${mint}:${sig}`, html, threadId }, "defend");
        if (result !== "sent") continue;
        sent++;
        // A buy bot group's budget counts the defence too, so the group stays under Telegram's limit.
        if (buybotChats.has(chatId)) this.throttle.record(chatId, this.now());
      }
    }

    if (first.ts < this.now() - MAX_BUY_ALERT_AGE_MS) return sent;
    for (const b of walletBuys(all)) {
      const targets = groups.filter((g) => b.sol >= g.minLamports && Notifier.isNewFor(g, first.ts, grace));
      const laterInTx = all.some((x) => x.ixIndex > b.last.ixIndex);
      for (const g of targets) {
        const key = `buy:${sig}:${b.wallet}`;
        if (!Notifier.due(scope, g.chatId, key)) continue;
        // Claimed before the throttle: a buy handled already (a repeated NOTIFY, a catch-up replay) takes no slot. So is
        // one posted by an older version, under its key per instruction (`buy:<sig>:<ixIndex>`), before a restart.
        if (!(await outbox.claim(g.chatId, key, "buy", b.ixIndexes.map((ix) => `buy:${sig}:${ix}`)))) continue;
        const skipped = this.throttle.take(g.chatId, this.now());
        // A dropped buy keeps its claim: the next alert counts it, so a replay must not post it as well.
        if (skipped === null) continue;
        const alert = buyAlert(links, {
          coin,
          sol: Number(b.sol) / 1e9,
          tokens: b.tokens,
          wallet: b.wallet,
          sig,
          marketCapSol: buyMarketCapSol(coin, b.last, laterInTx),
          floorSol: vault ? Number(vault.floorSol) / 1e9 : null,
          skipped,
        });
        const result = await this.deliver(scope, { chatId: g.chatId, key, html: alert.html, buttons: alert.buttons, claimed: true, threadId: g.threadId }, "buy");
        if (result === "sent") sent++;
        else if (result === "flooded") {
          // Live news: a buy the group cannot get now is counted in its next alert rather than posted late.
          await outbox.claim(g.chatId, key);
          this.throttle.missed(g.chatId, skipped + 1);
        }
      }
    }
    return sent;
  }

  /** A launch started from the bot changed status: tell the chat that started it. */
  private async launchChanged(launchId: string, scope: Scope): Promise<number> {
    const { db, links } = this.deps;
    const chatId = await chatForLaunch(db, launchId);
    if (chatId === null) return 0;
    const l = await getLaunch(db, launchId);
    if (!l) return 0;
    const msg = launchStatusMessage(
      links,
      {
        id: l.id,
        status: l.status,
        ticker: l.form.ticker,
        mint: l.mint,
        depositAddress: l.depositAddress,
        requiredLamports: l.requiredLamports,
        receivedLamports: l.receivedLamports,
        expiresAt: l.expiresAt,
        refundSig: l.refundSig,
        error: l.error,
      },
      this.now(),
    );
    if (!msg) return 0;
    // The launcher moves on to "creating" milliseconds after the deposit arrives: by the time the deposit's
    // notification is handled the row usually says "creating". Both are the one "payment received" message.
    // Still awaiting the deposit: part of it arrived (one message per amount received).
    const stage = l.status === "creating" ? "deposit_received" : l.status === "awaiting_deposit" ? `underpaid:${l.receivedLamports}` : l.status;
    return this.send(scope, [{ chatId, key: `launch:${launchId}:${stage}`, html: msg.html, buttons: msg.buttons }], "launch");
  }

  /** A vault bought and burned $MOATPAD: post it to the burn channel. */
  private async burned(mint: string, sig: string, scope: Scope): Promise<number> {
    const { db, links, burnChatId } = this.deps;
    if (burnChatId === undefined || burnChatId === null) return 0;
    const burn = await getHoldBurn(db, sig, mint);
    if (!burn || this.stale(burn.ts)) return 0;
    const coin = await getCoin(db, mint);
    const html = burnAlert(links, { ticker: coin?.ticker ?? null, mint, tokensBurned: Number(burn.holdBurned) / 1e6, solSpent: Number(burn.solSpent) / 1e9, sig });
    const result = await this.deliver(scope, { chatId: burnChatId, key: `burn:${sig}:${mint}`, html }, "burn");
    // The burn feed is the operator's: a refusal there is a setup problem (wrong NOTIFIER_BURN_CHAT_ID, bot not an admin).
    if (result === "unavailable" || result === "failed" || result === "topic_closed" || result === "no_rights") {
      this.deps.log?.error({ burnChatId, sig, mint, result }, "a $MOATPAD burn could not be posted to the burn chat");
    }
    return result === "sent" ? 1 : 0;
  }

  /** Coin rows change for many reasons; only the graduation is announced. */
  private async coinChanged(mint: string, scope: Scope): Promise<number> {
    const { grace } = scope;
    const { db, links } = this.deps;
    const followers = await chatsWatchingCoin(db, mint);
    if (followers.length === 0) return 0;
    const coin = await getCoin(db, mint);
    if (!coin?.graduated) return 0;
    const at = coin.graduatedAt ?? this.now();
    if (this.stale(at)) return 0;
    const html = graduatedMessage(links, coin);
    return this.send(
      scope,
      followers.filter((w) => Notifier.isNewFor(w, at, grace)).map((w) => ({ chatId: w.chatId, key: `graduated:${mint}`, html, threadId: w.threadId })),
      "graduated",
    );
  }

  /**
   * Weight milestones of every watched wallet's open lots, measured since the chat started watching.
   * A milestone is claimed for every open lot of the position (`weight:<wallet>:<mint>:<m>:<lot>`), and it
   * counts as announced while any open lot holds its claim: a sell that uses up the oldest lot (FIFO) keeps
   * it announced, and only a sell-out and a new buy (all new lots) start the position over.
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

      let sent = 0;
      for (const sub of subs) {
        for (const [mint, position] of lots.get(sub.target) ?? []) {
          const coin = coins.get(mint);
          const oldest = position[0];
          if (!coin || !oldest) continue;
          const lotIds = position.map((l) => BigInt(l.id).toString());
          const key = (m: Milestone, lotId: string) => `weight:${sub.target}:${mint}:${m}:${lotId}`;
          const claimed = await sentKeys(db, sub.chatId, MILESTONES.flatMap((m) => lotIds.map((id) => key(m.label, id))));
          const announced = MILESTONES.filter((m) => lotIds.some((id) => claimed.has(key(m.label, id)))).map((m) => m.label);
          const highest = MILESTONES.findIndex((m) => m.label === announced[announced.length - 1]);
          /** Claims `m` for every open lot (silently): the claim follows the lots. */
          const claimAll = async (m: Milestone) => {
            for (const id of lotIds) if (!claimed.has(key(m, id))) await outbox.claim(sub.chatId, key(m, id));
          };
          // What is announced (and everything below it) is never announced again.
          for (const m of MILESTONES.slice(0, highest + 1)) await claimAll(m.label);
          const crossed = crossedMilestones(position, Math.min(sub.createdAt, now), now).filter((m) => MILESTONES.findIndex((x) => x.label === m) > highest);
          const top = crossed[crossed.length - 1];
          if (!top) continue;
          // A lower milestone crossed since the last sweep is claimed silently: it must never arrive after the higher one.
          for (const m of crossed.slice(0, -1)) await claimAll(m);
          const html = milestoneMessage(links, { coin, wallet: sub.target, milestone: top, multiplierPpm: multiplierPpm(position, now) });
          // No event: a failed milestone is not retried with one, the next sweep finds it again.
          const result = await outbox.deliver(sub.chatId, key(top, lotIds[0]!), html, "milestone", undefined, { threadId: sub.threadId });
          if (result !== "sent") continue;
          sent++;
          await claimAll(top);
        }
      }
      return sent;
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
