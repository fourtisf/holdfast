"use client";

import type { CoinDetail, Position, TradeQuote } from "@holdfast/core";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useEffect, useState } from "react";
import { useSWRConfig } from "swr";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ErrorNote } from "@/components/ui/States";
import { cn } from "@/components/ui/cn";
import { ExternalIcon, SettingsIcon } from "@/components/ui/icons";
import { api, errorMessage } from "@/lib/api";
import { SOLANA_CLUSTER } from "@/lib/config";
import { explorerTxUrl } from "@/lib/explorer";
import { formatPct, formatSol, formatSolAmount, formatTokens, shortAddress } from "@/lib/format";
import { keys } from "@/lib/hooks/queries";
import { useDebounced } from "@/lib/hooks/useDebounced";
import { useStoredState } from "@/lib/hooks/useStoredState";
import { confirmSignature, decodeTransaction, getSolBalance } from "@/lib/solana";

type Side = "buy" | "sell";
type Phase = "idle" | "building" | "signing" | "confirming" | "done" | "error";

const BUY_PRESETS = [0.1, 0.5, 1];
const SELL_PRESETS = [25, 50, 100];
const SLIPPAGE_PRESETS = [50, 100, 200, 500];
const isBps = (v: unknown): v is number => typeof v === "number" && v > 0 && v <= 5000;

/** Priority fee: compute-unit price in micro-lamports (null = the API's default). */
type Priority = "default" | "fast" | "turbo";
const PRIORITY: Record<Priority, { label: string; microLamports: number | null }> = {
  default: { label: "Normal", microLamports: null },
  fast: { label: "Fast", microLamports: 500_000 },
  turbo: { label: "Turbo", microLamports: 2_000_000 },
};
const isPriority = (v: unknown): v is Priority => v === "default" || v === "fast" || v === "turbo";
/** ≈ SOL a priority level adds at a ~250k compute-unit trade. */
const priorityCostSol = (microLamports: number) => (microLamports * 250_000) / 1e6 / 1e9;
/** Quotes need a wallet field; before connecting, buy quotes use the system program address as a stand-in. */
const QUOTE_PLACEHOLDER_WALLET = "11111111111111111111111111111111";

function friendlyError(err: unknown): string {
  const msg = errorMessage(err);
  if (/reject|cancel|denied/i.test(msg)) return "Cancelled in wallet.";
  return msg;
}

