"use client";

import { SPLIT_BURN_BPS, SPLIT_FLOOR_BPS, SPLIT_HOLDER_BPS, type CoinDetail } from "@holdfast/core";
import type { ReactNode } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { ExternalIcon, VaultIcon } from "@/components/ui/icons";
import { useRoundCountdown } from "@/components/providers/ScheduleProvider";
import { SOLANA_CLUSTER } from "@/lib/config";
import { explorerAddressUrl } from "@/lib/explorer";
import { formatBpsAsPct, formatCountdown, formatMarketCap, formatPrice, formatRelativeTime, formatSol, formatTokens } from "@/lib/format";
import { useNow } from "@/lib/hooks/useNow";

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-sm text-muted">{label}</div>
        {hint ? <div className="text-[11px] text-faint">{hint}</div> : null}
      </div>
      <div className="text-right text-sm font-semibold text-fg tabular">{children}</div>
    </div>
  );
}

export function VaultPanel({ coin }: { coin: CoinDetail }) {
  const v = coin.vault;
  const now = useNow(10_000);
  const countdown = useRoundCountdown(1000);
  return (
    <Card>
      <CardHeader
        title="Floor vault"
        icon={<VaultIcon size={15} />}
        subtitle="No withdraw function · 0% to the dev"
        action={
          <a
            href={explorerAddressUrl(coin.vaultAddress, SOLANA_CLUSTER)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
          >
            On-chain <ExternalIcon size={12} />
          </a>
        }
      />
      <div className="mx-4 rounded-control bg-floor/8 px-3 py-3 ring-1 ring-floor/20">
        <div className="text-[11px] font-semibold tracking-wider text-floor/90 uppercase">Defending the floor</div>
        <div className="mt-0.5 text-2xl font-semibold text-floor tabular">{formatSol(v.floorSol)}</div>
        <div className="text-xs text-muted">Each buyback spends 10% of this, with cooldowns</div>
      </div>
      <div className="divide-y divide-line/70 px-4 pt-1 pb-2">
        <Row label="Holder pot" hint={`${SPLIT_HOLDER_BPS / 100}% of fees · pays in ${countdown ? formatCountdown(countdown.remainingMs) : "--:--"}`}>
          <div className="text-payout">{formatSol(v.holderSol)}</div>
          {v.holderTokens > 0 ? (
            <div className="text-xs font-normal text-muted">
              + {formatTokens(v.holderTokens)} {coin.ticker}
            </div>
          ) : null}
        </Row>
        <Row label="Burn bucket" hint={`${SPLIT_BURN_BPS / 100}% of fees → buy & burn $MOAT`}>
          <span className="text-vault">{formatSol(v.burnSol)}</span>
        </Row>
        <Row label="ATH" hint="Time-weighted all-time high">
          <div className="text-ath">{formatPrice(v.athPrice)}</div>
          <div className="text-xs font-normal text-muted">{formatMarketCap(coin.athMarketCapSol)}</div>
        </Row>
        <Row label="Floor price" hint={`ATH × (1 − ${formatBpsAsPct(coin.triggerBps)}) · only rises`}>
          <div className="text-floor">{formatPrice(v.floorPrice)}</div>
          <div className="text-xs font-normal text-muted">{formatMarketCap(coin.floorMarketCapSol)}</div>
        </Row>
        <Row label="Buybacks" hint={`${formatSol(v.totalDefendedSol)} spent in total`}>
          {v.defendCount}
        </Row>
        <Row label="Last buyback">{v.lastDefendAt ? formatRelativeTime(v.lastDefendAt, now) : <span className="text-faint">Never</span>}</Row>
      </div>
      <div className="border-t border-line px-4 py-2.5 text-[11px] text-faint">
        Fee split: {SPLIT_FLOOR_BPS / 100}% floor · {SPLIT_HOLDER_BPS / 100}% holders · {SPLIT_BURN_BPS / 100}% burn
      </div>
    </Card>
  );
}
