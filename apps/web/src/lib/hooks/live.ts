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
}

/** Subscribe to a coin's `trades` channel (which also carries `vault` and `round` messages). */
export function useCoinChannel(mint: string | null, handlers: CoinChannelHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!mint) return;
    return getWsClient().subscribe({ channel: "trades", mint }, (msg) => {
      if (msg.channel === "trades") ref.current.onTrade?.(msg.data);
      else if (msg.channel === "vault") ref.current.onVault?.(msg.data);
      else if (msg.channel === "round") ref.current.onRound?.(msg.data);
    });
  }, [mint]);
}

export function useTrades(mint: string | null, onTrade: (trade: Trade) => void) {
  useCoinChannel(mint, { onTrade });
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
  useCoinChannel(mint, {
    onTrade: (trade) => patch<CoinDetail>(keys.coin(mint), (coin) => withPrice(coin, trade.price)),
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
