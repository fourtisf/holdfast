"use client";

import { TriggerBadge } from "@/components/coin/CoinBadges";
import { CoinAvatar } from "@/components/coin/CoinAvatar";
import { FloorAthBar } from "@/components/coin/FloorAthBar";
import { Badge } from "@/components/ui/Badge";
import { GlobeIcon, TelegramIcon, XLogoIcon } from "@/components/ui/icons";
import { formatMarketCap } from "@/lib/format";
import { normalizeSocial, type LaunchForm } from "@/lib/launch";

const START_MC = 28;

/** Live card preview: what the coin will look like in the Coins grid right after launch. */
export function LaunchPreview({ form, preview }: { form: LaunchForm; preview: string | null }) {
  const name = form.name.trim() || "Your coin";
  const ticker = form.ticker || "TICKER";
  const seed = `${form.name}:${form.ticker}` || "preview";
  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold tracking-wider text-muted uppercase">Preview</div>
      <div className="rounded-card border border-line bg-surface p-3.5 shadow-card">
        <div className="flex gap-3">
          <CoinAvatar key={preview ?? seed} mint={seed} imageUrl={preview} name={name} className="size-[68px]" />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-semibold text-fg">{name}</div>
                <div className="text-xs text-muted">
                  <span className="font-semibold text-fg/80">${ticker}</span> · just now
                </div>
              </div>
              <TriggerBadge triggerBps={form.triggerBps} />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-[11px] font-medium text-faint uppercase">MC</span>
              <span className="font-semibold text-fg tabular">≈ {formatMarketCap(START_MC)}</span>
              <Badge tone="brand">New</Badge>
            </div>
          </div>
        </div>
        <FloorAthBar className="mt-3" progress={1} vaultBuying={false} />
        {form.description.trim() ? <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-muted">{form.description}</p> : null}
        <div className="mt-3 flex items-center gap-2 border-t border-line pt-2.5 text-muted">
          {normalizeSocial("x", form.x) ? <XLogoIcon size={14} /> : null}
          {normalizeSocial("telegram", form.telegram) ? <TelegramIcon size={15} /> : null}
          {normalizeSocial("website", form.website) ? <GlobeIcon size={15} /> : null}
          <span className="ml-auto text-[11px] text-faint">Vault 0 SOL · fills from fees</span>
        </div>
      </div>
    </div>
  );
}
