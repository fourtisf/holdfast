"use client";

import { DEFAULT_TRIGGER_BPS, TRIGGER_OPTIONS_BPS, type TriggerBps } from "@holdfast/core";
import { cn } from "@/components/ui/cn";

const COPY: Record<TriggerBps, { name: string; body: string }> = {
  1500: { name: "Tight", body: "Defends small dips early" },
  2500: { name: "Balanced", body: "The default for most coins" },
  3500: { name: "Loose", body: "More room before buybacks" },
};

export function TriggerPicker({ value, onChange }: { value: TriggerBps; onChange: (v: TriggerBps) => void }) {
  return (
    <div>
      <div role="radiogroup" aria-label="Floor trigger" className="grid grid-cols-3 gap-2">
        {TRIGGER_OPTIONS_BPS.map((bps) => {
          const active = value === bps;
          const pct = bps / 100;
          return (
            <button
              key={bps}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(bps)}
              className={cn(
                "relative flex flex-col items-start rounded-card border p-3 text-left transition-colors",
                active ? "border-brand bg-brand/8 shadow-glow" : "border-line-strong bg-surface-2/50 hover:border-faint",
              )}
            >
              {bps === DEFAULT_TRIGGER_BPS ? (
                <span className="absolute top-2 right-2 rounded bg-brand/15 px-1 text-[9px] font-bold tracking-wide text-brand uppercase">Default</span>
              ) : null}
              <span className={cn("text-2xl font-semibold tracking-tight tabular", active ? "text-brand" : "text-fg")}>{pct}%</span>
              <span className="mt-0.5 text-xs font-semibold text-fg">{COPY[bps].name}</span>
              <span className="mt-0.5 hidden text-[11px] leading-snug text-muted sm:block">{COPY[bps].body}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-2.5 rounded-control bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-muted ring-1 ring-line">
        Floor = ATH × (1 − {value / 100}%). If the ATH market cap is 100 SOL, the vault starts buying at{" "}
        <span className="font-semibold text-floor">{100 - value / 100} SOL</span>. The floor rises with every new ATH and never falls.
        <div className="mt-1.5 font-semibold text-floor">Permanent: the trigger is written into the vault at launch and can never be changed.</div>
      </div>
    </div>
  );
}
