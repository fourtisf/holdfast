import { PublicKey } from "@solana/web3.js";
import { classifyMovements, fixedToSolPerToken, tradePrice, type OwnerMovement, type ReductionOrder, type TriggerBps } from "@holdfast/core";
import {
  ammSpotAfter,
  canonicalPoolPda,
  creatorChangeEvents,
  type CreatorChangeEvent,
  curveSpotAfter,
  parsePumpEvents,
  postCompleteSpotAfter,
  pumpPoolAuthorityPda,
  TOKEN_2022_PROGRAM_ID,
  tradeAmounts,
  type CurveCreateEvent,
  type DecodedPumpEvent,
  type HoldfastEvent,
} from "@holdfast/chain";
import {
  addExcluded,
  applyVaultDelta,
  ensureVaultState,
  filterExcluded,
  findCoinsByVenue,
  getCoin,
  getCoins,
  getTokenAccounts,
  insertCoin,
  insertDefend,
  insertFloorPoint,
  insertTrade,
  isProcessed,
  loadLedger,
  markGraduated,
  markProcessed,
  saveLedger,
  setLaunchSig,
  updateCoinMetadata,
  updateCurveReserves,
  updateLastPrice,
  updateRoundStatus,
  upsertCandles,
  upsertTokenAccount,
  upsertVaultState,
  type CoinRow,
  type Db,
  type ExcludedWallet,
  type HoldfastNotification,
  type Queryable,
  type TradeSource,
  type VaultDelta,
  type VaultSnapshotInput,
} from "@holdfast/db";
import { invokedInstructions, tokenMints, type ParsedTx } from "./tx.js";
import { accountChanges, planAccounts, planLedger } from "./ledger.js";
import type { Publisher } from "./publisher.js";

export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ProcessDeps {
  db: Db;
  log: Logger;
  /** Holdfast vault program id (base58): its logs are only decoded when it was invoked. */
  holdfastProgramId: string;
  /** Holdfast event decoder (`@holdfast/chain` parseHoldfastEvents); injectable for tests. */
  parseHoldfastEvents: (logs: readonly string[]) => HoldfastEvent[];
  /** Authoritative CoinVault snapshot, refreshed after vault events. Optional (event deltas are applied regardless). */
  fetchVault?: (mint: string) => Promise<VaultSnapshotInput | null>;
  publisher: Publisher;
  reductionOrder: ReductionOrder;
  /** Owners that can earn: regular (on-curve) wallets. Defaults to `PublicKey.isOnCurve`. */
  isRegularWallet?: (address: string) => boolean;
  /** Extra addresses excluded for every coin (launcher hot wallet, ...). */
  globalExclusions?: readonly ExcludedWallet[];
  /**
   * A pump.fun admin action re-pointed the creator (fees) of one of our coins. `toTreasury` is true
   * when the new creator is still the coin's treasury (harmless).
   */
  onCreatorChange?: (e: CreatorChangeEvent & { sig: string; treasury: string; toTreasury: boolean }) => void | Promise<void>;
}

export type ProcessResult =
  | { status: "duplicate" }
  | { status: "failed_tx" }
  | { status: "irrelevant" }
  | { status: "processed"; mints: string[]; trades: number; lots: number; notifications: HoldfastNotification[] };

const onCurveCache = new Map<string, boolean>();
export function isOnCurveWallet(address: string): boolean {
  let v = onCurveCache.get(address);
  if (v === undefined) {
    try {
      v = PublicKey.isOnCurve(new PublicKey(address).toBytes());
    } catch {
      v = false;
    }
    if (onCurveCache.size > 100_000) onCurveCache.clear();
    onCurveCache.set(address, v);
  }
  return v;
}

const canonicalPoolCache = new Map<string, string>();
function canonicalPool(mint: string): string {
  let pool = canonicalPoolCache.get(mint);
  if (!pool) {
    pool = canonicalPoolPda(new PublicKey(mint)).toBase58();
    canonicalPoolCache.set(mint, pool);
  }
  return pool;
}

