"use client";

import type { LeaderboardKind } from "@holdfast/core";
import Link from "next/link";
import { useState } from "react";
import { CoinAvatar } from "@/components/coin/CoinAvatar";
import { Card } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState, ErrorNote } from "@/components/ui/States";
import { Tabs } from "@/components/ui/Tabs";
import { errorMessage } from "@/lib/api";
import { useMoney } from "@/lib/currency";
import { formatCompact, formatDuration, formatTokens, shortAddress } from "@/lib/format";
import { useLeaderboard } from "@/lib/hooks/queries";
import { useNow } from "@/lib/hooks/useNow";

type Period = "all" | "7" | "1";

const th = "px-3 py-2.5 text-left text-[11px] font-semibold tracking-wider text-faint uppercase whitespace-nowrap";
const td = "px-3 py-3 whitespace-nowrap tabular";

function Rank({ i }: { i: number }) {
  const medal = ["text-ath", "text-fg/80", "text-payout"][i];
  return <span className={`text-sm font-bold ${medal ?? "text-faint"}`}>{i + 1}</span>;
}

function WalletCell({ wallet, href }: { wallet: string; href: string }) {
  return (
    <Link href={href} className="font-mono text-xs text-muted hover:text-fg">
      {shortAddress(wallet, 5)}
    </Link>
  );
}

export function LeaderboardView() {
  const [kind, setKind] = useState<LeaderboardKind>("earners");
  const [period, setPeriod] = useState<Period>("all");
  const { data, error, isLoading } = useLeaderboard(kind, kind === "earners" && period !== "all" ? Number(period) : undefined);
  const money = useMoney();
  const now = useNow(60_000);
  const board = data?.kind === kind ? data : null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-[26px] leading-tight font-semibold tracking-[0.02em] text-fg">Leaderboard</h1>
        <p className="mt-1 text-sm text-muted">Who earns the most from holding, who holds the longest, and which creators&apos; coins pay their holders.</p>
      </div>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 pr-3">
          <Tabs
            value={kind}
            onChange={setKind}
            className="border-b-0"
            tabs={[
              { value: "earners", label: "Top earners" },
              { value: "diamond_hands", label: "Diamond hands" },
              { value: "creators", label: "Creators" },
              { value: "coins", label: "Coins" },
            ]}
          />
          {kind === "earners" ? (
            <Segmented
              size="sm"
              ariaLabel="Period"
              value={period}
              onChange={setPeriod}
              options={[
                { value: "all", label: "All time" },
                { value: "7", label: "7d" },
                { value: "1", label: "24h" },
              ]}
            />
          ) : null}
        </div>
        <div className="border-t border-line" />
        {error ? <ErrorNote className="m-4">Could not load the leaderboard: {errorMessage(error)}</ErrorNote> : null}
        {isLoading || !board ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="h-9 animate-pulse rounded-md bg-surface-2" />
            ))}
          </div>
        ) : board.items.length === 0 ? (
          <EmptyState title="Nothing here yet" body="Rankings fill in as rounds pay out." />
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              {board.kind === "earners" ? (
                <>
                  <thead>
                    <tr className="border-b border-line">
                      <th className={th}>#</th>
                      <th className={th}>Wallet</th>
                      <th className={`${th} text-right`}>Earned</th>
                      <th className={`${th} text-right`}>Coins</th>
                      <th className={`${th} text-right`}>Payouts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.items.map((r, i) => (
                      <tr key={r.wallet} className="border-b border-line/60 last:border-0">
                        <td className={td}><Rank i={i} /></td>
                        <td className={td}><WalletCell wallet={r.wallet} href={`/profile?wallet=${r.wallet}`} /></td>
                        <td className={`${td} text-right font-semibold text-payout`}>{money.sol(r.earnedSol)}</td>
                        <td className={`${td} text-right text-muted`}>{r.coins}</td>
                        <td className={`${td} text-right text-muted`}>{formatCompact(r.payouts, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              ) : board.kind === "diamond_hands" ? (
                <>
                  <thead>
                    <tr className="border-b border-line">
                      <th className={th}>#</th>
                      <th className={th}>Wallet</th>
                      <th className={th}>Coin</th>
                      <th className={`${th} text-right`}>Holding for</th>
                      <th className={`${th} text-right`}>Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.items.map((r, i) => (
                      <tr key={r.wallet} className="border-b border-line/60 last:border-0">
                        <td className={td}><Rank i={i} /></td>
                        <td className={td}><WalletCell wallet={r.wallet} href={`/profile?wallet=${r.wallet}`} /></td>
                        <td className={td}>
                          <Link href={`/coin/${r.mint}`} className="font-semibold text-fg hover:underline">${r.ticker}</Link>
                        </td>
                        <td className={`${td} text-right font-semibold text-brand`}>{formatDuration(now - r.heldSince)}</td>
                        <td className={`${td} text-right text-muted`}>{formatTokens(r.tokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              ) : board.kind === "creators" ? (
                <>
                  <thead>
                    <tr className="border-b border-line">
                      <th className={th}>#</th>
                      <th className={th}>Creator</th>
                      <th className={`${th} text-right`}>Coins</th>
                      <th className={`${th} text-right`}>Paid to holders</th>
                      <th className={`${th} text-right`}>Creator fees</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.items.map((r, i) => (
                      <tr key={r.wallet} className="border-b border-line/60 last:border-0">
                        <td className={td}><Rank i={i} /></td>
                        <td className={td}><WalletCell wallet={r.wallet} href={`/creator/${r.wallet}`} /></td>
                        <td className={`${td} text-right text-fg`}>{r.coins}</td>
                        <td className={`${td} text-right font-semibold text-payout`}>{money.sol(r.paidToHoldersSol)}</td>
                        <td className={`${td} text-right text-muted`}>{money.sol(r.totalFeesSol)}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              ) : (
                <>
                  <thead>
                    <tr className="border-b border-line">
                      <th className={th}>#</th>
                      <th className={th}>Coin</th>
                      <th className={`${th} text-right`}>Paid out</th>
                      <th className={`${th} text-right`}>Floor vault</th>
                      <th className={`${th} text-right`}>Holders</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.items.map((c, i) => (
                      <tr key={c.mint} className="border-b border-line/60 last:border-0">
                        <td className={td}><Rank i={i} /></td>
                        <td className={td}>
                          <Link href={`/coin/${c.mint}`} className="flex items-center gap-2.5">
                            <CoinAvatar mint={c.mint} imageUrl={c.imageUrl} name={c.name} className="size-8" rounded="rounded-lg" />
                            <span className="font-semibold text-fg">{c.name}</span>
                            <span className="text-xs text-muted">${c.ticker}</span>
                          </Link>
                        </td>
                        <td className={`${td} text-right font-semibold text-payout`}>{money.sol(c.paidOutSol)}</td>
                        <td className={`${td} text-right text-floor`}>{money.sol(c.vault.floorSol)}</td>
                        <td className={`${td} text-right text-muted`}>{formatCompact(c.holders, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              )}
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
