"use client";

import type { LaunchResponse, LaunchStatus, LaunchStatusKind } from "@holdfast/core";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { useEffect } from "react";
import { useRoundClock } from "@/components/providers/ScheduleProvider";
import { Button, ButtonLink, buttonClass } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/components/ui/cn";
import { CheckIcon, ExternalIcon } from "@/components/ui/icons";
import { msUntilServerTime } from "@/lib/clock";
import { SOLANA_CLUSTER } from "@/lib/config";
import { explorerTxUrl } from "@/lib/explorer";
import { formatSolExact, formatCountdown, formatSolAmount, shortAddress } from "@/lib/format";
import { useDepositStatus } from "@/lib/hooks/live";
import { useNow } from "@/lib/hooks/useNow";
import { useLaunchQuote } from "@/lib/hooks/queries";
import {
  amountDue,
  creatingStepsText,
  creatorFeesRecipient,
  lamportsToSolExact,
  launchFailureText,
  launchFeeSol,
  liveLaunchNotes,
  partialDeposit,
  solanaPayUrl,
} from "@/lib/launch";

const STEPS = ["Send SOL", "Received", "Creating", "Live"];

/** How many steps are complete, and whether the flow stopped at the next one. */
function progress(status: LaunchStatusKind): { done: number; broken: boolean } {
  switch (status) {
    case "awaiting_deposit":
      return { done: 0, broken: false };
    case "expired":
      return { done: 0, broken: true };
    case "deposit_received":
    case "creating":
      return { done: 2, broken: false };
    case "refunding":
    case "refunded":
    case "failed":
      return { done: 2, broken: true };
    case "live":
      return { done: 4, broken: false };
  }
}

const REDIRECT_MS = 1800;

