"use client";

import type { CoinDetail } from "@holdfast/core";
import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/components/ui/cn";
import { formatMultiplier, formatShare, shortAddress } from "@/lib/format";
import { useHolders } from "@/lib/hooks/queries";

export function TopHolders({ coin, wallet }: { coin: CoinDetail; wallet: string | null }) {
  const { data, isLoading } = useHolders(coin.mint);
  const top = (data ?? []).filter((h) => h.weightedTokens > 0).slice(0, 10);
  const max = top[0]?.share ?? 1;
  return (
    <Card>
      <CardHeader title="Top holders by weight" subtitle="tokens × weight decides each payout" />
      <div className="px-4 pb-4">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-7" />
            ))}
          </div>
        ) : top.length === 0 ? (
          <p className="text-sm text-muted">No eligible holders yet.</p>
        ) : (
          <ol className="space-y-1.5">
            {top.map((h, i) => (
              <li key={h.wallet} className="relative overflow-hidden rounded-md">
                <div
                  className={cn("absolute inset-y-0 left-0 rounded-md", h.wallet === wallet ? "bg-brand/15" : "bg-surface-3/70")}
                  style={{ width: `${Math.max(6, (h.share / max) * 100)}%` }}
                />
                <div className="relative flex items-center gap-2 px-2 py-1.5 text-xs">
                  <span className="w-4 text-faint tabular">{i + 1}</span>
                  <Link href={`/profile?wallet=${h.wallet}`} className="min-w-0 flex-1 truncate font-mono text-muted hover:text-fg">
                    {shortAddress(h.wallet)}
                    {h.wallet === wallet ? <span className="ml-1 font-sans font-bold text-brand">you</span> : null}
                  </Link>
                  <span className="text-faint tabular">{formatMultiplier(h.weightMultiplier)}</span>
                  <span className="w-14 text-right font-semibold text-fg tabular">{formatShare(h.share)}</span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}