export function coinExclusions(coin: { mint: string; vault: string; treasury: string; bondingCurve: string; ammPool?: string | null }): ExcludedWallet[] {
  const mint = new PublicKey(coin.mint);
  const list: ExcludedWallet[] = [
    { address: coin.vault, reason: "vault" },
    { address: coin.treasury, reason: "treasury" },
    { address: coin.bondingCurve, reason: "bonding_curve" },
    { address: canonicalPool(coin.mint), reason: "pool" },
    { address: pumpPoolAuthorityPda(mint).toBase58(), reason: "pool_authority" },
  ];
  if (coin.ammPool) list.push({ address: coin.ammPool, reason: "pool" });
  return list;
}

function decodeHoldfast(tx: ParsedTx, deps: ProcessDeps): HoldfastEvent[] {
  const logs = tx.logMessages;
  if (!logs) return [];
  const marker = `Program ${deps.holdfastProgramId} invoke`;
  if (!logs.some((l) => l.startsWith(marker))) return [];
  return deps.parseHoldfastEvents(logs);
}

interface Swap {
  mint: string;
  user: string;
  isBuy: boolean;
  sol: bigint;
  tokens: bigint;
  price: number;
  spotFixed: bigint;
  venue: "curve" | "pumpswap";
  /** Curve real token reserves after the trade (graduation progress); null for pool trades. */
  curveRealTokenReserves: bigint | null;
  eventIndex: number;
}

/**
 * Index one transaction: trades, candles, lots / balances, vault mirror. Idempotent (processed_txs)
 * and applied in a single DB transaction.
 */
export async function processTransaction(tx: ParsedTx, deps: ProcessDeps): Promise<ProcessResult> {
  const { db, log } = deps;
  if (await isProcessed(db, tx.signature)) return { status: "duplicate" };
  if (tx.err) {
    await markProcessed(db, tx.signature, tx.slot);
    return { status: "failed_tx" };
  }

  const pump = parsePumpEvents({ logMessages: tx.logMessages, instructions: invokedInstructions(tx) });
  const holdfast = decodeHoldfast(tx, deps);

  const candidateMints = tokenMints(tx);
  const pools = new Set<string>();
  for (const { event } of pump) {
    if ("mint" in event) candidateMints.add(event.mint);
    if (event.type === "amm_buy" || event.type === "amm_sell") pools.add(event.pool);
    if (event.type === "amm_create_pool") candidateMints.add(event.baseMint);
  }
  for (const e of holdfast) candidateMints.add(e.mint.toBase58());

  const changes = creatorChangeEvents({ logMessages: tx.logMessages, instructions: invokedInstructions(tx) });
  for (const c of changes) candidateMints.add(c.mint);

  const coins = await getCoins(db, [...candidateMints]);
  if (pools.size) for (const c of await findCoinsByVenue(db, [...pools])) coins.set(c.mint, c);
  if (deps.onCreatorChange) {
    for (const c of changes) {
      const coin = coins.get(c.mint);
      if (!coin) continue;
      try {
        await deps.onCreatorChange({ ...c, sig: tx.signature, treasury: coin.treasury, toTreasury: c.newCreator === coin.treasury });
      } catch (err) {
        log.warn({ err, mint: c.mint }, "creator change hook failed");
      }
    }
  }
  const registering = holdfast.filter((e) => e.name === "CoinInitialized" && !coins.has(e.mint.toBase58()));
  if (coins.size === 0 && registering.length === 0) {
    await markProcessed(db, tx.signature, tx.slot);
    return { status: "irrelevant" };
  }

  // Chain reads happen before the DB transaction is opened.
  const snapshots = new Map<string, VaultSnapshotInput>();
  if (deps.fetchVault) {
    for (const mint of new Set(holdfast.map((e) => e.mint.toBase58()))) {
      try {
        const s = await deps.fetchVault(mint);
        if (s) snapshots.set(mint, s);
      } catch (err) {
        log.warn({ err, mint, sig: tx.signature }, "vault refresh failed; keeping event-derived state");
      }
    }
  }

  return db.tx(async (q) => {
    if (!(await markProcessed(q, tx.signature, tx.slot))) return { status: "duplicate" } as const;
    const run = new TxRun(q, tx, deps, coins, pump, holdfast);
    await run.registerCoins();
    await run.applyPumpLifecycle();
    const swaps = run.collectSwaps();
    const trades = await run.recordTrades(swaps);
    let lots = 0;
    for (const coin of run.coins.values()) lots += await run.applyLots(coin, swaps);
    await run.applyHoldfastEvents();
    for (const [mint, snapshot] of snapshots) {
      if (run.coins.has(mint) && (await upsertVaultState(q, snapshot))) run.notify({ kind: "vault", mint });
    }
    await deps.publisher.publish(q, run.notifications);
    return { status: "processed", mints: [...run.touched], trades, lots, notifications: run.notifications } as const;
  });
}

