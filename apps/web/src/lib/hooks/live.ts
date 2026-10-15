"use client";

import {
  floorToAthProgress,
  marketCapSol,
  type CoinDetail,
  type LaunchStatus,
  type RoundSummary,
  type Stats,
  type Trade,
  type VaultSnapshot,
} from "@holdfast/core";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSWRConfig } from "swr";
import { api } from "../api";
import { getWsClient, type ConnectionState } from "../ws";
import { keys, usePatchCache, useStats } from "./queries";

export function useWsState(): ConnectionState {
  return useSyncExternalStore(
    (cb) => getWsClient().onStateChange(cb),
    () => getWsClient().state,
    () => "idle",
  );
}

export interface CoinChannelHandlers {
  onTrade?: (trade: Trade) => void;
  onVault?: (vault: VaultSnapshot) => void;
  onRound?: (round: RoundSummary) => void;
  /**
   * Live messages may have been missed: the socket (re)opened, or the server's change feed reconnected.
   * Refetch whatever the other handlers keep up to date.
   */
  onResync?: () => void;
}

/**
 * Subscribe to a coin's `trades` channel (which also carries `vault`, `round` and `resync` messages).
 * Resyncs are spread over a random delay (every open tab gets the server's `resync` at the same moment)
 * and merged while one is pending.
 */
export function useCoinChannel(mint: string | null, handlers: CoinChannelHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!mint) return;
    const client = getWsClient();
    let pending: ReturnType<typeof setTimeout> | null = null;
    const resyncWithin = (maxDelayMs: number) => {
      if (pending || !ref.current.onResync) return;
      pending = setTimeout(() => {
        pending = null;
        ref.current.onResync?.();
      }, Math.random() * maxDelayMs);
    };
    const off = client.subscribe({ channel: "trades", mint }, (msg) => {
      if (msg.channel === "trades") ref.current.onTrade?.(msg.data);
      else if (msg.channel === "vault") ref.current.onVault?.(msg.data);
      else if (msg.channel === "round") ref.current.onRound?.(msg.data);
      else if (msg.channel === "resync") resyncWithin(5_000);
    });
    const offOpen = client.onOpen(() => resyncWithin(1_500));
    return () => {
      off();
      offOpen();
      if (pending) clearTimeout(pending);
    };
  }, [mint]);
}

/**
 * Run `fn` every `ms` while `enabled` (a safety-net resync for anything a live view might have missed).
 * Hidden tabs skip it and run it once when they become visible again.
 */
export function useEvery(ms: number, enabled: boolean, fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let missed = false;
    const id = setInterval(() => {
      if (document.visibilityState === "hidden") missed = true;
      else ref.current();
    }, ms);
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !missed) return;
      missed = false;
      ref.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ms, enabled]);
}

function withPrice(coin: CoinDetail, price: number): CoinDetail {
  const { floorPrice, athPrice } = coin.vault;
  return {
    ...coin,
    price,
    marketCapSol: marketCapSol(price),
    floorToAthProgress: floorToAthProgress(price, floorPrice, athPrice),
    vaultBuying: floorPrice > 0 && price <= floorPrice,
  };
}

/** Keep the cached CoinDetail (price, vault, round) in step with the live channel. */
export function useCoinLive(mint: string, wallet: string | null) {
  const { mutate } = useSWRConfig();
  const patch = usePatchCache();
  const live = useWsState() === "open";
  // Newest slot applied: a trade delivered late (older slot) must not roll the price back.
  const newestSlot = useRef(0);
  useEffect(() => {
    newestSlot.current = 0;
  }, [mint]);
  // Fetched directly: SWR drops its own revalidation (useCoin's refresh) when a live patch lands mid-request.
  const resync = () => {
    api.coin(mint).then(
      (fresh) => patch<CoinDetail>(keys.coin(mint), () => fresh),
      () => {},
    );
  };
  useEvery(60_000, live, resync);
  useCoinChannel(mint, {
    onResync: resync,
    onTrade: (trade) => {
      if (trade.slot !== undefined) {
        if (trade.slot < newestSlot.current) return;
        newestSlot.current = trade.slot;
      }
      patch<CoinDetail>(keys.coin(mint), (coin) => withPrice(coin, trade.price));
    },
    onVault: (vault) =>
      patch<CoinDetail>(keys.coin(mint), (coin) =>
        withPrice({ ...coin, vault, athMarketCapSol: marketCapSol(vault.athPrice), floorMarketCapSol: marketCapSol(vault.floorPrice) }, coin.price),
      ),
    onRound: (round) => {
      patch<CoinDetail>(keys.coin(mint), (coin) => ({ ...coin, roundId: round.roundId, lastRound: round, paidOutSol: coin.paidOutSol + round.solPot }));
      void mutate(keys.holders(mint));
      if (wallet) void mutate(keys.position(wallet, mint));
    },
  });
}

const TERMINAL: LaunchStatus["status"][] = ["live", "refunded", "expired", "failed"];

/** Launch progress: pushed over the `deposit-status` channel, polled every 3s whenever the socket is down. */
export function useDepositStatus(launchId: string | null): LaunchStatus | null {
  const [status, setStatus] = useState<LaunchStatus | null>(null);
  const wsState = useWsState();
  const accept = useCallback((next: LaunchStatus) => {
    setStatus((prev) => (!prev || prev.launchId !== next.launchId || next.updatedAt >= prev.updatedAt ? next : prev));
  }, []);

  useEffect(() => {
    setStatus(null);
    if (!launchId) return;
    return getWsClient().subscribe({ channel: "deposit-status", launchId }, (msg) => {
      if (msg.channel === "deposit-status") accept(msg.data);
    });
  }, [launchId, accept]);

  const done = status ? TERMINAL.includes(status.status) : false;
  useEffect(() => {
    if (!launchId || done) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await api.launchStatus(launchId);
        if (!cancelled) accept(s);
      } catch {
        // keep polling
      }
    };
    void poll();
    const id = setInterval(poll, wsState === "open" ? 15_000 : 3_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [launchId, done, wsState, accept]);

  return status;
}

/** Stat cards: REST snapshot refreshed by the `stats` channel. */
export function useLiveStats() {
  const query = useStats();
  const { mutate } = query;
  useEffect(
    () =>
      getWsClient().subscribe({ channel: "stats" }, (msg) => {
        if (msg.channel === "stats") void mutate(msg.data as Stats, { revalidate: false });
      }),
    [mutate],
  );
  return query;
}
