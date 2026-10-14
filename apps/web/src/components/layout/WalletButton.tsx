"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

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

/** Universal links that open this page inside the wallet app's browser (where the wallet is injected). */
export function walletBrowseLinks(url: string, origin: string): { name: string; href: string }[] {
  const u = encodeURIComponent(url);
  const ref = encodeURIComponent(origin);
  return [
    { name: "Phantom", href: `https://phantom.app/ul/browse/${u}?ref=${ref}` },
    { name: "Solflare", href: `https://solflare.com/ul/v1/browse/${u}?ref=${ref}` },
  ];
}

/**
 * iOS browsers have no wallet to connect to, so connecting happens inside a wallet app's browser.
 * (Android Chrome connects through the Mobile Wallet Adapter, which wallet-adapter registers itself.)
 */
function useNeedsWalletApp(): boolean {
  const [needs, setNeeds] = useState(false);
  useEffect(() => {
    const w = window as unknown as { solana?: unknown; phantom?: unknown; solflare?: unknown; backpack?: unknown };
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    setNeeds(ios && !w.solana && !w.phantom && !w.solflare && !w.backpack);
  }, []);
  return needs;
}

function OpenInWalletApp() {
  const [open, setOpen] = useState(false);
  const links = typeof window === "undefined" ? [] : walletBrowseLinks(window.location.href, window.location.origin);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="h-[38px] rounded-control bg-brand px-3 text-sm font-semibold text-brand-ink"
      >
        Open in wallet
      </button>
      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-56 rounded-card border border-line bg-surface p-2 shadow-card">
          <p className="px-2 pb-2 text-xs text-muted">Phone browsers have no wallet. Open Moatpad in your wallet app:</p>
          {links.map((l) => (
            <a key={l.name} href={l.href} className="block rounded-lg px-2 py-2 text-sm font-semibold text-fg hover:bg-surface-2">
              {l.name}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** wallet-adapter's multi button (connect / copy / change / disconnect) with Moatpad labels. */
export function WalletButton() {
  const { connected } = useWallet();
  const needsApp = useNeedsWalletApp();
  if (needsApp && !connected) return <OpenInWalletApp />;
  return <BaseWalletMultiButton labels={LABELS} />;
}