class TxRun {
  readonly notifications: HoldfastNotification[] = [];
  readonly touched = new Set<string>();
  private readonly time: number;
  private readonly poolToMint = new Map<string, string>();

  constructor(
    private readonly q: Queryable,
    private readonly tx: ParsedTx,
    private readonly deps: ProcessDeps,
    readonly coins: Map<string, CoinRow>,
    private readonly pump: DecodedPumpEvent[],
    private readonly holdfast: HoldfastEvent[],
  ) {
    const eventTs = pump.map((p) => p.event.timestamp).find((t) => t > 0);
    this.time = tx.blockTime ?? (eventTs ? eventTs * 1000 : Date.now());
  }

  notify(n: HoldfastNotification): void {
    this.notifications.push(n);
    if ("mint" in n) this.touched.add(n.mint);
  }

  private createEvent(mint: string): CurveCreateEvent | undefined {
    for (const { event } of this.pump) if (event.type === "create" && event.mint === mint) return event;
    return undefined;
  }

  private async reloadCoin(mint: string): Promise<void> {
    const coin = await getCoin(this.q, mint);
    if (coin) this.coins.set(mint, coin);
  }

  async registerCoins(): Promise<void> {
    for (const e of this.holdfast) {
      if (e.name !== "CoinInitialized") continue;
      const mint = e.mint.toBase58();
      const create = this.createEvent(mint);
      const inserted = await insertCoin(this.q, {
        mint,
        name: create?.name ?? "",
        ticker: create?.symbol ?? "",
        triggerBps: e.triggerBps as TriggerBps,
        vault: e.vault.toBase58(),
        treasury: e.treasury.toBase58(),
        bondingCurve: e.bondingCurve.toBase58(),
        tokenProgram: create?.tokenProgram ?? TOKEN_2022_PROGRAM_ID.toBase58(),
        launchSig: this.tx.signature,
        metadataUri: create?.uri ?? null,
        createdAt: e.ts > 0 ? e.ts * 1000 : this.time,
      });
      await this.reloadCoin(mint);
      const coin = this.coins.get(mint);
      if (!coin) continue;
      await addExcluded(this.q, [...coinExclusions(coin), ...(this.deps.globalExclusions ?? [])]);
      await ensureVaultState(this.q, mint);
      if (inserted) {
        this.deps.log.info({ mint, sig: this.tx.signature }, "registered coin");
        this.notify({ kind: "coin", mint });
      }
    }
  }

  async applyPumpLifecycle(): Promise<void> {
    for (const { event } of this.pump) {
      if (event.type === "create") {
        const coin = this.coins.get(event.mint);
        if (!coin) continue;
        await setLaunchSig(this.q, coin.mint, this.tx.signature);
        if (!coin.metadataUri || !coin.name) {
          await updateCoinMetadata(this.q, coin.mint, {
            metadataUri: event.uri,
            ...(coin.name ? {} : { name: event.name }),
            ...(coin.ticker ? {} : { ticker: event.symbol }),
          });
        }
        await this.reloadCoin(coin.mint);
      } else if (event.type === "migration" || event.type === "amm_create_pool") {
        const mint = event.type === "migration" ? event.mint : event.baseMint;
        const coin = this.coins.get(mint);
        if (!coin || event.pool !== canonicalPool(mint)) continue;
        this.poolToMint.set(event.pool, mint);
        if (!coin.graduated || coin.ammPool !== event.pool) {
          await markGraduated(this.q, mint, event.pool, this.time);
          await addExcluded(this.q, [{ address: event.pool, reason: "pool" }]);
          await this.reloadCoin(mint);
          this.notify({ kind: "coin", mint });
        }
      }
    }
  }

