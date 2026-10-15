"use client";

import type { CandleTimeframe, CandlesResponse, CoinDetail, Trade } from "@holdfast/core";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { cn } from "@/components/ui/cn";
import { api } from "@/lib/api";
import { applyTrade, bucketMs, defendMarkers, fillGaps, floorSeries } from "@/lib/chart";
import { useCoinChannel, useEvery, useWsState } from "@/lib/hooks/live";
import { keys, LIVE_FALLBACK_POLL_MS, useCandles, useIsCached, usePatchCache } from "@/lib/hooks/queries";
import { useStoredState } from "@/lib/hooks/useStoredState";
import { getWsClient } from "@/lib/ws";

const CandleChart = dynamic(() => import("./CandleChart"), {
  ssr: false,
  loading: () => <div className="size-full animate-pulse rounded-lg bg-surface-2/60" />,
});

const TIMEFRAMES: CandleTimeframe[] = ["1m", "5m", "15m", "1h"];
const isTf = (v: unknown): v is CandleTimeframe => typeof v === "string" && (TIMEFRAMES as string[]).includes(v);

/** While the socket is open, refetch this often anyway in case a push went missing. */
const SAFETY_RESYNC_MS = 60_000;

/**
 * Fold a live trade into a candles response. `countVolume` is off when replaying trades onto a fresh
 * response that may already include them (price is idempotent enough, volume is not); `late` trades are
 * older than one already applied, so they must not move the close.
 */
function foldTrade(current: CandlesResponse, trade: Trade, countVolume = true, late = false): CandlesResponse {
  const next = applyTrade(current.candles, countVolume ? trade : { ...trade, sol: 0 }, current.tf, late);
  if (!next) return current;
  const defends =
    trade.side === "vault" && !current.defends.some((d) => d.sig === trade.sig)
      ? [...current.defends, { t: trade.ts, price: trade.price, solSpent: trade.sol, sig: trade.sig }]
      : current.defends;
  return { ...current, candles: next.candles, defends };
}

/** Server time (from the socket's pongs), refreshed at every bucket boundary so a new candle opens on time. */
function useBucketNow(tf: CandleTimeframe): number {
  const size = bucketMs(tf);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const serverNow = () => Date.now() + getWsClient().serverOffsetMs;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(
        () => {
          setNow(serverNow());
          arm();
        },
        size - (serverNow() % size) + 50,
      );
    };
    setNow(serverNow());
    arm();
    return () => clearTimeout(timer);
  }, [size]);
  return now;
}

export function ChartCard({ coin }: { coin: CoinDetail }) {
  const [tf, setTf] = useStoredState<CandleTimeframe>("holdfast:chart-tf", "1m", isTf);
  const wsState = useWsState();
  const live = wsState === "open";
  const { data, error } = useCandles(coin.mint, tf, live ? 0 : LIVE_FALLBACK_POLL_MS);
  const patch = usePatchCache();
  const isCached = useIsCached();
  const now = useBucketNow(tf);
  // Trades pushed while a resync request is in flight, replayed onto its response.
  const inFlight = useRef<{ tf: CandleTimeframe; trades: Trade[] } | null>(null);
  // Newest slot applied: a trade from an older slot (delivered late) does not move the close.
  const newestSlot = useRef(0);
  useEffect(() => {
    newestSlot.current = 0;
  }, [coin.mint]);

  const resync = useCallback(async () => {
    const key = keys.candles(coin.mint, tf);
    // Not loaded yet: SWR's first fetch is on its way. Already resyncing this timeframe: that one will do.
    if (!isCached(key) || inFlight.current?.tf === tf) return;
    const pending = { tf, trades: [] as Trade[] };
    inFlight.current = pending;
    try {
      // Fetched outside SWR: its own revalidation is dropped whenever a live patch lands mid-request.
      const fresh = await api.candles(coin.mint, tf);
      let newest = 0;
      patch<CandlesResponse>(key, () =>
        pending.trades.reduce((acc, t) => {
          const late = (t.slot ?? Infinity) < newest;
          newest = Math.max(newest, t.slot ?? 0);
          return foldTrade(acc, t, false, late);
        }, fresh),
      );
    } catch {
      // the next resync or the fallback poll catches up
    } finally {
      if (inFlight.current === pending) inFlight.current = null;
    }
  }, [coin.mint, tf, patch, isCached]);

  useCoinChannel(coin.mint, {
    onTrade: (trade) => {
      inFlight.current?.trades.push(trade);
      const late = trade.slot !== undefined && trade.slot < newestSlot.current;
      if (!late && trade.slot !== undefined) newestSlot.current = trade.slot;
      // Every loaded timeframe, so switching back does not show a stale one.
      for (const t of TIMEFRAMES) patch<CandlesResponse>(keys.candles(coin.mint, t), (current) => foldTrade(current, trade, true, late));
    },
    onVault: (vault) => {
      if (!(vault.floorPrice > 0)) return;
      for (const t of TIMEFRAMES)
        patch<CandlesResponse>(keys.candles(coin.mint, t), (current) => {
          const last = current.floorLine[current.floorLine.length - 1];
          if (last && vault.floorPrice <= last.price) return current;
          return { ...current, floorLine: [...current.floorLine, { t: Date.now() + getWsClient().serverOffsetMs, price: vault.floorPrice }] };
        });
    },
    onResync: () => void resync(),
  });
  useEvery(SAFETY_RESYNC_MS, live, () => void resync());
  // Back on a timeframe that was loaded before: bring it up to date.
  useEffect(() => {
    void resync();
  }, [resync]);

  // While a new timeframe loads, the previous one stays on screen (keepPreviousData), so derive from data.tf.
  const derived = useMemo(() => {
    if (!data) return null;
    const candles = fillGaps(data.candles, data.tf, now);
    return {
      candles,
      floor: floorSeries(candles, data.floorLine, data.tf, coin.vault.floorPrice),
      markers: defendMarkers(candles, data.defends, data.tf),
    };
  }, [data, now, coin.vault.floorPrice]);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3.5 pb-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span
            className={cn("flex items-center gap-1.5 font-semibold", live ? "text-buy" : "text-payout")}
            title={live ? "Trades appear as they land" : "Reconnecting: the chart refreshes every few seconds meanwhile"}
          >
            <span className={cn("size-1.5 rounded-full bg-current", live && "animate-pulse-soft")} />
            {live ? "Live" : "Connecting"}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded bg-floor" /> Floor
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0 w-4 border-t border-dotted border-ath" /> ATH
          </span>
          <span className="flex items-center gap-1.5">
            <span className="font-bold text-vault">V</span> Vault buyback
          </span>
        </div>
        <Segmented ariaLabel="Timeframe" size="sm" value={tf} onChange={setTf} options={TIMEFRAMES.map((t) => ({ value: t, label: t }))} />
      </div>
      <div className="h-[300px] px-1 pb-2 sm:h-[400px]">
        {error && !data ? (
          <div className="flex size-full items-center justify-center text-sm text-muted">Chart unavailable</div>
        ) : data && derived ? (
          <CandleChart
            candles={derived.candles}
            floor={derived.floor}
            markers={derived.markers}
            athPrice={coin.vault.athPrice}
            datasetKey={`${coin.mint}:${data.tf}`}
          />
        ) : (
          <div className="size-full animate-pulse rounded-lg bg-surface-2/60" />
        )}
      </div>
    </Card>
  );
}
