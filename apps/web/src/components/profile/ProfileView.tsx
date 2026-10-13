"use client";

import type { Position, Profile } from "@holdfast/core";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { CoinAvatar } from "@/components/coin/CoinAvatar";
import { WeightPill } from "@/components/coin-page/ActivityTabs";
import { useRoundCountdown } from "@/components/providers/ScheduleProvider";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorNote } from "@/components/ui/States";
import { CoinsIcon, ExternalIcon, SearchIcon, UserIcon } from "@/components/ui/icons";
import { errorMessage } from "@/lib/api";
import { SOLANA_CLUSTER } from "@/lib/config";
import { explorerAddressUrl, explorerTxUrl } from "@/lib/explorer";
import { formatAgo, formatCountdown, formatMultiplier, formatShare, formatSol, formatTokens, shortAddress } from "@/lib/format";
import { useProfile } from "@/lib/hooks/queries";
import { useNow } from "@/lib/hooks/useNow";

function isAddress(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

export function ProfileView() {
  const params = useSearchParams();
  const { publicKey } = useWallet();
  const queryWallet = params.get("wallet")?.trim() || null;
  const connected = publicKey?.toBase58() ?? null;
  const wallet = queryWallet ?? connected;

  if (!wallet) return <ConnectPrompt />;
  return <ProfileContent wallet={wallet} own={wallet === connected} />;
}

function ConnectPrompt() {
  const { setVisible } = useWalletModal();
  const router = useRouter();
  const [lookup, setLookup] = useState("");
  const valid = isAddress(lookup.trim());
  return (
    <div className="mx-auto max-w-lg pt-6">
      <Card>
        <EmptyState
          icon={<UserIcon size={32} />}
          title="Connect a wallet to see your earnings"
          body="Positions, hold weight, share of each payout and every round you were paid in."
          action={<Button onClick={() => setVisible(true)}>Connect wallet</Button>}
        />
        <form
          className="flex gap-2 border-t border-line p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) router.push(`/profile?wallet=${lookup.trim()}`);
          }}
        >
          <label className="relative flex-1">
            <SearchIcon size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
            <input
              value={lookup}
              onChange={(e) => setLookup(e.target.value)}
              placeholder="Or look up any wallet address"
              aria-label="Wallet address"
              className="h-10 w-full rounded-control border border-line-strong bg-surface-2 pr-3 pl-9 text-sm text-fg placeholder:text-faint focus:border-faint focus:outline-none"
            />
          </label>
          <Button type="submit" variant="secondary" disabled={!valid}>
            View
          </Button>
        </form>
      </Card>
    </div>
  );
}

