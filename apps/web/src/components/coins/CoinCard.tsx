"use client";

import type { CoinSummary } from "@holdfast/core";
import Link from "next/link";
import { ChangePct, TriggerBadge, VaultBuyingBadge } from "@/components/coin/CoinBadges";
import { CoinAvatar } from "@/components/coin/CoinAvatar";
import { CurveProgress } from "@/components/coin/CurveProgress";
import { FloorAthBar } from "@/components/coin/FloorAthBar";
import { WatchButton } from "@/components/coin/WatchButton";
import { cn } from "@/components/ui/cn";
import { useMoney } from "@/lib/currency";
import { formatAgo, formatCompact } from "@/lib/format";

export function CoinCard({ coin, now }: { coin: CoinSummary; now: number }) {
  const money = useMoney();
  return (
    <Link
      href={`/coin/${coin.mint}`}
      className={cn(
        "group flex flex-col gap-3 rounded-card border bg-surface p-3.5 shadow-card transition-all duration-150 hover:-translate-y-0.5 hover:bg-surface-2",
        coin.vaultBuying ? "border-floor/35 hover:border-floor/60" : "border-line hover:border-line-strong",
      )}
    >
      <div className="flex gap-3">
        <CoinAvatar mint={coin.mint} imageUrl={coin.imageUrl} name={coin.name} className="size-[68px]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-semibold tracking-tight text-fg">{coin.name}</div>
              <div className="flex items-center gap-1.5 text-xs text-muted">
                <span className="font-semibold text-fg/80">${coin.ticker}</span>
                <span className="text-faint">·</span>
                <span>{formatAgo(coin.createdAt, now)}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {coin.vaultBuying ? <VaultBuyingBadge /> : <TriggerBadge triggerBps={coin.triggerBps} />}
              <WatchButton mint={coin.mint} ticker={coin.ticker} className="size-6" size={15} />
            </div>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-[11px] font-medium text-faint uppercase">MC</span>
            <span className="font-semibold text-fg tabular">{money.mc(coin.marketCapSol)}</span>
            <ChangePct value={coin.change24hPct} className="text-xs" />
          </div>
        </div>
      </div>
      <FloorAthBar progress={coin.floorToAthProgress} vaultBuying={coin.vaultBuying} />
      <CurveProgress progress={coin.bondingCurveProgress} graduated={coin.graduated} />
      <dl className="grid grid-cols-3 gap-2 border-t border-line pt-2.5 text-xs">
        <div className="min-w-0">
          <dt className="text-faint">Vault</dt>
          <dd className="truncate font-semibold text-floor tabular">{money.sol(coin.vault.floorSol)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-faint">Holders</dt>
          <dd className="truncate font-semibold text-fg tabular">{formatCompact(coin.holders, 0)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-faint">Paid out</dt>
          <dd className="truncate font-semibold text-payout tabular">{money.sol(coin.paidOutSol)}</dd>
        </div>
      </dl>
    </Link>
  );
}

export function CoinCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-3.5">
      <div className="flex gap-3">
        <div className="size-[68px] animate-pulse rounded-xl bg-surface-3" />
        <div className="flex-1 space-y-2 pt-1">
          <div className="h-4 w-2/3 animate-pulse rounded bg-surface-3" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-surface-3" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-surface-3" />
        </div>
      </div>
      <div className="h-1.5 animate-pulse rounded-full bg-surface-3" />
      <div className="h-8 animate-pulse rounded bg-surface-3" />
    </div>
  );
}