  private mintForPool(pool: string): string | undefined {
    const known = this.poolToMint.get(pool);
    if (known) return known;
    for (const coin of this.coins.values()) {
      if (coin.ammPool === pool || canonicalPool(coin.mint) === pool) {
        this.poolToMint.set(pool, coin.mint);
        return coin.mint;
      }
    }
    // The pool's own token accounts are in the tx: their mint is the coin.
    for (const b of this.tx.postTokenBalances) {
      if (b.owner === pool && this.coins.has(b.mint)) {
        this.poolToMint.set(pool, b.mint);
        return b.mint;
      }
    }
    return undefined;
  }

  collectSwaps(): Swap[] {
    const swaps: Swap[] = [];
    for (const { event, index } of this.pump) {
      let mint: string | undefined;
      let spotFixed: bigint;
      let venue: Swap["venue"];
      let curveRealTokenReserves: bigint | null = null;
      switch (event.type) {
        case "curve_trade":
          mint = event.mint;
          spotFixed = curveSpotAfter(event);
          venue = "curve";
          curveRealTokenReserves = event.realTokenReserves;
          break;
        case "post_complete_buy":
          mint = event.mint;
          spotFixed = postCompleteSpotAfter(event);
          venue = "curve";
          curveRealTokenReserves = 0n;
          break;
        case "amm_buy":
        case "amm_sell":
          mint = this.mintForPool(event.pool);
          spotFixed = ammSpotAfter(event);
          venue = "pumpswap";
          break;
        default:
          continue;
      }
      const coin = mint ? this.coins.get(mint) : undefined;
      if (!coin) continue;
      const amounts = tradeAmounts(event, coin.decimals);
      if (amounts.tokens === 0n) continue;
      swaps.push({ mint: coin.mint, user: event.user, ...amounts, spotFixed, venue, curveRealTokenReserves, eventIndex: index });
    }
    return swaps;
  }

  async recordTrades(swaps: readonly Swap[]): Promise<number> {
    let inserted = 0;
    for (const s of swaps) {
      const coin = this.coins.get(s.mint)!;
      const vault = s.user === coin.treasury;
      const source: TradeSource = vault ? "vault" : s.venue;
      const ok = await insertTrade(this.q, {
        sig: this.tx.signature,
        ixIndex: s.eventIndex,
        mint: s.mint,
        wallet: s.user,
        side: vault ? "vault" : s.isBuy ? "buy" : "sell",
        sol: s.sol,
        tokens: s.tokens,
        price: s.price,
        ts: this.time,
        slot: this.tx.slot,
        source,
      });
      if (!ok) continue;
      inserted++;
      await upsertCandles(this.q, { mint: s.mint, ts: this.time, price: s.price, volume: s.sol, slot: this.tx.slot });
      if (s.spotFixed > 0n) await updateLastPrice(this.q, s.mint, fixedToSolPerToken(s.spotFixed, coin.decimals), this.time, this.tx.slot);
      if (s.curveRealTokenReserves !== null) await updateCurveReserves(this.q, s.mint, s.curveRealTokenReserves, this.tx.slot);
      this.notify({ kind: "trade", mint: s.mint, sig: this.tx.signature });
    }
    return inserted;
  }

  private isLaunchTx(coin: CoinRow): boolean {
    if (coin.launchSig === this.tx.signature) return true;
    if (this.createEvent(coin.mint)) return true;
    return this.holdfast.some((e) => e.name === "CoinInitialized" && e.mint.toBase58() === coin.mint);
  }

