import { createHash } from "node:crypto";
import { base58 } from "@scure/base";
import {
  applyBuy,
  applyDecrease,
  applyUntrackedIncrease,
  buildRoundSnapshot,
  computeRound,
  currentRoundStartedAt,
  curvePriceFixed,
  emptyLedger,
  fixedToSolPerToken,
  floorFromAth,
  RENT_EXEMPT_MIN_LAMPORTS,
  ROUND_INTERVAL_SECONDS,
  SPLIT_BURN_BPS,
  SPLIT_CREATOR_BPS,
  SPLIT_HOLDER_BPS,
  SPLIT_PLATFORM_BPS,
  tradePrice,
  type CarryInput,
  type HolderInput,
  type TriggerBps,
  type WalletLedger,
} from "@holdfast/core";
import type { Db, Queryable } from "./db.js";
import { dec, ts } from "./sql.js";
import { insertCoin, markGraduated, updateLastPrice } from "./repos/coins.js";
import { insertTrade, type TradeRow } from "./repos/trades.js";
import { upsertCandles } from "./repos/candles.js";
import { upsertWalletBalance } from "./repos/lots.js";
import { insertDefend, insertFloorPoint, upsertVaultState } from "./repos/vault.js";
import { insertRound, markPayout, saveCarries, updateRoundStatus } from "./repos/payouts.js";
import { addExcluded } from "./repos/excluded.js";

/**
 * Deterministic demo dataset for local development (`pnpm --filter @holdfast/api dev:pglite`):
 * six coins with simulated bonding-curve trading, FIFO lots, transfers, vault buckets, ATH/floor
 * history, buybacks and recent payout rounds computed with @holdfast/core.
 */

export interface SeedOptions {
  now?: number;
  seed?: number;
}

export interface SeedResult {
  mints: string[];
  wallets: string[];
  launcher: string;
}

const TOKEN_PROGRAM_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const LAMPORTS = 1_000_000_000;

interface DemoCoin {
  name: string;
  ticker: string;
  triggerBps: TriggerBps;
  ageHours: number;
  trades: number;
  /** Fraction of trades that are buys while pumping, before the late phase. */
  buyBias: number;
  /** Late phase (last 25% of trades) buy probability: < 0.5 dumps toward the floor. */
  lateBuyBias: number;
  graduate?: boolean;
  description: string;
}

