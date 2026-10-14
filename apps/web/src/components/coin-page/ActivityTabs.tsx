"use client";

import type { CoinDetail, Holder, Page, Trade } from "@holdfast/core";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { Tabs } from "@/components/ui/Tabs";
import { cn } from "@/components/ui/cn";
import { ExternalIcon } from "@/components/ui/icons";
import { SOLANA_CLUSTER } from "@/lib/config";
import { explorerTxUrl } from "@/lib/explorer";
import { formatAgo, formatDuration, formatMultiplier, formatPrice, formatShare, formatSol, formatTokens, shortAddress } from "@/lib/format";
import { useTrades } from "@/lib/hooks/live";
import { useDefends, useHolders, useRounds, useTradesPages } from "@/lib/hooks/queries";
import { useNow } from "@/lib/hooks/useNow";
import { CommentsPanel } from "./CommentsPanel";

type Tab = "trades" | "holders" | "vault" | "rounds" | "comments";

const th = "sticky top-0 z-10 bg-surface px-3 py-2 text-left text-[11px] font-semibold tracking-wider text-faint uppercase whitespace-nowrap";
const scroller = "scrollbar-thin overflow-x-auto lg:max-h-[640px] lg:overflow-y-auto";
const td = "px-3 py-2.5 whitespace-nowrap tabular";