  /** Lots and balance mirror for one coin (spec §2). Returns the number of lots created. */
  async applyLots(coin: CoinRow, swaps: readonly Swap[]): Promise<number> {
    const changes = accountChanges(this.tx, coin.mint);
    if (changes.length === 0) return 0;
    const owners = [...new Set(changes.map((c) => c.owner))];
    const excluded = await filterExcluded(this.q, owners);
    const regular = this.deps.isRegularWallet ?? isOnCurveWallet;
    const eligible = (o: string) => o !== coin.treasury && !excluded.has(o) && regular(o);
    const mine = changes.filter((c) => eligible(c.owner));
    if (mine.length === 0) return 0;

    const stored = await getTokenAccounts(this.q, mine.map((c) => c.account));
    const { effects, accountUpdates } = planAccounts(mine, stored, this.tx.slot, this.tx.tokenBalanceMode);

    // Valid buy swaps by the signer wallet; none in the launch (dev buy) transaction.
    const launch = this.isLaunchTx(coin);
    const buys = launch
      ? []
      : swaps
          .filter((s) => s.mint === coin.mint && s.isBuy && s.user !== coin.treasury && eligible(s.user))
          .map((s) => ({ user: s.user, tokenAmount: s.tokens, eventIndex: s.eventIndex }));
    const deltas = new Map<string, bigint>();
    for (const e of effects.values()) if (e.delta !== 0n) deltas.set(e.owner, e.delta);
    const movements = new Map<string, OwnerMovement>(classifyMovements(deltas, buys).map((m) => [m.owner, m]));

    let created = 0;
    for (const effect of [...effects.values()].sort((a, b) => (a.owner < b.owner ? -1 : 1))) {
      if (!eligible(effect.owner)) continue;
      const movement = movements.get(effect.owner) ?? null;
      const ownBuys = buys.filter((b) => b.user === effect.owner);
      const bought = ownBuys.reduce((s, b) => s + b.tokenAmount, 0n);
      const leftover = bought - (movement?.bought ?? 0n);
      const lateBuy = effect.staleIn < leftover ? effect.staleIn : leftover;
      if (effect.gap === 0n && !movement && lateBuy <= 0n) continue;

      const ledger = await loadLedger(this.q, coin.mint, effect.owner, { forUpdate: true });
      const plan = planLedger(ledger, {
        gap: effect.gap,
        movement,
        lateBuy: lateBuy > 0n ? lateBuy : 0n,
        acquiredAt: this.time,
        order: this.deps.reductionOrder,
        lotKey: this.tx.signature,
      });
      const sourceIx = ownBuys[0]?.eventIndex ?? 0;
      await saveLedger(this.q, {
        mint: coin.mint,
        wallet: effect.owner,
        ledger: plan.ledger,
        consumed: plan.consumed,
        newLots: plan.newLots.map((l) => ({
          wallet: effect.owner,
          mint: coin.mint,
          amount: l.amount,
          acquiredAt: l.acquiredAt,
          sourceSig: this.tx.signature,
          sourceIx: l.late ? 10_000 + sourceIx : sourceIx,
        })),
        slot: this.tx.slot,
      });
      created += plan.newLots.length;
      if (effect.gap !== 0n) this.deps.log.debug({ mint: coin.mint, wallet: effect.owner, gap: effect.gap.toString(), sig: this.tx.signature }, "reconciled balance gap");
    }
    for (const a of accountUpdates) await upsertTokenAccount(this.q, { address: a.address, mint: coin.mint, owner: a.owner, amount: a.amount, slot: this.tx.slot });
    this.touched.add(coin.mint);
    return created;
  }

