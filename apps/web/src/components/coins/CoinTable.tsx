"use client";

import type { CoinSummary } from "@holdfast/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChangePct, VaultBuyingBadge } from "@/components/coin/CoinBadges";
import { CoinAvatar } from "@/components/coin/CoinAvatar";
import { FloorAthBar } from "@/components/coin/FloorAthBar";
import { formatAgo, formatBpsAsPct, formatCompact, formatMarketCap, formatPrice, formatSol } from "@/lib/format";

const th = "px-3 py-2.5 text-left text-[11px] font-semibold tracking-wider text-faint uppercase whitespace-nowrap";
const td = "px-3 py-3 whitespace-nowrap tabular";

export function CoinTable({ coins, now }: { coins: CoinSummary[]; now: number }) {
  const router = useRouter();
  return (
    <div className="scrollbar-thin overflow-x-auto rounded-card border border-line bg-surface shadow-card">
      <table className="w-full min-w-[980px] text-sm">
        <thead className="border-b border-line bg-surface-2/60">
          <tr>
            <th className={`${th} sticky left-0 z-10 bg-surface-2`}>Coin</th>
            <th className={th}>Price</th>
            <th className={th}>Market cap</th>
            <th className={th}>24h</th>
            <th className={`${th} w-[190px]`}>Floor → ATH</th>
            <th className={th}>Floor vault</th>
            <th className={th}>Paid out</th>
            <th className={th}>Holders</th>
            <th className={th}>Vol 24h</th>
            <th className={th}>Age</th>
          </tr>
        </thead>
        <tbody>
          {coins.map((coin) => (
            <tr
              key={coin.mint}
              onClick={() => router.push(`/coin/${coin.mint}`)}
              className="group cursor-pointer border-b border-line/70 transition-colors last:border-0 hover:bg-surface-2"
            >
              <td className="sticky left-0 z-10 bg-surface px-3 py-2.5 transition-colors group-hover:bg-surface-2">
                <Link href={`/coin/${coin.mint}`} className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                  <CoinAvatar mint={coin.mint} imageUrl={coin.imageUrl} name={coin.name} className="size-9" rounded="rounded-lg" />
                  <div className="min-w-0">
                    <div className="max-w-[150px] truncate font-semibold text-fg">{coin.name}</div>
                    <div className="text-xs text-muted">
                      ${coin.ticker} <span className="text-faint">· −{formatBpsAsPct(coin.triggerBps)}</span>
                    </div>
                  </div>
                </Link>
              </td>
              <td className={`${td} text-muted`}>{formatPrice(coin.price)}</td>
              <td className={`${td} font-semibold text-fg`}>{formatMarketCap(coin.marketCapSol)}</td>
              <td className={td}>
                <ChangePct value={coin.change24hPct} />
              </td>
              <td className="px-3 py-3">
                {coin.vaultBuying ? (
                  <div className="flex items-center gap-2">
                    <VaultBuyingBadge />
                  </div>
                ) : (
                  <FloorAthBar progress={coin.floorToAthProgress} vaultBuying={false} />
                )}
              </td>
              <td className={`${td} font-semibold text-floor`}>{formatSol(coin.vault.floorSol)}</td>
              <td className={`${td} text-payout`}>{formatSol(coin.paidOutSol)}</td>
              <td className={`${td} text-fg`}>{formatCompact(coin.holders, 0)}</td>
              <td className={`${td} text-muted`}>{formatSol(coin.volume24hSol)}</td>
              <td className={`${td} text-muted`}>{formatAgo(coin.createdAt, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
