"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/components/ui/cn";
import { CheckIcon, ExternalIcon } from "@/components/ui/icons";
import { SOLANA_CLUSTER } from "@/lib/config";
import { explorerTxUrl } from "@/lib/explorer";

/** A launch signed in the connected wallet: build → confirm in the wallet → land → live. */
export type WalletLaunchState =
  | { step: "preparing" }
  | { step: "confirm" }
  | { step: "launching"; signature: string }
  | { step: "live"; mint: string; signature: string | null }
  | { step: "error"; message: string };

const STEPS = ["Prepare", "Confirm in wallet", "Launching", "Live"];
const DONE: Record<Exclude<WalletLaunchState["step"], "error">, number> = { preparing: 0, confirm: 1, launching: 2, live: 4 };
const REDIRECT_MS = 1800;

function Spinner() {
  return <span className="inline-block size-5 shrink-0 animate-spin rounded-full border-2 border-brand/25 border-t-brand" aria-hidden />;
}

export function WalletLaunchModal({
  state,
  ticker,
  failedAt,
  onClose,
  onRetry,
}: {
  state: WalletLaunchState;
  ticker: string;
  /** The step an error happened at (for the stepper). */
  failedAt: number;
  onClose: () => void;
  onRetry: () => void;
}) {
  const router = useRouter();
  const done = state.step === "error" ? failedAt : DONE[state.step];

  useEffect(() => {
    if (state.step !== "live") return;
    const id = setTimeout(() => router.push(`/coin/${state.mint}`), REDIRECT_MS);
    return () => clearTimeout(id);
  }, [state, router]);

  // Closing is blocked while the transaction is in the wallet or in flight.
  const busy = state.step === "confirm" || state.step === "launching";
  return (
    <Modal open onClose={busy ? () => {} : onClose} labelledBy="wallet-launch-title" title={`Launch $${ticker}`}>
      <div className="space-y-5 px-5 py-5">
        <ol className="flex items-center gap-1.5">
          {STEPS.map((label, i) => {
            const complete = i < done;
            const active = i === done;
            const broken = active && state.step === "error";
            return (
              <li key={label} className="flex min-w-0 flex-1 flex-col gap-1.5" aria-current={active ? "step" : undefined}>
                <div className={cn("h-1 rounded-full", complete ? "bg-brand" : active ? (broken ? "bg-sell" : "animate-pulse-soft bg-brand/60") : "bg-surface-3")} />
                <span className={cn("truncate text-[11px] font-semibold", complete ? "text-brand" : active ? (broken ? "text-sell" : "text-fg") : "text-faint")}>{label}</span>
              </li>
            );
          })}
        </ol>

        {state.step === "preparing" ? (
          <Row title="Preparing your launch…" body="Uploading the metadata and building one transaction: coin, vault and dev buy together." />
        ) : state.step === "confirm" ? (
          <Row title="Confirm in your wallet" body="Your wallet shows exactly what you pay. Nothing happens until you approve." />
        ) : state.step === "launching" ? (
          <Row title="Launching on pump.fun…" body="The coin, its floor vault and your dev buy land in this one transaction." signature={state.signature} />
        ) : state.step === "live" ? (
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-brand text-brand-ink shadow-glow">
              <CheckIcon size={24} />
            </span>
            <div>
              <div className="text-lg font-semibold text-fg">${ticker} is live</div>
              <div className="text-sm text-muted">Taking you to your coin…</div>
            </div>
            <ButtonLink href={`/coin/${state.mint}`} size="sm">
              Open coin page
            </ButtonLink>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-control border border-sell/30 bg-sell/10 px-3 py-3 text-sm">
              <div className="font-semibold text-sell">Launch not completed</div>
              <div className="mt-0.5 text-xs text-muted">{state.message}</div>
            </div>
            <div className="flex gap-2">
              <Button className="flex-1" variant="secondary" onClick={onClose}>
                Back to the form
              </Button>
              <Button className="flex-1" onClick={onRetry}>
                Try again
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Row({ title, body, signature }: { title: string; body: string; signature?: string }) {
  return (
    <div className="flex items-start gap-3 rounded-control bg-surface-2 px-3 py-3 ring-1 ring-line">
      <Spinner />
      <div className="min-w-0 text-sm">
        <div className="font-semibold text-fg">{title}</div>
        <div className="text-xs text-muted">{body}</div>
        {signature ? (
          <a href={explorerTxUrl(signature, SOLANA_CLUSTER)} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-brand hover:underline">
            View transaction <ExternalIcon size={11} />
          </a>
        ) : null}
      </div>
    </div>
  );
}