function Stat({ label, value, sub, tone = "text-fg" }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-card">
      <div className="text-[11px] font-semibold tracking-wider text-muted uppercase">{label}</div>
      <div className={`mt-1.5 truncate text-xl font-semibold tracking-tight tabular sm:text-2xl ${tone}`}>{value}</div>
      {sub ? <div className="mt-0.5 truncate text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

function ProfileContent({ wallet, own }: { wallet: string; own: boolean }) {
  const { data, error, isLoading } = useProfile(wallet);
  const countdown = useRoundCountdown(1000);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-4" data-wallet={wallet}>
        <div className="flex size-14 items-center justify-center rounded-2xl bg-brand/12 text-brand ring-1 ring-brand/25">
          <UserIcon size={26} />
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{own ? "Your profile" : "Wallet profile"}</h1>
          <div className="mt-1 flex items-center gap-2 font-mono text-xs text-muted">
            <span className="sm:hidden">{shortAddress(wallet, 6)}</span>
            <span className="hidden sm:inline">{wallet}</span>
            <CopyButton value={wallet} size={13} />
            <a
              href={explorerAddressUrl(wallet, SOLANA_CLUSTER)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-faint hover:text-fg"
              aria-label="View on explorer"
            >
              <ExternalIcon size={13} />
            </a>
          </div>
        </div>
      </div>

      {error ? <ErrorNote>Could not load profile: {errorMessage(error)}</ErrorNote> : null}

      {isLoading || !data ? (
        error ? null : (
          <ProfileSkeleton />
        )
      ) : (
        <>
          <Summary profile={data} nextIn={countdown ? formatCountdown(countdown.remainingMs) : "--:--"} />
          <Positions positions={data.positions} own={own} />
          <RecentPayouts payouts={data.recentPayouts} />
        </>
      )}
    </div>
  );
}

function Summary({ profile, nextIn }: { profile: Profile; nextIn: string }) {
  const total = profile.totalEarnedSol + profile.totalEarnedTokensValueSol;
  const value = profile.positions.reduce((s, p) => s + p.valueSol, 0);
  const nextEstimate = profile.positions.reduce((s, p) => s + p.nextPayoutEstimateSol, 0);
  const eligible = profile.positions.reduce((s, p) => s + p.eligibleTokens, 0);
  const avgWeight = eligible > 0 ? profile.positions.reduce((s, p) => s + p.weightedTokens, 0) / eligible : 0;
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Stat
        label="Total earned"
        value={formatSol(total)}
        sub={`${formatSol(profile.totalEarnedSol)} + tokens worth ${formatSol(profile.totalEarnedTokensValueSol)}`}
        tone="text-payout"
      />
      <Stat label="Next payout" value={`≈ ${formatSol(nextEstimate)}`} sub={`in ${nextIn}`} />
      <Stat label="Positions" value={profile.positions.length} sub={`Worth ${formatSol(value)}`} />
      <Stat label="Avg weight" value={formatMultiplier(avgWeight)} sub="Reaches 1.0× after 7 days held" tone="text-brand" />
    </div>
  );
}

function Positions({ positions, own }: { positions: Position[]; own: boolean }) {
  const th = "px-3 py-2.5 text-left text-[11px] font-semibold tracking-wider text-faint uppercase whitespace-nowrap";
  const td = "px-3 py-3 whitespace-nowrap tabular";
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Positions" icon={<CoinsIcon size={15} />} subtitle="Share = tokens × weight ÷ everyone's tokens × weight" />
      {positions.length === 0 ? (
        <EmptyState
          title={own ? "You don't hold any Holdfast coins yet" : "This wallet holds no Holdfast coins"}
          body="Buy a coin to start earning. Lots start at 0.1× weight and reach 1.0× after 7 days."
          action={<ButtonLink href="/">Browse coins</ButtonLink>}
        />
      ) : (
        <>
          <ul className="divide-y divide-line/70 border-t border-line sm:hidden">
            {positions.map((p) => (
              <li key={p.mint}>
                <Link href={`/coin/${p.mint}`} className="block px-4 py-3">
                  <div className="flex items-center gap-3">
                    <CoinAvatar mint={p.mint} imageUrl={p.imageUrl} name={p.name} className="size-10" rounded="rounded-lg" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold text-fg">{p.name}</div>
                      <div className="text-xs text-muted">
                        {formatTokens(p.tokens)} ${p.ticker} · {formatSol(p.valueSol)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-semibold text-fg tabular">{formatShare(p.share)}</div>
                      <div className="text-[11px] text-faint">share</div>
                    </div>
                  </div>
                  <div className="mt-2.5 flex items-center justify-between text-xs">
                    <WeightPill weight={p.weightMultiplier} />
                    <span className="text-muted">
                      Earned <span className="font-semibold text-payout tabular">{formatSol(p.earnedSol)}</span>
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="scrollbar-thin hidden overflow-x-auto border-t border-line sm:block">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-surface-2/60">
                <tr>
                  <th className={th}>Coin</th>
                  <th className={`${th} text-right`}>Tokens</th>
                  <th className={`${th} text-right`}>Earning</th>
                  <th className={th}>Weight</th>
                  <th className={`${th} text-right`}>Share</th>
                  <th className={`${th} text-right`}>Value</th>
                  <th className={`${th} text-right`}>Earned</th>
                  <th className={`${th} text-right`}>Next payout</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.mint} className="border-t border-line/70 transition-colors hover:bg-surface-2">
                    <td className="px-3 py-2.5">
                      <Link href={`/coin/${p.mint}`} className="flex items-center gap-3">
                        <CoinAvatar mint={p.mint} imageUrl={p.imageUrl} name={p.name} className="size-9" rounded="rounded-lg" />
                        <div className="min-w-0">
                          <div className="max-w-[160px] truncate font-semibold text-fg">{p.name}</div>
                          <div className="text-xs text-muted">${p.ticker}</div>
                        </div>
                      </Link>
                    </td>
                    <td className={`${td} text-right text-fg`}>{formatTokens(p.tokens)}</td>
                    <td className={`${td} text-right text-muted`}>{formatTokens(p.eligibleTokens)}</td>
                    <td className={td}>
                      <WeightPill weight={p.weightMultiplier} />
                    </td>
                    <td className={`${td} text-right font-semibold text-fg`}>{formatShare(p.share)}</td>
                    <td className={`${td} text-right text-fg`}>{formatSol(p.valueSol)}</td>
                    <td className={`${td} text-right text-payout`}>
                      {formatSol(p.earnedSol)}
                      {p.earnedTokens > 0 ? (
                        <div className="text-[11px] text-muted">
                          + {formatTokens(p.earnedTokens)} {p.ticker}
                        </div>
                      ) : null}
                    </td>
                    <td className={`${td} text-right text-muted`}>≈ {formatSol(p.nextPayoutEstimateSol)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

const PAYOUTS_COLLAPSED = 10;

function RecentPayouts({ payouts }: { payouts: Profile["recentPayouts"] }) {
  const now = useNow(10_000);
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? payouts : payouts.slice(0, PAYOUTS_COLLAPSED);
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Recent payouts" subtitle="SOL and bought-back tokens, every 2 minutes" />
      {payouts.length === 0 ? (
        <EmptyState title="No payouts yet" body="Payouts arrive every 2 minutes once you hold an earning position." />
      ) : (
        <ul className="divide-y divide-line/70 border-t border-line">
          {visible.map((p) => (
            <li key={`${p.mint}-${p.roundId}`} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span className="w-14 shrink-0 text-xs text-faint tabular">{formatAgo(p.ts, now)}</span>
              <Link href={`/coin/${p.mint}`} className="min-w-0 flex-1 hover:text-brand">
                <span className="block truncate font-semibold text-fg">${p.ticker}</span>
                <span className="block text-[11px] text-faint">Round #{p.roundId}</span>
              </Link>
              <span className="text-right tabular">
                <span className="font-semibold text-payout">+{formatSol(p.sol)}</span>
                {p.tokens > 0 ? (
                  <span className="block text-[11px] text-muted sm:ml-2 sm:inline">
                    +{formatTokens(p.tokens)} {p.ticker}
                  </span>
                ) : null}
              </span>
              {p.sig ? (
                <a
                  href={explorerTxUrl(p.sig, SOLANA_CLUSTER)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-faint hover:text-fg"
                  aria-label="View payout transaction"
                >
                  <ExternalIcon size={13} />
                </a>
              ) : (
                <span className="w-[13px] shrink-0" />
              )}
            </li>
          ))}
        </ul>
      )}
      {payouts.length > PAYOUTS_COLLAPSED ? (
        <div className="flex justify-center border-t border-line p-3">
          <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show fewer" : `Show all ${payouts.length} payouts`}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function ProfileSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[92px] rounded-card" />
        ))}
      </div>
      <Skeleton className="h-[300px] rounded-card" />
    </div>
  );
}