export function TradePanel({ coin, position }: { coin: CoinDetail; position: Position | null | undefined }) {
  const { publicKey, sendTransaction, connected } = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();
  const { mutate } = useSWRConfig();
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useStoredState<number>("holdfast:slippage-bps", 200, isBps);
  const [showSlippage, setShowSlippage] = useState(false);
  const [priority, setPriority] = useStoredState<Priority>("holdfast:priority", "default", isPriority);
  const priorityMicroLamports = PRIORITY[priority].microLamports ?? undefined;
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [signature, setSignature] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);

  const wallet = publicKey?.toBase58() ?? null;
  const value = Number(amount);
  const valid = amount !== "" && Number.isFinite(value) && value > 0;
  const debounced = useDebounced(valid ? value : 0, 350);
  const tokenBalance = position?.tokens ?? 0;
  const busy = phase === "building" || phase === "signing" || phase === "confirming";

  useEffect(() => {
    if (!publicKey) {
      setSolBalance(null);
      return;
    }
    let cancelled = false;
    getSolBalance(connection, publicKey)
      .then((b) => !cancelled && setSolBalance(b))
      .catch(() => !cancelled && setSolBalance(null));
    return () => {
      cancelled = true;
    };
  }, [publicKey, connection, phase]);

  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!(debounced > 0) || (side === "sell" && !wallet)) return;
    const controller = new AbortController();
    setQuoting(true);
    api
      .quote({ mint: coin.mint, wallet: wallet ?? QUOTE_PLACEHOLDER_WALLET, side, amount: debounced, slippageBps }, controller.signal)
      .then((q) => setQuote(q))
      .catch((err) => {
        if (!controller.signal.aborted) setQuoteError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setQuoting(false);
      });
    return () => controller.abort();
  }, [debounced, side, slippageBps, coin.mint, wallet]);

  const switchSide = (next: Side) => {
    setSide(next);
    setAmount("");
    setPhase("idle");
    setTxError(null);
  };

  const insufficient = connected && valid && (side === "buy" ? solBalance !== null && value > solBalance : value > tokenBalance);

  const submit = async () => {
    if (!publicKey || !wallet) {
      setVisible(true);
      return;
    }
    if (!valid) return;
    setTxError(null);
    setSignature(null);
    try {
      setPhase("building");
      const built = await api.buildTrade({ mint: coin.mint, wallet, side, amount: value, slippageBps, priorityMicroLamports });
      const tx = decodeTransaction(built.transaction);
      setPhase("signing");
      const sig = await sendTransaction(tx, connection);
      setSignature(sig);
      setPhase("confirming");
      await confirmSignature(connection, sig, tx, built.lastValidBlockHeight);
      setPhase("done");
      setAmount("");
      setTimeout(() => {
        void mutate(keys.position(wallet, coin.mint));
        void mutate(keys.holders(coin.mint));
      }, 1500);
    } catch (err) {
      setTxError(friendlyError(err));
      setPhase("error");
    }
  };

  const buttonLabel = !connected
    ? "Connect wallet"
    : phase === "building"
      ? "Preparing…"
      : phase === "signing"
        ? "Approve in wallet…"
        : phase === "confirming"
          ? "Confirming…"
          : insufficient
            ? "Insufficient balance"
            : side === "buy"
              ? `Buy $${coin.ticker}`
              : `Sell $${coin.ticker}`;

  return (
    <Card className="p-4">
      <div className="grid grid-cols-2 gap-1 rounded-control bg-surface-2 p-1 ring-1 ring-line" role="radiogroup" aria-label="Trade side">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={side === s}
            onClick={() => switchSide(s)}
            className={cn(
              "h-9 rounded-[8px] text-sm font-semibold capitalize transition-colors",
              side === s ? (s === "buy" ? "bg-buy text-[#03140a]" : "bg-sell text-white") : "text-muted hover:text-fg",
            )}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between text-xs">
        <span className="text-muted">
          {side === "buy" ? "Balance" : "Holding"}:{" "}
          <span className="font-semibold text-fg tabular">
            {!connected ? "—" : side === "buy" ? (solBalance !== null ? formatSol(solBalance) : "…") : `${formatTokens(tokenBalance)} ${coin.ticker}`}
          </span>
        </span>
        <button
          type="button"
          onClick={() => setShowSlippage((v) => !v)}
          className="inline-flex items-center gap-1 text-muted hover:text-fg"
          aria-expanded={showSlippage}
        >
          <SettingsIcon size={13} />
          Slippage {formatPct(slippageBps / 100)}
          {priority !== "default" ? ` · ${PRIORITY[priority].label}` : ""}
        </button>
      </div>

      {showSlippage ? (
        <div className="mt-2 flex items-center gap-1.5 rounded-control bg-surface-2 p-2 ring-1 ring-line">
          {SLIPPAGE_PRESETS.map((bps) => (
            <button
              key={bps}
              type="button"
              onClick={() => setSlippageBps(bps)}
              className={cn("h-7 flex-1 rounded-md text-xs font-semibold", slippageBps === bps ? "bg-fg text-bg" : "bg-surface-3 text-muted hover:text-fg")}
            >
              {bps / 100}%
            </button>
          ))}
          <label className="relative flex-1">
            <input
              type="number"
              inputMode="decimal"
              min={0.1}
              max={50}
              step={0.1}
              aria-label="Custom slippage percent"
              placeholder="Custom"
              onChange={(e) => {
                const pct = Number(e.target.value);
                if (pct > 0 && pct <= 50) setSlippageBps(Math.round(pct * 100));
              }}
              className="h-7 w-full rounded-md bg-surface-3 pr-5 pl-2 text-xs text-fg placeholder:text-faint focus:outline-none"
            />
            <span className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 text-[10px] text-faint">%</span>
          </label>
        </div>
      ) : null}
      {showSlippage ? (
        <div className="mt-1.5 rounded-control bg-surface-2 p-2 ring-1 ring-line">
          <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-faint uppercase">Priority fee</div>
          <div className="flex items-center gap-1.5">
            {(Object.keys(PRIORITY) as Priority[]).map((p) => {
              const micro = PRIORITY[p].microLamports;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  title={micro === null ? "The API's default compute-unit price" : `≈ ${formatSolAmount(priorityCostSol(micro))} SOL extra`}
                  className={cn("h-7 flex-1 rounded-md text-xs font-semibold", priority === p ? "bg-fg text-bg" : "bg-surface-3 text-muted hover:text-fg")}
                >
                  {PRIORITY[p].label}
                </button>
              );
            })}
          </div>
          {priority !== "default" ? (
            <p className="mt-1.5 text-[11px] text-faint">
              ≈ {formatSolAmount(priorityCostSol(PRIORITY[priority].microLamports!))} SOL extra per trade, to land faster when the network is busy.
            </p>
          ) : null}
        </div>
      ) : null}

      <label className="mt-2 flex h-14 items-center rounded-control border border-line-strong bg-surface-2 px-3 focus-within:border-faint">
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            if (phase === "done" || phase === "error") setPhase("idle");
          }}
          placeholder="0.00"
          aria-label={side === "buy" ? "Amount in SOL" : `Amount in ${coin.ticker}`}
          className="min-w-0 flex-1 bg-transparent text-xl font-semibold text-fg tabular placeholder:text-faint focus:outline-none"
        />
        <span className="ml-2 shrink-0 text-sm font-semibold text-muted">{side === "buy" ? "SOL" : coin.ticker}</span>
      </label>

      <div className="mt-2 grid grid-cols-4 gap-1.5">
        {side === "buy" ? (
          <>
            <button type="button" onClick={() => setAmount("")} className="h-8 rounded-md bg-surface-3 text-xs font-semibold text-muted hover:text-fg">
              Reset
            </button>
            {BUY_PRESETS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setAmount(String(v))}
                className="h-8 rounded-md bg-surface-3 text-xs font-semibold text-fg hover:bg-line-strong"
              >
                {v} SOL
              </button>
            ))}
          </>
        ) : (
          <>
            <button type="button" onClick={() => setAmount("")} className="h-8 rounded-md bg-surface-3 text-xs font-semibold text-muted hover:text-fg">
              Reset
            </button>
            {SELL_PRESETS.map((pct) => (
              <button
                key={pct}
                type="button"
                disabled={!(tokenBalance > 0)}
                onClick={() => setAmount(String(Math.floor(((tokenBalance * pct) / 100) * 1e6) / 1e6))}
                className="h-8 rounded-md bg-surface-3 text-xs font-semibold text-fg hover:bg-line-strong disabled:opacity-40"
              >
                {pct}%
              </button>
            ))}
          </>
        )}
      </div>

      <dl className="mt-3 space-y-1.5 rounded-control bg-surface-2/70 p-3 text-xs ring-1 ring-line">
        <div className="flex justify-between gap-2">
          <dt className="text-muted">You receive</dt>
          <dd className={cn("font-semibold text-fg tabular", quoting && "opacity-50")}>
            {quote ? (side === "buy" ? `${formatTokens(quote.expectedOut)} ${coin.ticker}` : formatSol(quote.expectedOut)) : "—"}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted">Minimum ({formatPct(slippageBps / 100)} slippage)</dt>
          <dd className="text-fg tabular">{quote ? (side === "buy" ? `${formatTokens(quote.minOut)} ${coin.ticker}` : formatSol(quote.minOut)) : "—"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted">Price impact</dt>
          <dd className={cn("tabular", quote && quote.priceImpactPct > 5 ? "text-sell" : "text-fg")}>{quote ? formatPct(quote.priceImpactPct) : "—"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted">Fee · route</dt>
          <dd className="text-fg tabular">
            {quote
              ? `${formatSolAmount(quote.feeSol)} SOL · ${quote.venue === "curve" ? "Bonding curve" : "PumpSwap"}`
              : coin.graduated
                ? "PumpSwap"
                : "Bonding curve"}
          </dd>
        </div>
      </dl>
      {quoteError ? <ErrorNote className="mt-2 text-xs">{quoteError}</ErrorNote> : null}

      <Button
        variant={!connected ? "primary" : side === "buy" ? "buy" : "sell"}
        size="lg"
        className="mt-3 w-full"
        onClick={submit}
        disabled={connected && (busy || !valid || insufficient)}
      >
        {buttonLabel}
      </Button>

      {side === "buy" ? (
        <p className="mt-2.5 text-center text-[11px] leading-snug text-muted">Bought tokens start at 0.1× weight and reach 1.0× after 7 days.</p>
      ) : (
        <p className="mt-2.5 text-center text-[11px] leading-snug text-muted">Selling uses your oldest lots first. Selling everything resets your weight.</p>
      )}

      {signature && (phase === "confirming" || phase === "done") ? (
        <div
          className={cn(
            "mt-3 rounded-control px-3 py-2 text-xs ring-1",
            phase === "done" ? "bg-buy/10 text-buy ring-buy/25" : "bg-surface-2 text-muted ring-line",
          )}
        >
          <div className="font-semibold">{phase === "done" ? "Trade confirmed" : "Submitted, waiting for confirmation…"}</div>
          <a
            href={explorerTxUrl(signature, SOLANA_CLUSTER)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 inline-flex items-center gap-1 font-mono text-fg/80 hover:text-fg"
          >
            {shortAddress(signature, 8)}
            <ExternalIcon size={12} />
          </a>
        </div>
      ) : null}
      {phase === "error" && txError ? <ErrorNote className="mt-3 text-xs">{txError}</ErrorNote> : null}
    </Card>
  );
}
