"use client";

import type { CandleTimeframe, Comment, CoinSort, LeaderboardKind, Page, Trade, WalletTrade } from "@holdfast/core";
import { useCallback } from "react";
import useSWR, { unstable_serialize, useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { api, type CoinsQuery } from "../api";

/** Coin list filters on top of sort + search (all optional). */
export type CoinFilters = Pick<CoinsQuery, "graduated" | "maxAgeHours" | "minMcapSol" | "mints">;

export const keys = {
  stats: () => ["stats"] as const,
  coin: (mint: string) => ["coin", mint] as const,
  candles: (mint: string, tf: CandleTimeframe) => ["candles", mint, tf] as const,
  holders: (mint: string) => ["holders", mint] as const,
  defends: (mint: string) => ["defends", mint] as const,
  position: (wallet: string, mint: string) => ["position", wallet, mint] as const,
  profile: (wallet: string) => ["profile", wallet] as const,
};

/** Launch deposit quote (rounded dev buy keeps the cache key small). */
export function useLaunchQuote(devBuySol = 0) {
  const dev = Math.round(devBuySol * 1e4) / 1e4;
  return useSWR(["launchQuote", dev] as const, () => api.launchQuote({ devBuySol: dev }), { revalidateOnFocus: false, dedupingInterval: 60_000, keepPreviousData: true });
}

export function useStats() {
  return useSWR(keys.stats(), () => api.stats(), { refreshInterval: 30_000 });
}

export function useCoins(sort: CoinSort, q: string, pageSize = 24, filters: CoinFilters = {}, enabled = true) {
  const f = JSON.stringify(filters);
  return useSWRInfinite(
    (index, previous: Page<unknown> | null) => {
      if (!enabled || (previous && !previous.nextCursor)) return null;
      return ["coins", sort, q, pageSize, f, index === 0 ? null : (previous?.nextCursor ?? null)] as const;
    },
    ([, s, query, limit, filterJson, cursor]) => api.coins({ sort: s, q: query || undefined, limit, cursor, ...(JSON.parse(filterJson) as CoinFilters) }),
    { refreshInterval: 20_000, revalidateFirstPage: true, keepPreviousData: true },
  );
}

export function useCoin(mint: string) {
  return useSWR(keys.coin(mint), () => api.coin(mint), { refreshInterval: 30_000 });
}

/** `refreshMs` polls (the fallback while the live socket is down; live trades patch the cache otherwise). */
export function useCandles(mint: string, tf: CandleTimeframe, refreshMs = 0) {
  return useSWR(keys.candles(mint, tf), () => api.candles(mint, tf), { revalidateOnFocus: false, keepPreviousData: true, refreshInterval: refreshMs });
}

/** Poll interval for live views while the socket is not open. */
export const LIVE_FALLBACK_POLL_MS = 5_000;

export function useTradesPages(mint: string, pageSize = 30, refreshMs = 0) {
  return useSWRInfinite(
    (index, previous: Page<Trade> | null) => {
      if (previous && !previous.nextCursor) return null;
      return ["trades", mint, pageSize, index === 0 ? null : (previous?.nextCursor ?? null)] as const;
    },
    ([, m, limit, before]) => api.trades(m, { limit, before }),
    { revalidateOnFocus: false, refreshInterval: refreshMs },
  );
}

export function useHolders(mint: string) {
  return useSWR(keys.holders(mint), () => api.holders(mint, { limit: 50 }), { refreshInterval: 60_000 });
}

export function useDefends(mint: string) {
  return useSWR(keys.defends(mint), () => api.defends(mint, { limit: 50 }), { refreshInterval: 60_000 });
}

export function usePosition(wallet: string | null, mint: string) {
  return useSWR(wallet ? keys.position(wallet, mint) : null, () => api.position(wallet!, mint), { refreshInterval: 60_000 });
}

export function useProfile(wallet: string | null) {
  return useSWR(wallet ? keys.profile(wallet) : null, () => api.profile(wallet!), { refreshInterval: 60_000 });
}

/** Whether a query has data in the cache (live patches and resyncs only touch loaded keys). */
export function useIsCached() {
  const { cache } = useSWRConfig();
  return useCallback((key: readonly unknown[]) => cache.get(unstable_serialize(key))?.data !== undefined, [cache]);
}

/**
 * Patch a cached query with live data, without revalidating. Keys that have not loaded yet are left
 * alone: mutating while the first request is in flight would make SWR drop that response.
 */
export function usePatchCache() {
  const { cache, mutate } = useSWRConfig();
  return useCallback(
    <T>(key: readonly unknown[], update: (current: T) => T) => {
      if (cache.get(unstable_serialize(key))?.data === undefined) return;
      void mutate<T>(key, (current) => (current === undefined ? current : update(current)), { revalidate: false });
    },
    [cache, mutate],
  );
}

export function useWalletTrades(wallet: string | null, pageSize = 30) {
  return useSWRInfinite(
    (index, previous: Page<WalletTrade> | null) => {
      if (!wallet || (previous && !previous.nextCursor)) return null;
      return ["walletTrades", wallet, pageSize, index === 0 ? null : (previous?.nextCursor ?? null)] as const;
    },
    ([, w, limit, before]) => api.walletTrades(w, { limit, before }),
    { revalidateOnFocus: false },
  );
}

export function useLeaderboard(kind: LeaderboardKind, days?: number) {
  return useSWR(["leaderboard", kind, days ?? null] as const, () => api.leaderboard(kind, { limit: 50, days }), { refreshInterval: 60_000, keepPreviousData: true });
}

export function useCreator(wallet: string) {
  return useSWR(["creator", wallet] as const, () => api.creator(wallet), { refreshInterval: 60_000 });
}

export function useComments(mint: string, pageSize = 30) {
  return useSWRInfinite(
    (index, previous: Page<Comment> | null) => {
      if (previous && !previous.nextCursor) return null;
      return ["comments", mint, pageSize, index === 0 ? null : (previous?.nextCursor ?? null)] as const;
    },
    ([, m, limit, before]) => api.comments(m, { limit, before }),
    { refreshInterval: 20_000, revalidateFirstPage: true },
  );
}

export function useRound(mint: string, roundId: number) {
  return useSWR(["round", mint, roundId] as const, () => api.round(mint, roundId), { revalidateOnFocus: false });
}

export function useRounds(mint: string) {
  return useSWR(["rounds", mint] as const, () => api.rounds(mint, { limit: 30 }), { refreshInterval: 60_000 });
}
