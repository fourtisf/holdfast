"use client";

import type { CoinDetail, Position } from "@holdfast/core";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useRoundCountdown } from "@/components/providers/ScheduleProvider";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { CoinsIcon } from "@/components/ui/icons";
import { formatCountdown, formatDuration, formatMultiplier, formatShare, formatSol, formatTokens } from "@/lib/format";
import { useNow } from "@/lib/hooks/useNow";
import { WeightPill } from "./ActivityTabs";

const RAMP_MS = 7 * 24 * 3600 * 1000;

export function SharePanel({
  coin,
  wallet,
  position,
  loading,
}: {
  coin: CoinDetail;
  wallet: string | null;
  position: Position | null | undefined;
  loading: boolean;
}) {
  const { setVisible } = useWalletModal();
  const countdown = useRoundCountdown(1000);
  const now = useNow(30_000);

  return (
    <Card>
      <CardHeader title="Your share" icon={<CoinsIcon size={15} />} subtitle="Paid every 2 minutes by tokens × weight" />
      <div className="px-4 pb-4">
        {!wallet ? (
          <div className="rounded-control bg-surface-2 p-4 text-center ring-1 ring-line">
            <p className="text-sm text-muted">Connect a wallet to see your weight, share and payouts for ${coin.ticker}.</p>
            <Button className="mt-3" size="sm" onClick={() => setVisible(true)}>
              Connect wallet
            </Button>
          </div>
        ) : loading ? (
          <div className="space-y-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-10" />
          </div>
        ) : !position ? (
          <div className="rounded-control bg-surface-2 p-4 text-center text-sm text-muted ring-1 ring-line">
            You don&apos;t hold ${coin.ticker} yet. Buy to start earning: new lots start at 0.1× and reach 1.0× after 7 days.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-control bg-surface-2 p-3 ring-1 ring-line">
                <div className="text-[11px] text-faint">Share of next round</div>
                <div className="mt-0.5 text-lg font-semibold text-fg tabular">{formatShare(position.share)}</div>
              </div>
              <div className="rounded-control bg-surface-2 p-3 ring-1 ring-line">
                <div className="text-[11px] text-faint">Weight</div>
                <div className="mt-0.5 text-lg font-semibold text-brand tabular">{formatMultiplier(position.weightMultiplier)}</div>
              </div>
              <div className="col-span-2 rounded-control bg-payout/8 p-3 ring-1 ring-payout/20">
                <div className="flex items-center justify-between text-[11px] text-payout/90">
                  <span>Next payout estimate</span>
                  <span className="font-mono tabular">in {countdown ? formatCountdown(countdown.remainingMs) : "--:--"}</span>
                </div>
                <div className="mt-0.5 text-lg font-semibold text-payout tabular">≈ {formatSol(position.nextPayoutEstimateSol)}</div>
              </div>
            </div>
            <dl className="mt-3 space-y-1.5 text-xs">
              <div className="flex justify-between">
                <dt className="text-muted">Earning tokens</dt>
                <dd className="font-semibold text-fg tabular">
                  {formatTokens(position.eligibleTokens)}
                  {position.tokens > position.eligibleTokens * 1.001 ? (
                    <span className="font-normal text-faint"> of {formatTokens(position.tokens)}</span>
                  ) : null}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Weighted tokens</dt>
                <dd className="font-semibold text-fg tabular">{formatTokens(position.weightedTokens)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Earned so far</dt>
                <dd className="font-semibold text-payout tabular">
                  {formatSol(position.earnedSol)}
                  {position.earnedTokens > 0 ? (
                    <span className="font-normal text-muted">
                      {" "}
                      + {formatTokens(position.earnedTokens)} {coin.ticker}
                    </span>
                  ) : null}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Position value</dt>
                <dd className="font-semibold text-fg tabular">{formatSol(position.valueSol)}</dd>
              </div>
            </dl>
            {position.lots.length > 0 ? (
              <div className="mt-3">
                <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-faint uppercase">Your lots (oldest first)</div>
                <ul className="divide-y divide-line/70 rounded-control ring-1 ring-line">
                  {[...position.lots]
                    .sort((a, b) => a.acquiredAt - b.acquiredAt)
                    .map((lot) => {
                      const age = now - lot.acquiredAt;
                      return (
                        <li key={`${lot.acquiredAt}-${lot.amount}`} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                          <div className="min-w-0">
                            <div className="font-semibold text-fg tabular">{formatTokens(lot.amount)}</div>
                            <div className="text-faint">
                              {formatDuration(age)} old{lot.weight < 0.999 ? ` · 1.0× in ${formatDuration(RAMP_MS - age)}` : ""}
                            </div>
                          </div>
                          <WeightPill weight={lot.weight} />
                        </li>
                      );
                    })}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}
