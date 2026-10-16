"use client";

import type { LaunchResponse } from "@holdfast/core";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { ButtonLink } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { isLaunchId, solanaPayUrl } from "@/lib/launch";
import { DepositModal } from "./DepositModal";

/** A launch started elsewhere (the Telegram bot), shown with the same payment and progress screen as /create. */
export function PayView({ launchId }: { launchId: string }) {
  const router = useRouter();
  const valid = isLaunchId(launchId);
  const { data, error } = useSWR(valid ? ["launch", launchId] : null, () => api.launchStatus(launchId), { revalidateOnFocus: false });

  if (error || !valid) {
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
  return (
    <DepositModal
      launch={launch}
      ticker={ticker}
      name={data.name}
      devBuySol={data.devBuySol ?? 0}
      initialStatus={data}
      onClose={() => router.push("/")}
      onRestart={() => router.push("/create")}
    />
  );
}