  async applyHoldfastEvents(): Promise<void> {
    const deltas = new Map<string, VaultDelta>();
    const delta = (mint: string) => {
      let d = deltas.get(mint);
      if (!d) {
        d = {};
        deltas.set(mint, d);
      }
      return d;
    };
    const add = (a: bigint | undefined, b: bigint) => (a ?? 0n) + b;
    const defends = new Map<string, { sol: bigint; tokens: bigint; ts: number }>();

    for (const e of this.holdfast) {
      const mint = e.mint.toBase58();
      const coin = this.coins.get(mint);
      if (!coin) continue;
      const at = e.ts > 0 ? e.ts * 1000 : this.time;
      switch (e.name) {
        case "CoinInitialized":
          break;
        case "FeesCollected": {
          const d = delta(mint);
          d.floorSol = add(d.floorSol, e.floor);
          d.holderSol = add(d.holderSol, e.holder);
          d.creatorSol = add(d.creatorSol, e.creator ?? 0n);
          d.burnSol = add(d.burnSol, e.burn);
          d.totalFees = add(d.totalFees, e.amount);
          // Coin tokens swept into the holder pool alongside the SOL fees.
          d.holderTokens = add(d.holderTokens, e.tokens ?? 0n);
          break;
        }
        case "AthUpdated": {
          await insertFloorPoint(this.q, mint, { ts: at, ath: e.ath, floor: e.floor });
          const d = delta(mint);
          d.ath = d.ath && d.ath > e.ath ? d.ath : e.ath;
          d.floor = d.floor && d.floor > e.floor ? d.floor : e.floor;
          break;
        }
        case "Graduated":
          await markGraduated(this.q, mint, e.pool.toBase58(), at);
          await addExcluded(this.q, [{ address: e.pool.toBase58(), reason: "pool" }]);
          this.notify({ kind: "coin", mint });
          break;
        case "Defended": {
          const agg = defends.get(mint) ?? { sol: 0n, tokens: 0n, ts: at };
          agg.sol += e.solSpent;
          agg.tokens += e.tokensBought;
          defends.set(mint, agg);
          const d = delta(mint);
          d.floorSol = add(d.floorSol, -e.solSpent);
          d.holderTokens = add(d.holderTokens, e.tokensBought);
          d.totalDefended = add(d.totalDefended, e.solSpent);
          d.defends = (d.defends ?? 0) + 1;
          d.lastDefendTs = at;
          break;
        }
        case "RoundOpened": {
          const ok = await updateRoundStatus(this.q, mint, e.roundId, "opened", { openSig: this.tx.signature });
          if (!ok) this.deps.log.warn({ mint, roundId: e.roundId.toString(), sig: this.tx.signature }, "RoundOpened for a round the payout worker never stored");
          const d = delta(mint);
          d.roundId = d.roundId && d.roundId > e.roundId ? d.roundId : e.roundId;
          this.notify({ kind: "round", mint, roundId: Number(e.roundId) });
          break;
        }
        case "PayoutBatch": {
          await updateRoundStatus(this.q, mint, e.roundId, "paying");
          const d = delta(mint);
          d.holderSol = add(d.holderSol, -e.sol);
          d.holderTokens = add(d.holderTokens, -e.tokens);
          d.totalPaidSol = add(d.totalPaidSol, e.sol);
          d.totalPaidTokens = add(d.totalPaidTokens, e.tokens);
          this.notify({ kind: "round", mint, roundId: Number(e.roundId) });
          break;
        }
        case "RoundClosed":
          await updateRoundStatus(this.q, mint, e.roundId, "closed", { closeSig: this.tx.signature });
          this.notify({ kind: "round", mint, roundId: Number(e.roundId) });
          break;
        case "CreatorFeesClaimed": {
          const d = delta(mint);
          d.creatorSol = add(d.creatorSol, -e.amount);
          d.totalCreatorClaimed = add(d.totalCreatorClaimed, e.amount);
          break;
        }
        case "HoldBurned": {
          const d = delta(mint);
          d.burnSol = add(d.burnSol, -e.solSpent);
          d.totalBurnedSol = add(d.totalBurnedSol, e.solSpent);
          break;
        }
        case "TreasuryPrepared": {
          // Rent of the treasury's own token accounts / volume accumulator, paid from the floor bucket.
          const d = delta(mint);
          d.floorSol = add(d.floorSol, -e.rentPaid);
          break;
        }
      }
      this.notify({ kind: "vault", mint });
    }

    for (const [mint, d] of defends) {
      const coin = this.coins.get(mint)!;
      await insertDefend(this.q, {
        sig: this.tx.signature,
        mint,
        solSpent: d.sol,
        tokensBought: d.tokens,
        price: tradePrice(d.sol, d.tokens, coin.decimals),
        ts: d.ts,
      });
    }
    for (const [mint, d] of deltas) await applyVaultDelta(this.q, mint, d);
  }
}

/**
 * One transaction at a time per indexer process (poller and webhook share it): ledger rows for
 * wallets seen for the first time have nothing to row-lock yet, so concurrent writers could race.
 */
export function serialProcessor(deps: ProcessDeps): (tx: ParsedTx) => Promise<ProcessResult> {
  let tail: Promise<unknown> = Promise.resolve();
  return (tx) => {
    const run = tail.then(() => processTransaction(tx, deps));
    tail = run.catch(() => undefined);
    return run;
  };
}
