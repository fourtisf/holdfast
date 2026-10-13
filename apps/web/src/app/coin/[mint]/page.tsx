import { CoinPageView } from "@/components/coin-page/CoinPageView";

export default async function CoinPage({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  return <CoinPageView mint={decodeURIComponent(mint)} />;
}
