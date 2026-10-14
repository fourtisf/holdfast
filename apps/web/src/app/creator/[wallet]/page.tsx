import type { Metadata } from "next";
import { CreatorView } from "@/components/creator/CreatorView";

export async function generateMetadata({ params }: { params: Promise<{ wallet: string }> }): Promise<Metadata> {
  const { wallet } = await params;
  return { title: `Creator ${wallet.slice(0, 4)}…${wallet.slice(-4)}` };
}

export default async function CreatorPage({ params }: { params: Promise<{ wallet: string }> }) {
  const { wallet } = await params;
  return <CreatorView wallet={decodeURIComponent(wallet)} />;
}
