import type { Metadata } from "next";
import { RoundVerifyView } from "@/components/verify/RoundVerifyView";

export async function generateMetadata({ params }: { params: Promise<{ roundId: string }> }): Promise<Metadata> {
  const { roundId } = await params;
  return { title: `Verify round #${roundId}` };
}

export default async function RoundPage({ params }: { params: Promise<{ mint: string; roundId: string }> }) {
  const { mint, roundId } = await params;
  return <RoundVerifyView mint={decodeURIComponent(mint)} roundId={Number(roundId)} />;
}
