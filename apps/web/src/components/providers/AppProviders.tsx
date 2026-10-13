"use client";

import { WalletAdapterNetwork, type WalletError } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { useCallback, useMemo, type ReactNode } from "react";
import { SWRConfig, type SWRConfiguration } from "swr";
import { HowItWorksProvider } from "@/components/how-it-works/HowItWorksProvider";
import { ApiError } from "@/lib/api";
import { SOLANA_CLUSTER, SOLANA_RPC_URL, USE_MOCKS } from "@/lib/config";
import { MockWalletAdapter } from "@/lib/mocks/wallet";
import { ScheduleProvider } from "./ScheduleProvider";

const swrConfig: SWRConfiguration = {
  dedupingInterval: 1500,
  // Client errors (404 unknown mint, 400 bad wallet) won't fix themselves; retry only network/5xx errors.
  onErrorRetry: (error, _key, _config, revalidate, { retryCount }) => {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) return;
    if (retryCount >= 4) return;
    setTimeout(() => void revalidate({ retryCount }), Math.min(15_000, 1000 * 2 ** retryCount));
  },
};

const network =
  SOLANA_CLUSTER === "mainnet-beta" ? WalletAdapterNetwork.Mainnet : SOLANA_CLUSTER === "testnet" ? WalletAdapterNetwork.Testnet : WalletAdapterNetwork.Devnet;

export function AppProviders({ children }: { children: ReactNode }) {
  // Wallet Standard wallets (Backpack, Phantom, Solflare, ...) register themselves; the explicit
  // adapters cover older extensions and Solflare's web wallet.
  const wallets = useMemo(() => [...(USE_MOCKS ? [new MockWalletAdapter()] : []), new PhantomWalletAdapter(), new SolflareWalletAdapter({ network })], []);
  const onError = useCallback((error: WalletError) => {
    console.warn("[wallet]", error.name, error.message);
  }, []);

  return (
    <SWRConfig value={swrConfig}>
      <ConnectionProvider endpoint={SOLANA_RPC_URL} config={{ commitment: "confirmed" }}>
        <WalletProvider wallets={wallets} autoConnect onError={onError} localStorageKey="holdfast:wallet">
          <WalletModalProvider>
            <ScheduleProvider>
              <HowItWorksProvider>{children}</HowItWorksProvider>
            </ScheduleProvider>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </SWRConfig>
  );
}