function TxLink({ sig }: { sig: string }) {
  return (
    <a
      href={explorerTxUrl(sig, SOLANA_CLUSTER)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center text-faint transition-colors hover:text-fg"
      aria-label="View transaction"
    >
      <ExternalIcon size={13} />
    </a>
  );
}

function WalletLink({ wallet, you }: { wallet: string; you?: boolean }) {
  return (
    <Link href={`/profile?wallet=${wallet}`} className="font-mono text-xs text-muted transition-colors hover:text-fg">
      {shortAddress(wallet)}
      {you ? <span className="ml-1.5 rounded bg-brand/15 px-1 py-px font-sans text-[10px] font-bold text-brand">YOU</span> : null}
    </Link>
  );
}

function SideBadge({ side }: { side: Trade["side"] }) {
  if (side === "vault") return <Badge tone="vault">Vault buy</Badge>;
  return <Badge tone={side === "buy" ? "buy" : "sell"}>{side === "buy" ? "Buy" : "Sell"}</Badge>;
}

function TradesTable({ coin, wallet }: { coin: CoinDetail; wallet: string | null }) {
  const { data, size, setSize, isLoading, isValidating, mutate } = useTradesPages(coin.mint);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const now = useNow(5000);

  useTrades(coin.mint, (trade) => {
    if (!data) return; // never patch before the first page lands (SWR would drop that response)
    void mutate(
      (pages: Page<Trade>[] | undefined) => {
        if (!pages || pages.length === 0) return pages;
        const [first, ...rest] = pages;
        if (!first || first.items.some((t) => t.sig === trade.sig)) return pages;
        return [{ ...first, items: [trade, ...first.items] }, ...rest];
      },
      { revalidate: false },
    );
    setFresh((s) => new Set(s).add(trade.sig));
    setTimeout(
      () =>
        setFresh((s) => {
          const next = new Set(s);
          next.delete(trade.sig);
          return next;
        }),
      1000,
    );
  });

  const trades = data?.flatMap((p) => p.items) ?? [];
  const hasMore = Boolean(data?.[data.length - 1]?.nextCursor);
  if (isLoading) return <TableSkeleton />;
  if (trades.length === 0) return <EmptyState title="No trades yet" body="Trades show up here live." />;
  return (
    <>
      <div className={scroller}>
        <table className="w-full text-sm sm:min-w-[640px]">
          <thead>
            <tr className="shadow-[inset_0_-1px_0_var(--color-line)]">
              <th className={th}>Time</th>
              <th className={th}>Type</th>
              <th className={th}>Account</th>
              <th className={`${th} text-right`}>SOL</th>
              <th className={`${th} hidden text-right sm:table-cell`}>{coin.ticker}</th>
              <th className={`${th} hidden text-right sm:table-cell`}>Price</th>
              <th className={th} aria-label="Transaction" />
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr
                key={t.sig}
                className={cn("border-b border-line/60 last:border-0", fresh.has(t.sig) && "animate-flash", t.side === "vault" && "bg-vault/[0.04]")}
              >
                <td className={`${td} text-xs text-faint`}>{formatAgo(t.ts, now)}</td>
                <td className={td}>
                  <SideBadge side={t.side} />
                </td>
                <td className={td}>
                  {t.side === "vault" ? (
                    <span className="text-xs font-semibold text-vault">Floor vault</span>
                  ) : (
                    <WalletLink wallet={t.wallet} you={t.wallet === wallet} />
                  )}
                </td>
                <td className={cn(td, "text-right font-semibold", t.side === "sell" ? "text-sell" : t.side === "vault" ? "text-vault" : "text-buy")}>
                  {formatSol(t.sol)}
                </td>
                <td className={`${td} hidden text-right text-muted sm:table-cell`}>{formatTokens(t.tokens)}</td>
                <td className={`${td} hidden text-right text-muted sm:table-cell`}>{formatPrice(t.price)}</td>
                <td className={`${td} w-8 text-right`}>
                  <TxLink sig={t.sig} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasMore ? (
        <div className="flex justify-center border-t border-line p-3">
          <Button variant="ghost" size="sm" onClick={() => void setSize(size + 1)} disabled={isValidating}>
            {isValidating && size > (data?.length ?? 0) ? "Loading…" : "Load older trades"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function WeightPill({ weight }: { weight: number }) {
  if (!(weight > 0)) return <span className="text-xs text-faint">—</span>;
  const pct = ((weight - 0.1) / 0.9) * 100;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="relative h-1.5 w-12 overflow-hidden rounded-full bg-surface-3">
        <span className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${Math.max(4, pct)}%` }} />
      </span>
      <span className="text-xs font-semibold text-fg tabular">{formatMultiplier(weight)}</span>
    </span>
  );
}

function holderNote(h: Holder, launcher: string | null): string | null {
  if (h.wallet === launcher && h.eligibleTokens === 0) return "Dev buy · doesn't earn";
  if (h.tokens > h.eligibleTokens * 1.001) return `${formatTokens(h.tokens - h.eligibleTokens)} received by transfer · doesn't earn`;
  return null;
}

function HoldersTable({ coin, wallet }: { coin: CoinDetail; wallet: string | null }) {
  const { data, isLoading } = useHolders(coin.mint);
  const now = useNow(60_000);
  if (isLoading) return <TableSkeleton />;
  if (!data || data.length === 0) return <EmptyState title="No holders yet" />;
  return (
    <div className={scroller}>
      <table className="w-full text-sm sm:min-w-[720px]">
        <thead>
          <tr className="shadow-[inset_0_-1px_0_var(--color-line)]">
            <th className={th}>#</th>
            <th className={th}>Holder</th>
            <th className={`${th} text-right`}>Balance</th>
            <th className={`${th} hidden text-right sm:table-cell`}>Earning</th>
            <th className={th}>Weight</th>
            <th className={`${th} text-right`}>Share</th>
            <th className={`${th} hidden text-right sm:table-cell`}>Earned</th>
            <th className={`${th} hidden text-right sm:table-cell`}>Held</th>
          </tr>
        </thead>
        <tbody>
          {data.map((h, i) => {
            const note = holderNote(h, coin.launcher);
            return (
              <tr key={h.wallet} className={cn("border-b border-line/60 last:border-0", h.wallet === wallet && "bg-brand/[0.05]")}>
                <td className={`${td} text-xs text-faint`}>{i + 1}</td>
                <td className={td}>
                  <WalletLink wallet={h.wallet} you={h.wallet === wallet} />
                  {note ? <div className="mt-0.5 max-w-[180px] truncate text-[11px] text-faint sm:max-w-none">{note}</div> : null}
                </td>
                <td className={`${td} text-right text-fg`}>{formatTokens(h.tokens)}</td>
                <td className={`${td} hidden text-right text-muted sm:table-cell`}>{formatTokens(h.eligibleTokens)}</td>
                <td className={td}>
                  <WeightPill weight={h.weightMultiplier} />
                </td>
                <td className={`${td} text-right font-semibold text-fg`}>{formatShare(h.share)}</td>
                <td className={`${td} hidden text-right text-payout sm:table-cell`}>{formatSol(h.earnedSol)}</td>
                <td className={`${td} hidden text-right text-xs text-faint sm:table-cell`}>{h.oldestLotAt ? formatDuration(now - h.oldestLotAt) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function VaultBuysTable({ coin }: { coin: CoinDetail }) {
  const { data, isLoading } = useDefends(coin.mint);
  const now = useNow(10_000);
  if (isLoading) return <TableSkeleton />;
  if (!data || data.length === 0)
    return <EmptyState title="No vault buys yet" body="When the price reaches the floor, the vault buys back with 10% of the floor vault per step." />;
  return (
    <div className={scroller}>
      <table className="w-full text-sm sm:min-w-[560px]">
        <thead>
          <tr className="shadow-[inset_0_-1px_0_var(--color-line)]">
            <th className={th}>Time</th>
            <th className={`${th} text-right`}>SOL spent</th>
            <th className={`${th} text-right`}>{coin.ticker} bought</th>
            <th className={`${th} hidden text-right sm:table-cell`}>Price</th>
            <th className={`${th} hidden sm:table-cell`}>Destination</th>
            <th className={th} aria-label="Transaction" />
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.sig} className="border-b border-line/60 last:border-0">
              <td className={`${td} text-xs text-faint`}>{formatAgo(d.ts, now)}</td>
              <td className={`${td} text-right font-semibold text-vault`}>{formatSol(d.solSpent)}</td>
              <td className={`${td} text-right text-fg`}>{formatTokens(d.tokensBought)}</td>
              <td className={`${td} hidden text-right text-muted sm:table-cell`}>{formatPrice(d.price)}</td>
              <td className={`${td} hidden text-xs text-muted sm:table-cell`}>Holder payouts</td>
              <td className={`${td} w-8 text-right`}>
                <TxLink sig={d.sig} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RoundsTable({ coin }: { coin: CoinDetail }) {
  const { data, isLoading } = useRounds(coin.mint);
  const now = useNow(10_000);
  if (isLoading) return <TableSkeleton />;
  if (!data || data.length === 0) return <EmptyState title="No payout rounds yet" body="Rounds run every 2 minutes once the holder pot is worth paying out." />;
  return (
    <div className={scroller}>
      <table className="w-full text-sm sm:min-w-[560px]">
        <thead>
          <tr className="shadow-[inset_0_-1px_0_var(--color-line)]">
            <th className={th}>Round</th>
            <th className={th}>Time</th>
            <th className={`${th} text-right`}>SOL pot</th>
            <th className={`${th} hidden text-right sm:table-cell`}>Tokens</th>
            <th className={`${th} text-right`}>Recipients</th>
            <th className={th} aria-label="Verify" />
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.roundId} className="border-b border-line/60 last:border-0">
              <td className={`${td} font-semibold text-fg`}>#{r.roundId}</td>
              <td className={`${td} text-xs text-faint`}>{formatAgo(r.ts, now)}</td>
              <td className={`${td} text-right font-semibold text-payout`}>{formatSol(r.solPot)}</td>
              <td className={`${td} hidden text-right text-muted sm:table-cell`}>{r.tokenPot > 0 ? formatTokens(r.tokenPot) : "—"}</td>
              <td className={`${td} text-right text-muted`}>{r.recipients}</td>
              <td className={`${td} text-right`}>
                <Link href={`/coin/${coin.mint}/round/${r.roundId}`} className="text-xs font-semibold text-brand hover:underline">
                  Verify
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-8 animate-pulse rounded-md bg-surface-2" />
      ))}
    </div>
  );
}

export function ActivityTabs({ coin, wallet }: { coin: CoinDetail; wallet: string | null }) {
  const [tab, setTab] = useState<Tab>("trades");
  return (
    <Card className="overflow-hidden">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "trades", label: "Trades" },
          { value: "holders", label: "Holders", count: coin.holders },
          { value: "vault", label: "Vault buys", count: coin.vault.defendCount },
          { value: "rounds", label: "Rounds", count: coin.roundId },
          { value: "comments", label: "Comments" },
        ]}
      />
      {tab === "trades" ? (
        <TradesTable coin={coin} wallet={wallet} />
      ) : tab === "rounds" ? (
        <RoundsTable coin={coin} />
      ) : tab === "comments" ? (
        <CommentsPanel coin={coin} />
      ) : tab === "holders" ? (
        <HoldersTable coin={coin} wallet={wallet} />
      ) : (
        <VaultBuysTable coin={coin} />
      )}
    </Card>
  );
}
