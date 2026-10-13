"use client";

import dynamic from "next/dynamic";

const LABELS = {
  "change-wallet": "Change wallet",
  connecting: "Connecting…",
  "copy-address": "Copy address",
  copied: "Copied",
  disconnect: "Disconnect",
  "has-wallet": "Connect",
  "no-wallet": "Connect wallet",
} as const;

// The wallet button reads browser-only wallet state, so it renders on the client only.
const BaseWalletMultiButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.BaseWalletMultiButton), {
  ssr: false,
  loading: () => <div className="h-[38px] w-[132px] animate-pulse rounded-control bg-surface-3" />,
});

/** wallet-adapter's multi button (connect / copy / change / disconnect) with Holdfast labels. */
export function WalletButton() {
  return <BaseWalletMultiButton labels={LABELS} />;
}
