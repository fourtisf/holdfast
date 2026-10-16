import type { Metadata } from "next";
import { PayView } from "@/components/create/PayView";

export const metadata: Metadata = { title: "Pay for your launch", robots: { index: false } };

/** The payment page of a deposit launch (opened from the Telegram bot): QR code, wallet link and live progress. */
export default async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PayView launchId={decodeURIComponent(id)} />;
}
