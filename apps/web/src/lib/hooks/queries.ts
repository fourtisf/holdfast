"use client";

import type { CandleTimeframe, CoinSort, Page, Trade } from "@holdfast/core";
import { useCallback } from "react";
import useSWR, { unstable_serialize, useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { api } from "../api";

export const keys = {
  stats: () => ["stats"] as const,
  coin: (mint: string) => ["coin", mint] as const,
  candles: (mint: string, tf: CandleTimeframe) => ["candles", mint, tf] as const,
  holders: (mint: string) => ["holders", mint] as const,
  defends: (mint: string) => ["defends", mint] as const,
  position: (wallet: string, mint: string) => ["position", wallet, mint] as const,
  profile: (wallet: string) => ["profile", wallet] as const,
};

export function useStats() {
  return useSWR(keys.stats(), () => api.stats(), { refreshInterval: 30_000 });
}

export function useCoins(sort: CoinSort, q: string, pageSize = 24) {
  return useSWRInfinite(
    (index, previous: Page<unknown> | null) => {
      if (previous && !previous.nextCursor) return null;
      return ["coins", sort, q, pageSize, index === 0 ? null : (previous?.nextCursor ?? null)] as const;
    },
    ([, s, query, limit, cursor]) => api.coins({ sort: s, q: query || undefined, limit, cursor }),
    { refreshInterval: 20_000, revalidateFirstPage: true, keepPreviousData: true },
  );
}

export function useCoin(mint: string) {
  return useSWR(keys.coin(mint), () => api.coin(mint), { refreshInterval: 30_000 });
}

export function useCandles(mint: string, tf: CandleTimeframe) {
  return useSWR(keys.candles(mint, tf), () => api.candles(mint, tf), { revalidateOnFocus: false, keepPreviousData: true });
}

export function useTradesPages(mint: string, pageSize = 30) {
  return useSWRInfinite(
    (index, previous: Page<Trade> | null) => {
      if (previous && !previous.nextCursor) return null;
      return ["trades", mint, pageSize, index === 0 ? null : (previous?.nextCursor ?? null)] as const;
    },
    ([, m, limit, before]) => api.trades(m, { limit, before }),
    { revalidateOnFocus: false },
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
