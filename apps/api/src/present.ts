import {
  bondingCurveProgress,
  fixedToSolPerToken,
  floorToAthProgress,
  marketCapSol,
  PUMP_TOTAL_SUPPLY_BASE_UNITS,
  type CoinDetail,
  type CoinSummary,
  type DefendEvent,
  type LaunchStatus,
  type RoundSummary,
  type Trade,
  type VaultSnapshot,
} from "@holdfast/core";
import type { CoinMetrics, CoinRow, DefendRow, LaunchRow, RoundRow, TradeRow, VaultStateRow } from "@holdfast/db";
import { lamportsToSol, rawToTokens } from "./format.js";

/** Presentation: DB rows (bigint, fixed-point) → API types (SOL / whole tokens as numbers). */

const mcap = (price: number, decimals: number) => marketCapSol(price, PUMP_TOTAL_SUPPLY_BASE_UNITS, decimals);

export function toVaultSnapshot(
  vault: VaultStateRow | null,
  decimals: number,
  extra: { defendCount?: number; lastDefendAt?: number | null; totalDefended?: bigint } = {},
): VaultSnapshot {
  return {
    floorSol: vault ? lamportsToSol(vault.floorSol) : 0,
    holderSol: vault ? lamportsToSol(vault.holderSol) : 0,
    creatorSol: vault ? lamportsToSol(vault.creatorSol) : 0,
    creatorClaimedSol: vault ? lamportsToSol(vault.totalCreatorClaimed) : 0,
    platformSol: vault ? lamportsToSol(vault.platformSol) : 0,
    platformSweptSol: vault ? lamportsToSol(vault.totalPlatformSwept) : 0,
    burnSol: vault ? lamportsToSol(vault.burnSol) : 0,
    holderTokens: vault ? rawToTokens(vault.holderTokens, decimals) : 0,
    athPrice: vault ? fixedToSolPerToken(vault.ath, decimals) : 0,
    floorPrice: vault ? fixedToSolPerToken(vault.floor, decimals) : 0,
    defendCount: Math.max(vault ? Number(vault.defendCount) : 0, extra.defendCount ?? 0),
    lastDefendAt: extra.lastDefendAt ?? vault?.lastDefendTs ?? null,
    totalDefendedSol: lamportsToSol(extra.totalDefended ?? vault?.totalDefended ?? 0n),
  };
}

export function toCoinSummary(m: CoinMetrics): CoinSummary {
  const { coin } = m;
  const vault = toVaultSnapshot(m.vault, coin.decimals, { defendCount: m.defendCount, lastDefendAt: m.lastDefendAt, totalDefended: m.defendedSol });
  const price = m.price;
  const change =
    m.lastTradePrice !== null && m.price24hAgo !== null && m.price24hAgo > 0 ? (m.lastTradePrice / m.price24hAgo - 1) * 100 : 0;
  return {
    mint: coin.mint,
    name: coin.name,
    ticker: coin.ticker,
    imageUrl: coin.imageUrl,
    createdAt: coin.createdAt,
    triggerBps: coin.triggerBps,
    price,
    marketCapSol: mcap(price, coin.decimals),
    athMarketCapSol: mcap(vault.athPrice, coin.decimals),
    floorMarketCapSol: mcap(vault.floorPrice, coin.decimals),
    floorToAthProgress: vault.athPrice > 0 ? floorToAthProgress(price, vault.floorPrice, vault.athPrice) : 0,
    vaultBuying: vault.floorPrice > 0 && price > 0 && price <= vault.floorPrice,
    change24hPct: Number.isFinite(change) ? change : 0,
    volume24hSol: lamportsToSol(m.volume24h),
    holders: m.holders,
    paidOutSol: lamportsToSol(m.paidOutSol),
    graduated: coin.graduated,
    bondingCurveProgress: bondingCurveProgress(coin.curveRealTokenReserves, coin.graduated),
    vault,
  };
}

export function toRoundSummary(r: RoundRow, decimals: number): RoundSummary {
  return {
    roundId: Number(r.roundId),
    ts: r.ts,
    solPot: lamportsToSol(r.solPot),
    tokenPot: rawToTokens(r.tokenPot, decimals),
    recipients: r.recipientCount,
    snapshotHash: r.snapshotHash,
    status: r.status,
    openSig: r.openSig,
    closeSig: r.closeSig,
  };
}

export function toCoinDetail(m: CoinMetrics, lastRound: RoundRow | null): CoinDetail {
  const c: CoinRow = m.coin;
  const vaultRound = m.vault ? Number(m.vault.roundId) : 0;
  const summary = toCoinSummary(m);
  return {
    ...summary,
    // Moderated coins: withhold everything the launcher supplied (image, text, links).
    imageUrl: c.hidden ? null : summary.imageUrl,
    description: c.hidden ? "" : c.description,
    socials: c.hidden ? {} : c.socials,
    hidden: c.hidden,
    hiddenReason: c.hidden ? c.hiddenReason : null,
    launcher: c.creator,
    vaultAddress: c.vault,
    treasuryAddress: c.treasury,
    bondingCurve: c.bondingCurve,
    ammPool: c.ammPool,
    roundId: Math.max(vaultRound, lastRound ? Number(lastRound.roundId) : 0),
    lastRound: lastRound ? toRoundSummary(lastRound, c.decimals) : null,
  };
}

export function toTrade(t: TradeRow, decimals: number): Trade {
  return {
    sig: t.sig,
    ixIndex: t.ixIndex,
    slot: t.slot,
    wallet: t.wallet,
    side: t.side,
    sol: lamportsToSol(t.sol),
    tokens: rawToTokens(t.tokens, decimals),
    price: t.price,
    ts: t.ts,
    source: t.source,
  };
}

export function toDefend(d: DefendRow, decimals: number): DefendEvent {
  return { sig: d.sig, solSpent: lamportsToSol(d.solSpent), tokensBought: rawToTokens(d.tokensBought, decimals), price: d.price, ts: d.ts };
}

export function toLaunchStatus(l: LaunchRow): LaunchStatus {
  return {
    launchId: l.id,
    status: l.status,
    depositAddress: l.depositAddress,
    requiredLamports: l.requiredLamports.toString(),
    receivedLamports: l.receivedLamports.toString(),
    sender: l.sender,
    mint: l.mint,
    refundSig: l.refundSig,
    error: l.error,
    updatedAt: l.updatedAt,
    name: l.form.name,
    ticker: l.form.ticker,
    devBuySol: lamportsToSol(l.devBuyLamports),
    expiresAt: l.expiresAt,
  };
}