function Stepper({ status }: { status: LaunchStatusKind }) {
  const { done, broken } = progress(status);
  return (
    <ol className="flex items-center gap-1.5">
      {STEPS.map((label, i) => {
        const complete = i < done;
        const active = i === done;
        return (
          <li key={label} className="flex min-w-0 flex-1 flex-col gap-1.5" aria-current={active ? "step" : undefined}>
            <div
              className={cn("h-1 rounded-full", complete ? "bg-brand" : active ? (broken ? "bg-sell" : "animate-pulse-soft bg-brand/60") : "bg-surface-3")}
            />
            <span className={cn("truncate text-[11px] font-semibold", complete ? "text-brand" : active ? (broken ? "text-sell" : "text-fg") : "text-faint")}>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Spinner() {
  return <span className="inline-block size-5 animate-spin rounded-full border-2 border-brand/25 border-t-brand" aria-hidden />;
}

function lamportsToSol(lamports: string): number {
  return Number(lamports) / 1e9;
}

export function DepositModal({
  launch,
  ticker,
  name,
  devBuySol,
  creatorWallet,
  initialStatus = null,
  onClose,
  onRestart,
}: {
  launch: LaunchResponse;
  ticker: string;
  name?: string;
  devBuySol: number;
  /** Who claims the creator fees (null: the wallet that pays); from the launch status when it is not given. */
  creatorWallet?: string | null;
  /** Already fetched (the /pay page), so a launch that moved on never shows the payment screen first. */
  initialStatus?: LaunchStatus | null;
  onClose: () => void;
  onRestart: () => void;
}) {
  const status = useDepositStatus(launch.launchId, initialStatus);
  // A payment link can be for a launch someone else made: always say who gets the creator fees.
  const creator = creatorWallet !== undefined ? creatorWallet : status?.creatorWallet;
  const router = useRouter();
  const clock = useRoundClock();
  const now = useNow(1000);
  const kind: LaunchStatusKind = status?.status ?? "awaiting_deposit";
  const remaining = msUntilServerTime(clock, launch.expiresAt, now);
  const expired = kind === "expired" || (kind === "awaiting_deposit" && remaining <= 0);

  useEffect(() => {
    if (status?.status !== "live" || !status.mint) return;
    const id = setTimeout(() => router.push(`/coin/${status.mint}`), REDIRECT_MS);
    return () => clearTimeout(id);
  }, [status?.status, status?.mint, router]);

  return (
    <Modal
      open
      onClose={onClose}
      labelledBy="deposit-title"
      title={
        <>
          Launch ${ticker}
          {name ? <span className="ml-2 text-sm font-normal text-muted">{name}</span> : null}
        </>
      }
    >
      <div className="space-y-5 px-5 py-5">
        <Stepper status={expired ? "expired" : kind} />
        {expired ? (
          <Expired onRestart={onRestart} />
        ) : kind === "awaiting_deposit" ? (
          <AwaitingDeposit launch={launch} ticker={ticker} name={name} devBuySol={devBuySol} remainingMs={remaining} status={status} creator={creator} />
        ) : kind === "live" && status ? (
          <Live status={status} ticker={ticker} />
        ) : kind === "failed" || kind === "refunding" || kind === "refunded" ? (
          <Failed status={status!} onRestart={onRestart} />
        ) : (
          <Progress status={status} kind={kind} devBuySol={devBuySol} />
        )}
      </div>
    </Modal>
  );
}

function AwaitingDeposit({
  launch,
  ticker,
  name,
  devBuySol,
  remainingMs,
  status,
  creator,
}: {
  launch: LaunchResponse;
  ticker: string;
  name?: string;
  devBuySol: number;
  remainingMs: number;
  status: LaunchStatus | null;
  /** undefined: not known yet. */
  creator: string | null | undefined;
}) {
  const { data: quote } = useLaunchQuote(devBuySol, { name, ticker });
  const fee = launchFeeSol(quote);
  const partial = partialDeposit(status);
  // The QR code, the wallet link and the amount ask for what is still due: never the full amount again once part arrived.
  const due = amountDue(launch.requiredLamports, status);
  const dueSol = lamportsToSolExact(due);
  const payUrl = due === BigInt(launch.requiredLamports) ? launch.solanaPayUrl : solanaPayUrl(launch.depositAddress, due.toString(), ticker);
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <div className="mx-auto shrink-0 rounded-xl bg-white p-3 sm:mx-0">
          <QRCodeSVG value={payUrl} size={168} level="M" marginSize={0} title="Solana Pay deposit QR code" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <div className="text-[11px] font-semibold tracking-wider text-muted uppercase">{partial ? "Send the missing" : "Send exactly"}</div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="text-2xl font-semibold text-fg tabular">{dueSol} SOL</span>
              <CopyButton value={dueSol} />
            </div>
            {partial ? null : (
              <div className="mt-0.5 text-xs text-muted">
                {formatSolExact(fee)} SOL launch cost (account rent + fees){devBuySol > 0 ? ` + ${formatSolAmount(devBuySol)} SOL dev buy and a small buffer` : ""}. Anything unused is refunded.
              </div>
            )}
          </div>
          <div>
            <div className="text-[11px] font-semibold tracking-wider text-muted uppercase">To this deposit address</div>
            <div className="mt-1 flex items-center gap-2 rounded-control bg-surface-2 px-3 py-2 ring-1 ring-line">
              <span className="min-w-0 flex-1 font-mono text-xs break-all text-fg">{launch.depositAddress}</span>
              <CopyButton value={launch.depositAddress} label="Copy" className="shrink-0 text-xs" />
            </div>
          </div>
          {creator !== undefined ? (
            <div>
              <div className="text-[11px] font-semibold tracking-wider text-muted uppercase">Creator fees go to</div>
              <div className={cn("mt-1 text-xs text-fg", creator && "font-mono break-all")}>{creatorFeesRecipient(creator)}</div>
            </div>
          ) : null}
          {partial ? (
            <div className="rounded-control border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-fg" role="status">
              Received {lamportsToSolExact(partial.receivedLamports)} SOL so far. Send the missing <b className="tabular">{lamportsToSolExact(partial.missingLamports)} SOL</b> to the
              same address before the time runs out, or everything you sent is refunded.
            </div>
          ) : null}
          <div className="flex items-center justify-between rounded-control bg-surface-2 px-3 py-2 text-xs ring-1 ring-line">
            <span className="flex items-center gap-2 text-muted">
              <span className="size-2 animate-pulse-soft rounded-full bg-brand" />
              {partial ? "Waiting for the rest…" : "Waiting for your deposit…"}
            </span>
            <span className="font-mono text-fg tabular" title="Time left to deposit">
              {formatCountdown(remainingMs)}
            </span>
          </div>
        </div>
      </div>
      <a href={payUrl} className={buttonClass("primary", "lg", "w-full sm:hidden")}>
        Open in wallet app
      </a>
      <p className="text-xs leading-relaxed text-faint">
        No wallet connection needed. Send from a wallet you control (not an exchange): refunds and dev-buy tokens go back to the sender.
      </p>
    </div>
  );
}

function Progress({ status, kind, devBuySol }: { status: LaunchStatus | null; kind: LaunchStatusKind; devBuySol: number }) {
  const received = status ? lamportsToSol(status.receivedLamports) : 0;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-control bg-brand/8 px-3 py-3 ring-1 ring-brand/25">
        <span className="flex size-8 items-center justify-center rounded-full bg-brand text-brand-ink">
          <CheckIcon size={16} />
        </span>
        <div className="min-w-0 text-sm">
          <div className="font-semibold text-fg">Deposit received</div>
          <div className="text-xs text-muted">
            {formatSolAmount(received)} SOL{status?.sender ? ` from ${shortAddress(status.sender)}` : ""}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 rounded-control bg-surface-2 px-3 py-3 ring-1 ring-line">
        <Spinner />
        <div className="text-sm">
          <div className="font-semibold text-fg">{kind === "creating" ? "Creating your coin on pump.fun…" : "Preparing launch…"}</div>
          <div className="text-xs text-muted">{creatingStepsText(devBuySol)}</div>
        </div>
      </div>
    </div>
  );
}

function Live({ status, ticker }: { status: LaunchStatus; ticker: string }) {
  const notes = liveLaunchNotes(status.error);
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-brand text-brand-ink shadow-glow">
        <CheckIcon size={24} />
      </span>
      <div>
        <div className="text-lg font-semibold text-fg">${ticker} is live</div>
        <div className="text-sm text-muted">Taking you to your coin…</div>
      </div>
      {notes.map((note) => (
        <div key={note} className="rounded-control border border-sell/30 bg-sell/10 px-3 py-2 text-xs text-fg">
          {note}
        </div>
      ))}
      {status.mint ? (
        <ButtonLink href={`/coin/${status.mint}`} size="sm">
          Open coin page
        </ButtonLink>
      ) : null}
    </div>
  );
}

function Failed({ status, onRestart }: { status: LaunchStatus; onRestart: () => void }) {
  return (
    <div className="space-y-3">
      <div className="rounded-control border border-sell/30 bg-sell/10 px-3 py-3 text-sm">
        <div className="font-semibold text-sell">Launch failed</div>
        {status.error ? <div className="mt-0.5 text-xs text-muted">{launchFailureText(status.error)}</div> : null}
      </div>
      <div className="flex items-center gap-3 rounded-control bg-surface-2 px-3 py-3 text-sm ring-1 ring-line">
        {status.status === "refunded" ? (
          <span className="flex size-6 items-center justify-center rounded-full bg-brand text-brand-ink">
            <CheckIcon size={14} />
          </span>
        ) : (
          <Spinner />
        )}
        <div className="min-w-0">
          <div className="font-semibold text-fg">{status.status === "refunded" ? "Refunded" : "Refunding your SOL…"}</div>
          <div className="text-xs text-muted">
            {formatSolAmount(lamportsToSol(status.receivedLamports))} SOL back to {status.sender ? shortAddress(status.sender) : "the sender"}
          </div>
          {status.refundSig ? (
            <a
              href={explorerTxUrl(status.refundSig, SOLANA_CLUSTER)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 inline-flex items-center gap-1 text-xs text-brand hover:underline"
            >
              View refund <ExternalIcon size={11} />
            </a>
          ) : null}
        </div>
      </div>
      <Button className="w-full" variant="secondary" onClick={onRestart}>
        Try again
      </Button>
    </div>
  );
}

function Expired({ onRestart }: { onRestart: () => void }) {
  return (
    <div className="space-y-3">
      <div className="rounded-control bg-surface-2 px-3 py-3 text-sm ring-1 ring-line">
        <div className="font-semibold text-fg">Deposit window expired</div>
        <div className="mt-0.5 text-xs text-muted">
          No deposit arrived in time. If you sent SOL after the window closed, it is refunded to the sender automatically. Don&apos;t reuse
          this address: SOL sent to it more than 30 days from now is not refunded automatically.
        </div>
      </div>
      <Button className="w-full" onClick={onRestart}>
        Get a new deposit address
      </Button>
    </div>
  );
}
