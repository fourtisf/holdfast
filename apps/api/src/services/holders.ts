import { lotsTotal, lotWeightPpm, weightedAmount, type Holder, type Lot, type Position, type Profile } from "@holdfast/core";
import {
  earningsByMint,
  earningsByWallet,
  getCarry,
  getCoin,
  getCoins,
  getVaultState,
  latestTradePrice,
  loadEligibleHolders,
  loadHolderBook,
  loadWalletBook,
  recentPayoutsForWallet,
  sumCarries,
  type CoinRow,
  type Earnings,
  type Queryable,
} from "@holdfast/db";
import { lamportsToSol, rawToTokens } from "../format.js";
import { requireCoin } from "./market.js";

/**
 * Weight math at "now" with @holdfast/core: W = Σ lot.amount × weight_ppm(age), share = W / ΣW over
 * every eligible wallet of the coin (the same quantity the payout worker distributes by).
 */

const PPM = 1_000_000;

function weightedTokens(w: bigint, decimals: number): number {
  return Number(w) / PPM / 10 ** decimals;
}

function multiplier(w: bigint, eligibleRaw: bigint): number {
  return eligibleRaw > 0n ? Number(w) / PPM / Number(eligibleRaw) : 0;
}

export async function holders(q: Queryable, mint: string, opts: { limit: number; now: number }): Promise<Holder[]> {
  const coin = await requireCoin(q, mint);
  const [book, earnings] = await Promise.all([loadHolderBook(q, mint), earningsByMint(q, mint)]);
  const rows = book.map((e) => ({ e, w: weightedAmount(e.lots, opts.now), eligible: lotsTotal(e) }));
  const total = rows.reduce((s, r) => s + r.w, 0n);
  const d = coin.decimals;
  return rows
    .map(({ e, w, eligible }): Holder => {
      const earned = earnings.get(e.wallet);
      return {
        wallet: e.wallet,
        tokens: rawToTokens(e.balance, d),
        eligibleTokens: rawToTokens(eligible, d),
        weightedTokens: weightedTokens(w, d),
        weightMultiplier: multiplier(w, eligible),
        share: total > 0n ? Number(w) / Number(total) : 0,
        earnedSol: earned ? lamportsToSol(earned.sol) : 0,
        earnedTokens: earned ? rawToTokens(earned.tokens, d) : 0,
        oldestLotAt: e.lots[0]?.acquiredAt ?? null,
      };
    })
    .sort((a, b) => b.weightedTokens - a.weightedTokens || b.tokens - a.tokens || (a.wallet < b.wallet ? -1 : 1))
    .slice(0, opts.limit);
}

async function totalWeight(q: Queryable, mint: string, now: number): Promise<bigint> {
  return (await loadEligibleHolders(q, mint)).reduce((s, h) => s + weightedAmount(h.lots, now), 0n);
}

async function currentPrice(q: Queryable, coin: CoinRow): Promise<number> {
  return coin.lastPrice ?? (await latestTradePrice(q, coin.mint)) ?? 0;
}

function buildPosition(
  coin: CoinRow,
  data: { balance: bigint; lots: Lot[]; earned: Earnings | undefined; price: number; totalW: bigint; potSol: bigint; carriedSol: bigint; ownCarrySol: bigint },
  now: number,
): Position {
  const d = coin.decimals;
  const w = weightedAmount(data.lots, now);
  const eligible = data.lots.reduce((s, l) => s + l.amount, 0n);
  const share = data.totalW > 0n ? Number(w) / Number(data.totalW) : 0;
  const distributable = data.potSol > data.carriedSol ? data.potSol - data.carriedSol : 0n;
  const tokens = rawToTokens(data.balance, d);
  return {
    mint: coin.mint,
    name: coin.name,
    ticker: coin.ticker,
    imageUrl: coin.imageUrl,
    tokens,
    eligibleTokens: rawToTokens(eligible, d),
    weightedTokens: weightedTokens(w, d),
    weightMultiplier: multiplier(w, eligible),
    share,
    valueSol: tokens * data.price,
    earnedSol: data.earned ? lamportsToSol(data.earned.sol) : 0,
    earnedTokens: data.earned ? rawToTokens(data.earned.tokens, d) : 0,
    // Same split as computeRound: (pot − outstanding carries) × share, plus this wallet's own carry.
    nextPayoutEstimateSol: lamportsToSol(data.totalW > 0n ? (distributable * w) / data.totalW : 0n) + lamportsToSol(data.ownCarrySol),
    lots: data.lots.map((l) => ({ amount: rawToTokens(l.amount, d), acquiredAt: l.acquiredAt, weight: Number(lotWeightPpm(l.acquiredAt, now)) / PPM })),
  };
}

