"use client";

import type { LaunchResponse } from "@holdfast/core";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { ButtonLink } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { DepositModal } from "./DepositModal";

/** `solana:` URI for wallets and the QR code (the same format the API hands out). */
function solanaPayUrl(address: string, lamports: string, ticker: string): string {
  const sol = (Number(lamports) / 1e9).toString();
  const params = new URLSearchParams({ amount: sol, label: "Moatpad", message: `Launch $${ticker}` });
  return `solana:${address}?${params.toString().replace(/\+/g, "%20")}`;
}

/** A launch started elsewhere (the Telegram bot), shown with the same payment and progress screen as /create. */
export function PayView({ launchId }: { launchId: string }) {
  const router = useRouter();
  const { data, error } = useSWR(["launch", launchId], () => api.launchStatus(launchId), { revalidateOnFocus: false });

  if (error) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-xl font-semibold text-fg">Launch not found</h1>
        <p className="mt-2 text-sm text-muted">This payment link is wrong or has expired.</p>
        <ButtonLink href="/create" className="mt-5">
          Launch a coin
        </ButtonLink>
      </div>
    );
  }
  if (!data) return <div className="mx-auto mt-16 size-8 animate-spin rounded-full border-2 border-brand/25 border-t-brand" aria-label="Loading" />;

  const ticker = data.ticker ?? "COIN";
  const launch: LaunchResponse = {
    launchId: data.launchId,
    depositAddress: data.depositAddress,
    requiredLamports: data.requiredLamports,
    requiredSol: Number(data.requiredLamports) / 1e9,
    solanaPayUrl: solanaPayUrl(data.depositAddress, data.requiredLamports, ticker),
    expiresAt: data.expiresAt ?? Date.now(),
  };
  return <DepositModal launch={launch} ticker={ticker} devBuySol={data.devBuySol ?? 0} onClose={() => router.push("/")} onRestart={() => router.push("/create")} />;
}
