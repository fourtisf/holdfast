"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect } from "react";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/States";
import { ApiError, errorMessage } from "@/lib/api";
import { useCoinLive } from "@/lib/hooks/live";
import { useCoin, usePosition } from "@/lib/hooks/queries";
import { ActivityTabs } from "./ActivityTabs";
import { ChartCard } from "./ChartCard";
import { CoinHeader, MarketCapCard } from "./CoinHeader";
import { CreatorClaimCard } from "./CreatorClaimCard";
import { SharePanel } from "./SharePanel";
import { TopHolders } from "./TopHolders";
import { TradePanel } from "./TradePanel";
import { VaultPanel } from "./VaultPanel";

/**
 * Desktop: content column + 360px side column. Mobile: one column where the side panels are
 * interleaved (trade right after the chart) via `contents` + `order`.
 */
export function CoinPageView({ mint }: { mint: string }) {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const { data: coin, error, isLoading } = useCoin(mint);
  const position = usePosition(wallet, mint);
  useCoinLive(mint, wallet);

  useEffect(() => {
    if (coin) document.title = `${coin.name} ($${coin.ticker}) · Moatpad`;
  }, [coin]);

  if (error && !coin) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <Card>
        <EmptyState
          title={missing ? "Coin not found" : "Could not load this coin"}
          body={missing ? "This mint isn't a Moatpad coin, or it hasn't been indexed yet." : errorMessage(error)}
          action={<ButtonLink href="/">Back to coins</ButtonLink>}
        />
      </Card>
    );
  }

  if (isLoading || !coin) return <CoinPageSkeleton />;

  return (
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-4">
        <div className="order-1">
          <CoinHeader coin={coin} />
        </div>
        <div className="order-2">
          <MarketCapCard coin={coin} />
        </div>
        <div className="order-3">
          <ChartCard coin={coin} />
        </div>
        <div className="order-6">
          <ActivityTabs coin={coin} wallet={wallet} />
        </div>
      </div>
      <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-4">
        <div className="order-4 flex flex-col gap-4">
          <TradePanel coin={coin} position={position.data} />
          {wallet && coin.launcher === wallet ? <CreatorClaimCard coin={coin} /> : null}
        </div>
        <div className="order-5">
          <SharePanel coin={coin} wallet={wallet} position={position.data} loading={position.isLoading} />
        </div>
        <div className="order-7">
          <VaultPanel coin={coin} />
        </div>
        <div className="order-8">
          <TopHolders coin={coin} wallet={wallet} />
        </div>
      </div>
    </div>
  );
}

function CoinPageSkeleton() {
  return (
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-[120px] rounded-card" />
        <Skeleton className="h-[110px] rounded-card" />
        <Skeleton className="h-[400px] rounded-card" />
      </div>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-[420px] rounded-card" />
        <Skeleton className="h-[260px] rounded-card" />
      </div>
    </div>
  );
}