const DEMO_COINS: DemoCoin[] = [
  { name: "Holdfast Hound", ticker: "HOUND", triggerBps: 2500, ageHours: 150, trades: 420, buyBias: 0.62, lateBuyBias: 0.75, description: "The original diamond-pawed hound." },
  { name: "Iron Frog", ticker: "IFROG", triggerBps: 1500, ageHours: 60, trades: 300, buyBias: 0.6, lateBuyBias: 0.72, description: "Ribbit. Never sells." },
  { name: "Anchor Cat", ticker: "ANCHR", triggerBps: 3500, ageHours: 20, trades: 240, buyBias: 0.66, lateBuyBias: 0.15, description: "Dumped hard, the vault is buying." },
  { name: "Steady Lad", ticker: "STEADY", triggerBps: 2500, ageHours: 6, trades: 160, buyBias: 0.6, lateBuyBias: 0.65, description: "Slow and steady." },
  { name: "Floor Wizard", ticker: "FLRWZ", triggerBps: 2500, ageHours: 1.5, trades: 90, buyBias: 0.7, lateBuyBias: 0.6, description: "Fresh launch." },
  { name: "Grad Moon", ticker: "GMOON", triggerBps: 2500, ageHours: 110, trades: 520, buyBias: 0.72, lateBuyBias: 0.75, graduate: true, description: "Graduated to PumpSwap." },
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function demoAddress(label: string): string {
  return base58.encode(createHash("sha256").update(`holdfast-demo:${label}`).digest());
}

function demoSig(label: string): string {
  const a = createHash("sha256").update(`sig-a:${label}`).digest();
  const b = createHash("sha256").update(`sig-b:${label}`).digest();
  return base58.encode(Buffer.concat([a, b]));
}

interface LotMeta {
  initial: bigint;
  sig: string;
}

export async function seedDemo(db: Db, opts: SeedOptions = {}): Promise<SeedResult> {
  const now = opts.now ?? Date.now();
  const rand = mulberry32(opts.seed ?? 42);
  const wallets = Array.from({ length: 40 }, (_, i) => demoAddress(`wallet:${i}`));
  const launcher = demoAddress("launcher");
  const mints: string[] = [];

  await db.tx(async (q) => {
    await addExcluded(q, [{ address: launcher, reason: "launcher" }]);
    for (const [ci, spec] of DEMO_COINS.entries()) {
      const mint = demoAddress(`mint:${spec.ticker}`);
      mints.push(mint);
      await seedCoin(q, { spec, ci, mint, wallets, launcher, now, rand });
    }
  });
  return { mints, wallets, launcher };
}

async function seedCoin(
  q: Queryable,
  ctx: { spec: DemoCoin; ci: number; mint: string; wallets: string[]; launcher: string; now: number; rand: () => number },
): Promise<void> {
  const { spec, mint, wallets, launcher, now, rand } = ctx;
  const createdAt = now - spec.ageHours * 3_600_000;
  const vault = demoAddress(`vault:${spec.ticker}`);
  const treasury = demoAddress(`treasury:${spec.ticker}`);
  const bondingCurve = demoAddress(`curve:${spec.ticker}`);
  const pool = spec.graduate ? demoAddress(`pool:${spec.ticker}`) : null;
  const creator = wallets[(ctx.ci * 7) % wallets.length]!;

  await insertCoin(q, {
    mint,
    name: spec.name,
    ticker: spec.ticker,
    description: spec.description,
    socials: { x: `https://x.com/${spec.ticker.toLowerCase()}`, website: `https://${spec.ticker.toLowerCase()}.example` },
    triggerBps: spec.triggerBps,
    creator,
    vault,
    treasury,
    bondingCurve,
    tokenProgram: TOKEN_PROGRAM_2022,
    launchSig: demoSig(`${spec.ticker}:launch`),
    createdAt,
  });
  await addExcluded(q, [
    { address: vault, reason: "vault" },
    { address: treasury, reason: "treasury" },
    { address: bondingCurve, reason: "bonding_curve" },
    ...(pool ? [{ address: pool, reason: "pool" }] : []),
  ]);

  // Curve state (lamports / base units).
  let vSol = 30_000_000_000n;
  let vTok = 1_073_000_000_000_000n;
  let realSol = 0n;
  let graduated = false;

  const ledgers = new Map<string, WalletLedger>();
  const lotMeta = new Map<string, LotMeta>();
  const ledger = (w: string) => ledgers.get(w) ?? emptyLedger();

  let floorSol = 0n;
  let holderSol = 0n;
  let creatorSol = 0n;
  let platformSol = 0n;
  let burnSol = 0n;
  let holderTokens = 0n;
  let pendingFees = 0n;
  let totalFees = 0n;
  let totalDefended = 0n;
  let totalBurned = 0n;
  let defendCount = 0n;
  let lastDefendTs: number | null = null;
  let athFixed = 0n;
  let floorFixed = 0n;
  let lastCollect = createdAt;
  const twapWindow: { t: number; p: bigint }[] = [];

  const times = Array.from({ length: spec.trades }, () => createdAt + 60_000 + rand() * (now - createdAt - 90_000)).sort((a, b) => a - b);
  let slot = 300_000_000 + ctx.ci * 10_000_000;

  const record = async (t: TradeRow, spotFixed: bigint) => {
    await insertTrade(q, t);
    await upsertCandles(q, { mint, ts: t.ts, price: t.price, volume: t.sol, slot: t.slot });
    await updateLastPrice(q, mint, fixedToSolPerToken(spotFixed), t.ts, t.slot);
  };

  const swap = (isBuy: boolean, amountIn: bigint): { sol: bigint; tokens: bigint } => {
    if (isBuy) {
      const tokens = (vTok * amountIn) / (vSol + amountIn);
      vSol += amountIn;
      vTok -= tokens;
      realSol += amountIn;
      return { sol: amountIn, tokens };
    }
    const sol = (vSol * amountIn) / (vTok + amountIn);
    vSol -= sol;
    vTok += amountIn;
    realSol -= sol;
    return { sol, tokens: amountIn };
  };

  for (const [i, t] of times.entries()) {
    slot += 1 + Math.floor(rand() * 40);
    const sig = demoSig(`${spec.ticker}:${i}`);
    const late = i > spec.trades * 0.75;
    let wallet: string;
    let isBuy: boolean;
    if (i === 0) {
      wallet = launcher; // launch dev buy, delivered to the creator: never earns
      isBuy = true;
    } else {
      wallet = wallets[Math.floor(rand() ** 1.6 * wallets.length)]!;
      const bal = ledger(wallet).balance;
      isBuy = bal === 0n || rand() < (late ? spec.lateBuyBias : spec.buyBias);
    }

    let fill: { sol: bigint; tokens: bigint };
    if (isBuy) {
      const sol = BigInt(Math.floor((0.05 + rand() ** 2 * 2.5) * LAMPORTS));
      fill = swap(true, sol);
    } else {
      const bal = ledger(wallet).balance;
      const full = rand() < 0.1;
      const amount = full ? bal : (bal * BigInt(Math.floor(100 + rand() * 450))) / 1000n;
      if (amount <= 0n) continue;
      fill = swap(false, amount);
    }
    const spot = curvePriceFixed(vSol, vTok);
    await record(
      {
        sig,
        ixIndex: 0,
        mint,
        wallet,
        side: isBuy ? "buy" : "sell",
        sol: fill.sol,
        tokens: fill.tokens,
        price: tradePrice(fill.sol, fill.tokens),
        ts: Math.floor(t),
        slot,
        source: graduated ? "pumpswap" : "curve",
      },
      spot,
    );

    // Ledger (spec §2): buys create lots, sells consume FIFO, the dev buy is untracked for the creator.
    if (i === 0) {
      ledgers.set(creator, applyUntrackedIncrease(ledger(creator), fill.tokens));
    } else if (isBuy) {
      const id = `${String(slot).padStart(14, "0")}:${i}`;
      lotMeta.set(id, { initial: fill.tokens, sig });
      ledgers.set(wallet, applyBuy(ledger(wallet), { id, amount: fill.tokens, acquiredAt: Math.floor(t) }));
    } else {
      ledgers.set(wallet, applyDecrease(ledger(wallet), fill.tokens).ledger);
    }
    // Occasional wallet-to-wallet transfer: sender loses FIFO lots, receiver gets untracked tokens.
    if (i > 0 && rand() < 0.04 && ledger(wallet).balance > 0n) {
      const to = wallets[Math.floor(rand() * wallets.length)]!;
      if (to !== wallet) {
        const amount = ledger(wallet).balance / 3n;
        if (amount > 0n) {
          ledgers.set(wallet, applyDecrease(ledger(wallet), amount).ledger);
          ledgers.set(to, applyUntrackedIncrease(ledger(to), amount));
        }
      }
    }

    // Creator fees (demo: 1%) collected every ~10 minutes and split 40/25/15/10/10 (dust to the floor).
    pendingFees += (fill.sol * 100n) / 10_000n;
    if (t - lastCollect > 600_000 && pendingFees > 0n) {
      const h = (pendingFees * BigInt(SPLIT_HOLDER_BPS)) / 10_000n;
      const c = (pendingFees * BigInt(SPLIT_CREATOR_BPS)) / 10_000n;
      const pl = (pendingFees * BigInt(SPLIT_PLATFORM_BPS)) / 10_000n;
      const b = (pendingFees * BigInt(SPLIT_BURN_BPS)) / 10_000n;
      floorSol += pendingFees - h - c - pl - b;
      holderSol += h;
      creatorSol += c;
      platformSol += pl;
      burnSol += b;
      totalFees += pendingFees;
      pendingFees = 0n;
      lastCollect = t;
      if (burnSol > 50_000_000n) {
        totalBurned += burnSol;
        burnSol = 0n;
      }
    }

    // ATH from a 10-minute TWAP, floor follows ATH and never drops.
    twapWindow.push({ t, p: spot });
    while (twapWindow.length > 1 && twapWindow[0]!.t < t - 600_000) twapWindow.shift();
    const twap = twapWindow.reduce((s, o) => s + o.p, 0n) / BigInt(twapWindow.length);
    if (twap > (athFixed * 102n) / 100n) {
      athFixed = twap;
      floorFixed = floorFromAth(athFixed, spec.triggerBps);
      await insertFloorPoint(q, mint, { ts: Math.floor(t), ath: athFixed, floor: floorFixed });
    }

    // Defend: price at/below floor, 20-minute cooldown, 10% of the floor bucket per step.
    if (floorFixed > 0n && spot <= floorFixed && floorSol > 50_000_000n && (lastDefendTs === null || t - lastDefendTs > 1_200_000)) {
      const spend = floorSol / 10n;
      slot += 1;
      const dsig = demoSig(`${spec.ticker}:defend:${i}`);
      const buy = swap(true, spend);
      const dts = Math.floor(t) + 1_000;
      floorSol -= spend;
      holderTokens += buy.tokens;
      totalDefended += spend;
      defendCount += 1n;
      lastDefendTs = dts;
      const price = tradePrice(buy.sol, buy.tokens);
      await record(
        { sig: dsig, ixIndex: 0, mint, wallet: treasury, side: "vault", sol: buy.sol, tokens: buy.tokens, price, ts: dts, slot, source: "vault" },
        curvePriceFixed(vSol, vTok),
      );
      await insertDefend(q, { sig: dsig, mint, solSpent: spend, tokensBought: buy.tokens, price, ts: dts });
    }

    if (spec.graduate && !graduated && realSol > 60_000_000_000n) {
      graduated = true;
      await markGraduated(q, mint, pool, Math.floor(t));
    }
  }

  // Payout rounds for the last ~20 minutes, using the final lots as the eligibility snapshot.
  const lastSlotStart = currentRoundStartedAt(now);
  let carries: CarryInput[] = [];
  let totalPaidSol = 0n;
  let totalPaidTokens = 0n;
  let roundId = 0n;
  const roundsToRun = 10;
  for (let k = roundsToRun; k >= 1; k--) {
    const snapshotAt = lastSlotStart - (k - 1) * ROUND_INTERVAL_SECONDS * 1000;
    if (snapshotAt <= createdAt) continue;
    roundId += 1n;
    const holders: HolderInput[] = [];
    for (const [wallet, l] of ledgers) {
      const lots = l.lots.filter((lot) => lot.acquiredAt <= snapshotAt).map((lot) => ({ amount: lot.amount, acquiredAt: lot.acquiredAt }));
      if (lots.length) holders.push({ wallet, lots, solBalance: 2n * RENT_EXEMPT_MIN_LAMPORTS, hasTokenAccount: true });
    }
    // Carries stay inside the on-chain bucket, so the pot is carries + a slice of the rest.
    const carriedSol = carries.reduce((s, c) => s + c.sol, 0n);
    const carriedTokens = carries.reduce((s, c) => s + c.tokens, 0n);
    const inputs = {
      mint,
      roundId,
      snapshotAt,
      potSol: carriedSol + (holderSol - carriedSol) / BigInt(k + 1),
      potTokens: carriedTokens + (holderTokens - carriedTokens) / BigInt(k + 1),
      params: { minSolLamports: 50_000n, minTokensRaw: 1_000_000n, rentExemptMinLamports: RENT_EXEMPT_MIN_LAMPORTS, carryExpiryMs: 7 * 86_400_000, maxRecipients: 250 },
      holders,
      carriedIn: carries,
    };
    const result = computeRound(inputs);
    const snapshot = buildRoundSnapshot(inputs, result, snapshotAt + 5_000);
    const last = k === 1;
    await insertRound(q, snapshot, { status: last ? "paying" : "closed" });
    const openSig = demoSig(`${spec.ticker}:round:${roundId}:open`);
    await updateRoundStatus(q, mint, roundId, last ? "paying" : "closed", {
      openSig,
      ...(last ? {} : { closeSig: demoSig(`${spec.ticker}:round:${roundId}:close`) }),
    });
    for (const e of result.entries) {
      const paid = !last || e.index % 2 === 0;
      if (!paid) continue;
      await markPayout(q, { mint, roundId, idx: e.index, status: "confirmed", sig: demoSig(`${spec.ticker}:round:${roundId}:pay:${Math.floor(e.index / 8)}`) });
      totalPaidSol += e.sol;
      totalPaidTokens += e.tokens;
      holderSol -= e.sol;
      holderTokens -= e.tokens;
    }
    carries = result.carriedOut;
  }
  await saveCarries(q, mint, carries);

  for (const [wallet, l] of ledgers) {
    if (wallet === launcher) continue;
    for (const lot of l.lots) {
      const meta = lotMeta.get(lot.id)!;
      await q.query(
        `INSERT INTO lots (wallet, mint, amount_initial, amount_remaining, acquired_at, source_sig, source_ix) VALUES ($1, $2, $3, $4, $5, $6, 0)`,
        [wallet, mint, dec(meta.initial), dec(lot.amount), ts(lot.acquiredAt), meta.sig],
      );
    }
    await upsertWalletBalance(q, { mint, wallet, balance: l.balance, untracked: l.untracked, slot });
  }

  await upsertVaultState(q, {
    mint,
    floorSol,
    holderSol,
    burnSol,
    holderTokens,
    ath: athFixed,
    floor: floorFixed,
    defendCount,
    lastDefendTs,
    roundId,
    totalFees,
    totalDefended,
    totalPaidSol,
    totalPaidTokens,
    totalBurnedSol: totalBurned,
    creatorSol,
    totalCreatorClaimed: 0n,
    platformSol,
    totalPlatformSwept: 0n,
    slot,
  });
}
