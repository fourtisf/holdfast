"use client";

import type { CoinDetail } from "@holdfast/core";
import { ChangePct, TriggerBadge, VaultBuyingBadge } from "@/components/coin/CoinBadges";
import { CoinAvatar } from "@/components/coin/CoinAvatar";
import { FloorAthBar } from "@/components/coin/FloorAthBar";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { GlobeIcon, TelegramIcon, XLogoIcon } from "@/components/ui/icons";
import { HiddenNotice, ReportButton } from "@/components/moderation/ReportButton";
import { formatMarketCap, formatPrice, formatRelativeTime, shortAddress } from "@/lib/format";
import { useNow } from "@/lib/hooks/useNow";

function SocialLink({ href, label, children }: { href: string; label: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className="flex size-8 items-center justify-center rounded-lg bg-surface-3 text-muted transition-colors hover:text-fg"
    >
      {children}
    </a>
  );
}

export function CoinHeader({ coin }: { coin: CoinDetail }) {
  const now = useNow(30_000);
  const { socials } = coin;
  return (
    <Card className="p-4">
      <div className="flex gap-4">
        <CoinAvatar mint={coin.mint} imageUrl={coin.imageUrl} name={coin.name} className="size-16 sm:size-[76px]" rounded="rounded-2xl" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="truncate text-xl font-semibold tracking-tight text-fg sm:text-2xl">{coin.name}</h1>
            <span className="text-sm font-semibold text-muted">${coin.ticker}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {coin.vaultBuying ? <VaultBuyingBadge /> : null}
            <TriggerBadge triggerBps={coin.triggerBps} />
            <Badge tone={coin.graduated ? "ath" : "muted"}>{coin.graduated ? "PumpSwap" : "Bonding curve"}</Badge>
            <span className="text-xs text-faint">Launched {formatRelativeTime(coin.createdAt, now)}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1 font-mono text-xs text-muted ring-1 ring-line">
              {shortAddress(coin.mint, 5)}
              <CopyButton value={coin.mint} size={13} />
            </span>
            {socials.x ? (
              <SocialLink href={socials.x} label="X / Twitter">
                <XLogoIcon size={14} />
              </SocialLink>
            ) : null}
            {socials.telegram ? (
              <SocialLink href={socials.telegram} label="Telegram">
                <TelegramIcon size={15} />
              </SocialLink>
            ) : null}
            {socials.website ? (
              <SocialLink href={socials.website} label="Website">
                <GlobeIcon size={15} />
              </SocialLink>
            ) : null}
            <span className="ml-auto">
              <ReportButton mint={coin.mint} ticker={coin.ticker} />
            </span>
          </div>
        </div>
      </div>
      {coin.hidden ? <div className="mt-3"><HiddenNotice reason={coin.hiddenReason} /></div> : null}
      {coin.description ? <p className="mt-3 text-sm leading-relaxed text-muted">{coin.description}</p> : null}
    </Card>
  );
}

export function MarketCapCard({ coin }: { coin: CoinDetail }) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <div className="text-[11px] font-semibold tracking-wider text-muted uppercase">Market cap</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-[28px] leading-none font-semibold tracking-tight text-fg tabular">{formatMarketCap(coin.marketCapSol)}</span>
            <ChangePct value={coin.change24hPct} className="text-sm font-semibold" />
            <span className="text-xs text-faint">24h</span>
          </div>
        </div>
        <dl className="flex gap-5 text-xs">
          <div>
            <dt className="text-faint">Price</dt>
            <dd className="mt-0.5 font-semibold text-fg tabular">{formatPrice(coin.price)} SOL</dd>
          </div>
          <div>
            <dt className="text-faint">Floor MC</dt>
            <dd className="mt-0.5 font-semibold text-floor tabular">{formatMarketCap(coin.floorMarketCapSol)}</dd>
          </div>
          <div>
            <dt className="text-faint">ATH MC</dt>
            <dd className="mt-0.5 font-semibold text-ath tabular">{formatMarketCap(coin.athMarketCapSol)}</dd>
          </div>
        </dl>
      </div>
      <FloorAthBar detailed className="mt-4" progress={coin.floorToAthProgress} vaultBuying={coin.vaultBuying} />
    </Card>
  );
}
