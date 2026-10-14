"use client";

import Link from "next/link";
import { CoinCard, CoinCardSkeleton } from "@/components/coins/CoinCard";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { EmptyState, ErrorNote } from "@/components/ui/States";
import { ExternalIcon } from "@/components/ui/icons";
import { errorMessage } from "@/lib/api";
import { SOLANA_CLUSTER } from "@/lib/config";
import { useMoney } from "@/lib/currency";
import { explorerAddressUrl } from "@/lib/explorer";
import { formatRelativeTime, shortAddress } from "@/lib/format";
import { useCreator } from "@/lib/hooks/queries";
import { useNow } from "@/lib/hooks/useNow";

function Stat({ label, value, tone = "text-fg" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-3.5">
      <div className="text-[11px] font-semibold tracking-wider text-muted uppercase">{label}</div>
      <div className={`mt-1 truncate text-xl font-semibold tracking-tight tabular ${tone}`}>{value}</div>
    </div>
  );
}

/**
 * A creator's track record. Creators earn nothing from fees on Holdfast, so the number that matters
 * is what their coins paid back to holders and how many still trade above their floor.
 */
export function CreatorView({ wallet }: { wallet: string }) {
  const { data, error, isLoading } = useCreator(wallet);
  const money = useMoney();
  const now = useNow(30_000);

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="text-[11px] font-semibold tracking-wider text-muted uppercase">Creator</div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-lg font-semibold text-fg sm:text-xl">{shortAddress(wallet, 6)}</h1>
          <CopyButton value={wallet} size={14} />
          <a href={explorerAddressUrl(wallet, SOLANA_CLUSTER)} target="_blank" rel="noopener noreferrer" className="text-faint hover:text-fg" aria-label="View on explorer">
            <ExternalIcon size={14} />
          </a>
          <Link href={`/profile?wallet=${wallet}`} className="ml-auto text-sm font-semibold text-muted hover:text-fg">
            Holdings →
          </Link>
        </div>
        {data?.firstLaunchAt ? <p className="mt-1 text-xs text-faint">First launch {formatRelativeTime(data.firstLaunchAt, now)}</p> : null}
      </Card>

      {error ? <ErrorNote>Could not load this creator: {errorMessage(error)}</ErrorNote> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Coins launched" value={data ? String(data.coinCount) : "–"} />
        <Stat label="Paid to holders" value={data ? money.sol(data.paidToHoldersSol) : "–"} tone="text-payout" />
        <Stat label="Creator fees generated" value={data ? money.sol(data.totalFeesSol) : "–"} tone="text-floor" />
        <Stat label="Above their floor" value={data ? `${data.coinsAboveFloor} / ${data.coinCount}` : "–"} tone="text-brand" />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <CoinCardSkeleton key={i} />
          ))}
        </div>
      ) : data && data.coins.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.coins.map((c) => (
            <CoinCard key={c.mint} coin={c} now={now} />
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState title="No coins launched from this wallet" body="Creators are the wallets that paid a launch deposit." />
        </Card>
      )}
    </div>
  );
}
