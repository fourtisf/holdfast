"use client";

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { formatMarketCap, formatSol, formatUsd } from "./format";
import { useStats } from "./hooks/queries";
import { useStoredState } from "./hooks/useStoredState";

export type Currency = "sol" | "usd";
const isCurrency = (v: unknown): v is Currency => v === "sol" || v === "usd";

interface CurrencyValue {
  currency: Currency;
  setCurrency: (c: Currency) => void;
  /** SOL/USD from the API's price feed; null while unknown (USD mode then falls back to SOL). */
  solUsd: number | null;
}

const CurrencyContext = createContext<CurrencyValue>({ currency: "sol", setCurrency: () => {}, solUsd: null });

/** The SOL / USD display toggle, remembered per browser. Amounts stay SOL everywhere in the API. */
export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrency] = useStoredState<Currency>("holdfast:currency", "sol", isCurrency);
  const { data } = useStats();
  const value = useMemo(() => ({ currency, setCurrency, solUsd: data?.solUsd ?? null }), [currency, setCurrency, data?.solUsd]);
  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrency(): CurrencyValue {
  return useContext(CurrencyContext);
}

/** Formatters that follow the toggle: `sol(0.5)` → "0.5 SOL" or "$76.10". */
export function useMoney() {
  const { currency, solUsd } = useCurrency();
  const usd = currency === "usd" && solUsd !== null ? solUsd : null;
  const sol = useCallback((valueSol: number) => (usd !== null ? formatUsd(valueSol * usd) : formatSol(valueSol)), [usd]);
  const mc = useCallback((valueSol: number) => (usd !== null ? formatUsd(valueSol * usd) : formatMarketCap(valueSol)), [usd]);
  return { sol, mc, usd: usd !== null };
}

export function CurrencyToggle({ className }: { className?: string }) {
  const { currency, setCurrency, solUsd } = useCurrency();
  const next: Currency = currency === "sol" ? "usd" : "sol";
  return (
    <button
      type="button"
      onClick={() => setCurrency(next)}
      disabled={solUsd === null && currency === "sol"}
      title={solUsd === null ? "USD price unavailable" : `1 SOL = ${formatUsd(solUsd)} · show amounts in ${next.toUpperCase()}`}
      className={
        // display comes from `className` (default inline-flex) so callers can hide it per breakpoint
        "h-[38px] items-center gap-1 rounded-control border border-line-strong px-2.5 text-xs font-bold tracking-wide text-fg transition-colors hover:bg-surface-2 disabled:opacity-50 " +
        (className ?? "inline-flex")
      }
      aria-label={`Show amounts in ${next.toUpperCase()}`}
    >
      <span className={currency === "sol" ? "text-brand" : "text-faint"}>SOL</span>
      <span className="text-faint">/</span>
      <span className={currency === "usd" ? "text-brand" : "text-faint"}>USD</span>
    </button>
  );
}
