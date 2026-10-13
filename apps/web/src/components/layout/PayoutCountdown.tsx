"use client";

import { ROUND_INTERVAL_SECONDS } from "@holdfast/core";
import { useRoundCountdown } from "@/components/providers/ScheduleProvider";
import { cn } from "@/components/ui/cn";
import { formatCountdown } from "@/lib/format";

const PAYING_WINDOW_MS = 4000;

function useCountdownView() {
  const state = useRoundCountdown();
  const intervalMs = ROUND_INTERVAL_SECONDS * 1000;
  const justPaid = state ? state.remainingMs > intervalMs - PAYING_WINDOW_MS : false;
  return { state, label: state ? formatCountdown(state.remainingMs) : "--:--", justPaid };
}

function Ring({ progress, size = 64, stroke = 5 }: { progress: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--color-surface-3)" strokeWidth={stroke} fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="var(--color-payout)"
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - progress)}
        style={{ transition: "stroke-dashoffset 250ms linear" }}
      />
    </svg>
  );
}

/** Sidebar card: "Next payout in mm:ss", synced to the server's round schedule. */
export function PayoutCountdownCard() {
  const { state, label, justPaid } = useCountdownView();
  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-card">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold tracking-wider text-muted uppercase">Next payout in</span>
        <span className="flex items-center gap-1.5 text-[11px] text-faint" title="Synced to the server's round schedule">
          <span className={cn("size-1.5 rounded-full", state ? "bg-buy" : "animate-pulse-soft bg-floor")} />
          {state ? "Synced" : "Syncing"}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-4">
        <div className="relative">
          <Ring progress={state?.progress ?? 0} />
          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-payout">{ROUND_INTERVAL_SECONDS / 60}m</span>
        </div>
        <div className="min-w-0">
          <div className={cn("font-mono text-[34px] leading-none font-semibold tracking-tight tabular", justPaid ? "text-payout" : "text-fg")} aria-live="off">
            {label}
          </div>
          <div className="mt-1.5 text-xs text-muted">{justPaid ? "Paying holders now…" : "SOL + bought-back tokens"}</div>
        </div>
      </div>
      <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-muted">
        Every {ROUND_INTERVAL_SECONDS / 60} minutes each coin&apos;s holder pot is split by <span className="text-fg">tokens × weight</span>.
      </p>
    </div>
  );
}

/** Compact header pill for small screens. */
export function PayoutCountdownPill({ className }: { className?: string }) {
  const { label, justPaid } = useCountdownView();
  return (
    <div
      className={cn("flex items-center gap-1.5 rounded-full border border-payout/25 bg-payout/10 px-2.5 py-1 text-xs font-semibold text-payout", className)}
      title="Next holder payout"
    >
      <span className={cn("size-1.5 rounded-full bg-payout", justPaid && "animate-pulse-soft")} />
      <span className="hidden min-[400px]:inline">Payout</span>
      <span className="font-mono tabular">{label}</span>
    </div>
  );
}
