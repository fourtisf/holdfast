import type { Metadata } from "next";
import { CoinPageView } from "@/components/coin-page/CoinPageView";
import { formatMarketCap, formatSol } from "@/lib/format";
import { fetchCoinForPreview } from "@/lib/server-coin";

export async function generateMetadata({ params }: { params: Promise<{ mint: string }> }): Promise<Metadata> {
  const { mint } = await params;
  const coin = await fetchCoinForPreview(decodeURIComponent(mint));
  if (!coin) return { title: "Coin" };
  const title = `${coin.name} ($${coin.ticker})`;
  const description = `MC ${formatMarketCap(coin.marketCapSol)} · floor ${formatMarketCap(coin.floorMarketCapSol)} · vault ${formatSol(coin.vault.floorSol)} · ${formatSol(coin.paidOutSol)} paid to holders. Creator fees defend the floor and pay holders every 2 minutes.`;
  return { title, description, openGraph: { title, description }, twitter: { card: "summary_large_image", title, description } };
}

export default async function CoinPage({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  return <CoinPageView mint={decodeURIComponent(mint)} />;
}
