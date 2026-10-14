"use client";

import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/components/ui/cn";
import { CoinsIcon, RocketIcon, ShieldIcon, VaultIcon } from "@/components/ui/icons";
import { useMoney } from "@/lib/currency";
import { formatCompact } from "@/lib/format";
import { useLiveStats } from "@/lib/hooks/live";

function StatCard({ label, value, sub, icon, tone }: { label: string; value: ReactNode; sub: ReactNode; icon: ReactNode; tone: string }) {
  return (
    <div className="relative overflow-hidden rounded-card border border-line bg-surface p-3.5 shadow-card sm:p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-semibold tracking-wider text-muted uppercase">{label}</span>
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", tone)}>{icon}</span>
      </div>
      <div className="mt-1.5 truncate text-xl font-semibold tracking-tight text-fg tabular sm:text-2xl">{value}</div>
      <div className="mt-0.5 truncate text-xs text-muted">{sub}</div>
    </div>
  );
}

export function StatCards() {
  const { data } = useLiveStats();
  const money = useMoney();
  const loading = <Skeleton className="h-7 w-24" />;
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <StatCard
        label="Coins launched"
        value={data ? formatCompact(data.coins, 0) : loading}
        sub="Creators earn 15% of fees"
        icon={<RocketIcon size={15} />}
        tone="bg-fg/8 text-fg"
      />
      <StatCard
        label="In floor vaults"
        value={data ? money.sol(data.totalVaultSol) : loading}
        sub="Defending floors"
        icon={<VaultIcon size={15} />}
        tone="bg-floor/12 text-floor"
      />
      <StatCard
        label="Paid to holders"
        value={data ? money.sol(data.totalPaidSol) : loading}
        sub="Every 2 minutes"
        icon={<CoinsIcon size={15} />}
        tone="bg-payout/12 text-payout"
      />
      <StatCard
        label="Buybacks 24h"
        value={data ? formatCompact(data.defends24h, 0) : loading}
        sub={data ? `Volume ${money.sol(data.volume24hSol)}` : "Volume –"}
        icon={<ShieldIcon size={15} />}
        tone="bg-vault/14 text-vault"
      />
    </div>
  );
}
