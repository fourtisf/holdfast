"use client";

import type { CandleTimeframe, CandlesResponse, CoinDetail } from "@holdfast/core";
import dynamic from "next/dynamic";
import { useMemo } from "react";
import { Card } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { applyTrade, defendMarkers, floorSeries } from "@/lib/chart";
import { useCoinChannel } from "@/lib/hooks/live";
import { keys, useCandles, usePatchCache } from "@/lib/hooks/queries";
import { useStoredState } from "@/lib/hooks/useStoredState";

const CandleChart = dynamic(() => import("./CandleChart"), {
  ssr: false,
  loading: () => <div className="size-full animate-pulse rounded-lg bg-surface-2/60" />,
});

const TIMEFRAMES: CandleTimeframe[] = ["1m", "5m", "15m", "1h"];
const isTf = (v: unknown): v is CandleTimeframe => typeof v === "string" && (TIMEFRAMES as string[]).includes(v);

export function ChartCard({ coin }: { coin: CoinDetail }) {
  const [tf, setTf] = useStoredState<CandleTimeframe>("holdfast:chart-tf", "5m", isTf);
  const { data, error } = useCandles(coin.mint, tf);
  const patch = usePatchCache();

  useCoinChannel(coin.mint, {
    onTrade: (trade) =>
      patch<CandlesResponse>(keys.candles(coin.mint, tf), (current) => {
        const next = applyTrade(current.candles, trade, current.tf);
        if (!next) return current;
        const defends =
          trade.side === "vault" ? [...current.defends, { t: trade.ts, price: trade.price, solSpent: trade.sol, sig: trade.sig }] : current.defends;
        return { ...current, candles: next.candles, defends };
      }),
    onVault: (vault) =>
      patch<CandlesResponse>(keys.candles(coin.mint, tf), (current) => {
        const last = current.floorLine[current.floorLine.length - 1];
        if (!(vault.floorPrice > 0) || (last && vault.floorPrice <= last.price)) return current;
        return { ...current, floorLine: [...current.floorLine, { t: Date.now(), price: vault.floorPrice }] };
      }),
  });

  // While a new timeframe loads, the previous one stays on screen (keepPreviousData), so derive from data.tf.
  const derived = useMemo(() => {
    if (!data) return null;
    return {
      floor: floorSeries(data.candles, data.floorLine, data.tf, coin.vault.floorPrice),
      markers: defendMarkers(data.candles, data.defends, data.tf),
    };
  }, [data, coin.vault.floorPrice]);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3.5 pb-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
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
        {error ? (
          <div className="flex size-full items-center justify-center text-sm text-muted">Chart unavailable</div>
        ) : data && derived ? (
          <CandleChart
            candles={data.candles}
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
