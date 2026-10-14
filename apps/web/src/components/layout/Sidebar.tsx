"use client";

import { FeeSplitBar } from "@/components/coin/FeeSplitBar";
import { useLaunchQuote } from "@/lib/hooks/queries";
import { formatSolAmount } from "@/lib/format";
import { WeightRamp } from "@/components/coin/WeightRamp";
import { useHowItWorks } from "@/components/how-it-works/HowItWorksProvider";
import { ButtonLink } from "@/components/ui/Button";
import { ChevronRightIcon, RocketIcon, XLogoIcon } from "@/components/ui/icons";
import { CLUSTER_LABEL, X_HANDLE, X_URL } from "@/lib/config";
import { PayoutCountdownCard } from "./PayoutCountdown";

export function Sidebar() {
  const how = useHowItWorks();
  return (
    <aside className="sticky top-[var(--nav-height)] hidden h-[calc(100dvh-var(--nav-height))] w-[272px] shrink-0 flex-col gap-4 overflow-y-auto py-5 pl-6 scrollbar-none lg:flex">
      <PayoutCountdownCard />

      <div className="rounded-card border border-line bg-surface p-4 shadow-card">
        <div className="text-xs font-semibold tracking-wider text-muted uppercase">Where creator fees go</div>
        <FeeSplitBar compact className="mt-3" />
        <p className="mt-3 text-xs text-muted">
          <span className="font-semibold text-fg">The floor and holder funds can never be withdrawn.</span> The creator claims its 15% on-chain.
        </p>
      </div>

      <div className="rounded-card border border-line bg-surface p-4 shadow-card">
        <div className="text-xs font-semibold tracking-wider text-muted uppercase">Hold longer, earn more</div>
        <WeightRamp className="mt-2 h-[72px]" />
        <p className="mt-1 text-xs text-muted">Weight grows from 0.1× to 1.0× over 7 days of holding.</p>
      </div>

      <button
        type="button"
        onClick={how.open}
        className="flex items-center justify-between rounded-card border border-line bg-surface px-4 py-3 text-left text-sm font-semibold text-fg transition-colors hover:border-line-strong hover:bg-surface-2"
      >
        How it works
        <ChevronRightIcon size={16} className="text-muted" />
      </button>

      <ButtonLink href="/create" size="lg" className="w-full">
        <RocketIcon size={18} />
        <LaunchLabel />
      </ButtonLink>

      <div className="mt-auto flex items-center justify-between gap-2 pt-2 text-[11px] text-faint">
        <span>Solana {CLUSTER_LABEL} · pump.fun</span>
        <a href={X_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-muted transition-colors hover:text-brand" aria-label={`Moatpad on X (${X_HANDLE})`}>
          <XLogoIcon size={11} />
          {X_HANDLE}
        </a>
      </div>
    </aside>
  );
}

function LaunchLabel() {
  const { data: quote } = useLaunchQuote(0);
  return <>Launch a coin{quote ? ` · ${formatSolAmount(quote.launchFeeSol)} SOL` : ""}</>;
}
