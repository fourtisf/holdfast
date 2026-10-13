"use client";

import type { Candle } from "@holdfast/core";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  TickMarkType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { DefendMarker, LinePoint } from "@/lib/chart";
import { formatPrice } from "@/lib/format";

export interface CandleChartProps {
  candles: Candle[];
  floor: LinePoint[];
  markers: DefendMarker[];
  athPrice: number;
  /** Changes whenever the data set is replaced (coin or timeframe), so the view is refit. */
  datasetKey: string;
}

function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ts = (t: Time) => new Date((t as number) * 1000);

function toBar(c: Candle) {
  return { time: (c.t / 1000) as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c };
}

export default function CandleChart({ candles, floor, markers, athPrice, datasetKey }: CandleChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<{
    candles: ISeriesApi<"Candlestick">;
    volume: ISeriesApi<"Histogram">;
    floor: ISeriesApi<"Line">;
    markers: ISeriesMarkersPluginApi<Time>;
    ath: IPriceLine | null;
  } | null>(null);
  const loaded = useRef<{ key: string; first: number; length: number } | null>(null);
  const colors = useRef({ up: "#2ed47a", down: "#ff4d6a", floor: "#ffb547", ath: "#66c8ff", vault: "#a493ff" });

  useEffect(() => {
    if (!container.current) return;
    const c = {
      up: token("--chart-up", "#2ed47a"),
      down: token("--chart-down", "#ff4d6a"),
      floor: token("--color-floor", "#ffb547"),
      ath: token("--color-ath", "#66c8ff"),
      vault: token("--color-vault", "#a493ff"),
    };
    colors.current = c;
    const grid = token("--color-line", "#222734");
    const text = token("--color-muted", "#949bad");
    const api = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: text,
        fontSize: 11,
        attributionLogo: false,
        fontFamily: "var(--font-sans), system-ui, sans-serif",
      },
      grid: { vertLines: { color: `${grid}80` }, horzLines: { color: `${grid}80` } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: grid, scaleMargins: { top: 0.12, bottom: 0.22 } },
      timeScale: {
        borderColor: grid,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        maxBarSpacing: 22,
        tickMarkFormatter: (time: Time, type: TickMarkType) => {
          const d = ts(time);
          if (type === TickMarkType.DayOfMonth || type === TickMarkType.Month || type === TickMarkType.Year) return `${d.getDate()}/${d.getMonth() + 1}`;
          return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        },
      },
      localization: {
        priceFormatter: (p: number) => (p <= 0 ? "" : formatPrice(p)),
        timeFormatter: (time: Time) => {
          const d = ts(time);
          return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        },
      },
    });
    const priceFormat = { type: "custom" as const, minMove: 1e-13, formatter: (p: number) => (p <= 0 ? "" : formatPrice(p)) };
    const candleSeries = api.addSeries(CandlestickSeries, {
      upColor: c.up,
      downColor: c.down,
      wickUpColor: c.up,
      wickDownColor: c.down,
      borderVisible: false,
      priceFormat,
    });
    const volume = api.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    api.priceScale("volume").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    const floorSeries = api.addSeries(LineSeries, {
      color: c.floor,
      lineWidth: 2,
      lineType: LineType.WithSteps,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "Floor",
      crosshairMarkerVisible: false,
      priceFormat,
    });
    const markersApi = createSeriesMarkers(candleSeries, [], { zOrder: "top" });
    chart.current = api;
    series.current = { candles: candleSeries, volume, floor: floorSeries, markers: markersApi, ath: null };
    return () => {
      api.remove();
      chart.current = null;
      series.current = null;
      loaded.current = null;
    };
  }, []);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const c = colors.current;
    const volumeBar = (k: Candle) => ({ time: (k.t / 1000) as UTCTimestamp, value: k.v, color: k.c >= k.o ? `${c.up}55` : `${c.down}55` });
    const prev = loaded.current;
    const first = candles[0]?.t ?? 0;
    const incremental = prev && prev.key === datasetKey && prev.first === first && candles.length - prev.length >= 0 && candles.length - prev.length <= 1;
    const last = candles[candles.length - 1];
    if (incremental && last) {
      s.candles.update(toBar(last));
      s.volume.update(volumeBar(last));
    } else {
      s.candles.setData(candles.map(toBar));
      s.volume.setData(candles.map(volumeBar));
      chart.current?.timeScale().fitContent();
      const visible = Math.max(40, Math.floor((container.current?.clientWidth ?? 600) / 6));
      if (candles.length > visible) chart.current?.timeScale().setVisibleLogicalRange({ from: candles.length - visible, to: candles.length + 4 });
    }
    loaded.current = { key: datasetKey, first, length: candles.length };
  }, [candles, datasetKey]);

  useEffect(() => {
    series.current?.floor.setData(floor.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
  }, [floor]);

  useEffect(() => {
    const c = colors.current;
    series.current?.markers.setMarkers(
      markers.map((m) => ({
        time: m.time as UTCTimestamp,
        position: "belowBar" as const,
        shape: "arrowUp" as const,
        color: c.vault,
        text: "V",
        size: Math.min(2, 1 + (m.count - 1) * 0.35),
      })),
    );
  }, [markers]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    if (s.ath) s.candles.removePriceLine(s.ath);
    s.ath =
      athPrice > 0
        ? s.candles.createPriceLine({
            price: athPrice,
            color: colors.current.ath,
            lineStyle: LineStyle.Dotted,
            lineWidth: 1,
            axisLabelVisible: true,
            title: "ATH",
          })
        : null;
  }, [athPrice]);

  return <div ref={container} className="size-full" />;
}