async function positionFor(
  q: Queryable,
  coin: CoinRow,
  wallet: string,
  held: { balance: bigint; lots: Lot[] } | undefined,
  earned: Earnings | undefined,
  now: number,
): Promise<Position> {
  const [price, totalW, vault, carries, ownCarry] = await Promise.all([
    currentPrice(q, coin),
    totalWeight(q, coin.mint, now),
    getVaultState(q, coin.mint),
    sumCarries(q, coin.mint),
    getCarry(q, coin.mint, wallet),
  ]);
  return buildPosition(
    coin,
    {
      balance: held?.balance ?? 0n,
      lots: held?.lots ?? [],
      earned,
      price,
      totalW,
      potSol: vault?.holderSol ?? 0n,
      carriedSol: carries.sol,
      ownCarrySol: ownCarry?.sol ?? 0n,
    },
    now,
  );
}

/** "Your share" panel; null when the wallet never held or earned this coin. */
export async function position(q: Queryable, wallet: string, mint: string, now: number): Promise<Position | null> {
  const coin = await getCoin(q, mint);
  if (!coin) return null;
  const held = (await loadWalletBook(q, wallet)).get(mint);
  const earned = (await earningsByWallet(q, wallet)).get(mint);
  if ((!held || (held.balance === 0n && held.lots.length === 0)) && !earned) return null;
  return positionFor(q, coin, wallet, held, earned, now);
}

export async function profile(q: Queryable, wallet: string, now: number): Promise<Profile> {
  const [book, earnings, recent] = await Promise.all([loadWalletBook(q, wallet), earningsByWallet(q, wallet), recentPayoutsForWallet(q, wallet, 20)]);
  const mints = new Set<string>();
  for (const [mint, h] of book) if (h.balance > 0n || h.lots.length > 0) mints.add(mint);
  for (const mint of earnings.keys()) mints.add(mint);
  for (const p of recent) mints.add(p.mint);
  const coins = await getCoins(q, [...mints]);

  const positions: Position[] = [];
  let totalEarnedSol = 0;
  let totalEarnedTokensValueSol = 0;
  for (const mint of mints) {
    const coin = coins.get(mint);
    if (!coin) continue;
    const held = book.get(mint);
    const earned = earnings.get(mint);
    const p = await positionFor(q, coin, wallet, held, earned, now);
    totalEarnedSol += p.earnedSol;
    totalEarnedTokensValueSol += p.earnedTokens * (p.tokens > 0 ? p.valueSol / p.tokens : await currentPrice(q, coin));
    if (p.tokens > 0 || p.eligibleTokens > 0 || p.earnedSol > 0 || p.earnedTokens > 0) positions.push(p);
  }
  positions.sort((a, b) => b.valueSol - a.valueSol || b.earnedSol - a.earnedSol);
  return {
    wallet,
    totalEarnedSol,
    totalEarnedTokensValueSol,
    positions,
    recentPayouts: recent.map((p) => {
      const coin = coins.get(p.mint);
      const d = coin?.decimals ?? 6;
      return { mint: p.mint, ticker: coin?.ticker ?? "", roundId: Number(p.roundId), sol: lamportsToSol(p.sol), tokens: rawToTokens(p.tokens, d), ts: p.ts, sig: p.sig };
    }),
  };
}
