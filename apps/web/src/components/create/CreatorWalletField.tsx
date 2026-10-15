"use client";

import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";
import { shortAddress } from "@/lib/format";

/**
 * The creator wallet claims the creator's 15% of fees. A connected wallet fills it in on its own and shows as
 * "Your wallet"; typing another address stays possible ("Change"), and without a wallet the deposit sender is used.
 */
export function CreatorWalletField({
  value,
  onChange,
  connected,
  error,
  inputClass,
}: {
  value: string;
  onChange: (v: string) => void;
  connected: string | null;
  error?: string;
  inputClass: string;
}) {
  const { setVisible } = useWalletModal();
  const [editing, setEditing] = useState(false);
  // connecting or disconnecting a wallet ends manual entry; a typed address is kept either way
  useEffect(() => setEditing(false), [connected]);
  const usingConnected = connected !== null && value === connected && !editing;
  const typing = editing || (value !== "" && value !== connected);

  let body: React.ReactNode;
  let hint: string;
  if (usingConnected) {
    body = (
      <div className="flex h-11 items-center gap-2.5 rounded-control border border-brand/30 bg-brand/[0.06] px-3">
        <span className="size-2 shrink-0 rounded-full bg-buy shadow-[0_0_8px_var(--color-buy)]" aria-hidden />
        <span className="shrink-0 text-sm font-semibold text-fg">Your wallet</span>
        <span className="min-w-0 truncate font-mono text-sm text-muted" title={connected}>
          {shortAddress(connected, 6)}
        </span>
        <button type="button" onClick={() => setEditing(true)} className="ml-auto shrink-0 text-xs font-semibold text-brand hover:text-brand-light">
          Change
        </button>
      </div>
    );
    hint = "Filled in from your connected wallet. It claims your 15% of the coin's fees.";
  } else if (typing) {
    body = (
      <input
        id="creatorWallet"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Solana wallet address"
        className={cn(inputClass, "font-mono", error ? "border-sell/60" : "border-line-strong")}
        autoComplete="off"
        spellCheck={false}
        autoFocus={editing}
      />
    );
    hint = connected
      ? "Your 15% of the coin's fees goes to this address instead of your connected wallet."
      : "Your 15% of the coin's fees goes here. Leave empty to use the wallet you send the deposit from.";
  } else {
    body = (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={() => setVisible(true)}
          className="inline-flex h-11 items-center rounded-control border border-brand/40 bg-brand/10 px-4 text-sm font-semibold text-brand transition-colors hover:bg-brand/15"
        >
          Connect wallet
        </button>
        <button type="button" onClick={() => setEditing(true)} className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline">
          or paste an address
        </button>
      </div>
    );
    hint = "Connect to fill it in. Without it, the wallet you send the deposit from claims your 15% of the fees.";
  }

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <label htmlFor={typing ? "creatorWallet" : undefined} className="text-sm font-semibold text-fg">
          Creator wallet
        </label>
        {typing && connected ? (
          <button
            type="button"
            onClick={() => {
              onChange(connected);
              setEditing(false);
            }}
            className="text-xs font-semibold text-brand hover:text-brand-light"
          >
            Use my wallet
          </button>
        ) : null}
      </div>
      {body}
      {error ? <p className="mt-1 text-xs text-sell">{error}</p> : <p className="mt-1 text-xs text-faint">{hint}</p>}
    </div>
  );
}
