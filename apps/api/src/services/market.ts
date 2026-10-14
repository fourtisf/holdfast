import {
  fixedToSolPerToken,
  nextRoundAt,
  ROUND_INTERVAL_SECONDS,
  type CandleTimeframe,
  type CandlesResponse,
  type CoinDetail,
  type CoinSort,
  type CoinSummary,
  type DefendEvent,
  type Page,
  type RoundSnapshot,
  type RoundSummary,
  type Schedule,
  type Stats,
  type Trade,
} from "@holdfast/core";
import {
  getCoin,
  getCoinMetrics,
  getGlobalStats,
  getLatestRound,
  getRound,
  getTradesBySig,
  listCandles,
  listCoinMetrics,
  listDefends,
  listFloorHistory,
  listPayouts,
  listRounds,
  listTrades,
  type CoinRow,
  type Queryable,
} from "@holdfast/db";
import { decodeCursor, encodeCursor, lamportsToSol } from "../format.js";
import { notFound } from "../errors.js";
import { toCoinDetail, toCoinSummary, toDefend, toRoundSummary, toTrade } from "../present.js";

export function schedule(now: number): Schedule {
  return { roundIntervalSec: ROUND_INTERVAL_SECONDS, nextRoundAt: nextRoundAt(now), serverTime: now };
}

export async function stats(q: Queryable, now: number, solUsd: number | null = null): Promise<Stats> {
  const s = await getGlobalStats(q, now);
  return {
    coins: s.coins,
    totalVaultSol: lamportsToSol(s.totalVaultSol),
    totalPaidSol: lamportsToSol(s.totalPaidSol),
    defends24h: s.defends24h,
    volume24hSol: lamportsToSol(s.volume24h),
    schedule: schedule(now),
    solUsd,
  };
}

type CoinsCursor = { s: CoinSort; c?: number; m?: string; o?: number };

/** Coin list. `newest` pages by (createdAt, mint); the activity sorts page by offset. */
export async function listCoins(
  q: Queryable,
  opts: {
    sort: CoinSort;
    search?: string;
    limit: number;
    cursor?: string | null;
    now: number;
    filters?: { graduated?: boolean | null; maxAgeHours?: number | null; minMarketCapSol?: number | null; mints?: readonly string[] | null; creator?: string | null };
  },
): Promise<Page<CoinSummary>> {
  const cur = decodeCursor<CoinsCursor>(opts.cursor);
  const valid = cur && cur.s === opts.sort ? cur : null;
  const offset = valid?.o ?? 0;
  const f = opts.filters ?? {};
  const rows = await listCoinMetrics(q, {
    graduated: f.graduated ?? null,
    createdAfter: f.maxAgeHours ? opts.now - f.maxAgeHours * 3_600_000 : null,
    minMarketCapSol: f.minMarketCapSol ?? null,
    mints: f.mints ?? null,
    creator: f.creator ?? null,
    sort: opts.sort,
    search: opts.search,
    limit: opts.limit + 1,
    offset,
    after: valid?.c !== undefined && valid.m ? { createdAt: valid.c, mint: valid.m } : null,
    now: opts.now,
  });
  const page = rows.slice(0, opts.limit);
  let nextCursor: string | null = null;
  if (rows.length > opts.limit) {
    const last = page[page.length - 1]!.coin;
    nextCursor = encodeCursor(opts.sort === "newest" ? { s: opts.sort, c: last.createdAt, m: last.mint } : { s: opts.sort, o: offset + opts.limit });
  }
  return { items: page.map(toCoinSummary), nextCursor };
}

export async function requireCoin(q: Queryable, mint: string): Promise<CoinRow> {
  const coin = await getCoin(q, mint);
  if (!coin) throw notFound("Coin not found");
  return coin;
}

export async function coinDetail(q: Queryable, mint: string, now: number): Promise<CoinDetail> {
  const m = await getCoinMetrics(q, mint, now);
  if (!m) throw notFound("Coin not found");
  return toCoinDetail(m, await getLatestRound(q, mint));
}

export async function candles(
  q: Queryable,
  mint: string,
  opts: { tf: CandleTimeframe; from?: number; to?: number; limit: number },
): Promise<CandlesResponse> {
  const coin = await requireCoin(q, mint);
  const rows = await listCandles(q, mint, opts.tf, opts);
  const from = opts.from ?? rows[0]?.ts;
  const floor = await listFloorHistory(q, mint, { from, to: opts.to });
  const defends = await listDefends(q, mint, { limit: 500, from, to: opts.to });
  return {
    mint,
    tf: opts.tf,
    candles: rows.map((c) => ({ t: c.ts, o: c.open, h: c.high, l: c.low, c: c.close, v: lamportsToSol(c.volume) })),
    floorLine: floor.map((p) => ({ t: p.ts, price: fixedToSolPerToken(p.floor, coin.decimals) })),
    defends: defends.reverse().map((d) => ({ t: d.ts, price: d.price, solSpent: lamportsToSol(d.solSpent), sig: d.sig })),
  };
}

type TradesCursor = { t: number; s: string; i: number };

export async function trades(q: Queryable, mint: string, opts: { limit: number; before?: string | null }): Promise<Page<Trade>> {
  const coin = await requireCoin(q, mint);
  const c = decodeCursor<TradesCursor>(opts.before);
  const rows = await listTrades(q, mint, { limit: opts.limit + 1, before: c ? { ts: c.t, sig: c.s, ixIndex: c.i } : null });
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((t) => toTrade(t, coin.decimals)),
    nextCursor: rows.length > opts.limit && last ? encodeCursor({ t: last.ts, s: last.sig, i: last.ixIndex } satisfies TradesCursor) : null,
  };
}

export async function tradesBySig(q: Queryable, mint: string, sig: string): Promise<Trade[]> {
  const coin = await getCoin(q, mint);
  if (!coin) return [];
  return (await getTradesBySig(q, sig)).filter((t) => t.mint === mint).map((t) => toTrade(t, coin.decimals));
}

export async function defends(q: Queryable, mint: string, limit: number): Promise<DefendEvent[]> {
  const coin = await requireCoin(q, mint);
  return (await listDefends(q, mint, { limit })).map((d) => toDefend(d, coin.decimals));
}

export async function rounds(q: Queryable, mint: string, limit: number): Promise<RoundSummary[]> {
  const coin = await requireCoin(q, mint);
  return (await listRounds(q, mint, limit)).map((r) => toRoundSummary(r, coin.decimals));
}

export async function roundSummary(q: Queryable, mint: string, roundId: number): Promise<RoundSummary | null> {
  const coin = await getCoin(q, mint);
  const round = coin ? await getRound(q, mint, roundId) : null;
  return coin && round ? toRoundSummary(round, coin.decimals) : null;
}

/**
 * The stored public snapshot, with live round status, pots in display units and each entry's
 * payout signature filled in from `payouts`. `inputs`/`entries`/`carriedOut` are untouched, so
 * `verifyRoundSnapshot` still reproduces the merkle root.
 */
export async function roundSnapshot(q: Queryable, mint: string, roundId: number): Promise<RoundSnapshot> {
  const coin = await requireCoin(q, mint);
  const round = await getRound(q, mint, roundId);
  if (!round) throw notFound("Round not found");
  const sigs = new Map((await listPayouts(q, mint, roundId)).map((p) => [p.idx, p.sig]));
  const summary = toRoundSummary(round, coin.decimals);
  return {
    ...round.snapshot,
    ...summary,
    entries: round.snapshot.entries.map((e) => ({ ...e, sig: sigs.get(e.index) ?? e.sig })),
  };
}
