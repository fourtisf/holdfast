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
              <span className={cn("mt-1.5 text-[11px] font-medium tabular", active ? "text-floor" : "text-faint")}>Buys back at {100 - pct}% of ATH</span>
            </button>
          );
        })}
      </div>
      <div className="mt-2.5 rounded-control bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-muted ring-1 ring-line">
        <FloorLadder triggerBps={value} />
        Floor = ATH × (1 − {value / 100}%). If the ATH market cap is 100 SOL, the vault starts buying at{" "}
        <span className="font-semibold text-floor">{100 - value / 100} SOL</span>. The floor rises with every new ATH and never falls.
        <div className="mt-1.5 font-semibold text-floor">Permanent: the trigger is written into the vault at launch and can never be changed.</div>
      </div>
    </div>
  );
}

/** Market cap from 0 to an example ATH of 100 SOL: the vault buys back anywhere under the floor marker. */
function FloorLadder({ triggerBps }: { triggerBps: TriggerBps }) {
  const floor = 100 - triggerBps / 100;
  return (
    <div className="mb-3" aria-hidden>
      <div className="relative h-10">
        <div className="absolute inset-x-0 top-4 h-2.5 rounded-full bg-line" />
        <div className="absolute top-4 left-0 h-2.5 rounded-l-full bg-floor/35 transition-all duration-500 ease-out" style={{ width: `${floor}%` }} />
        <div className="absolute top-4 right-0 h-2.5 rounded-r-full bg-brand/25 transition-all duration-500 ease-out" style={{ left: `${floor}%` }} />
        <div className="absolute top-3.5 h-5 w-0.5 -translate-x-1/2 rounded bg-floor shadow-[0_0_10px_var(--color-floor)] transition-all duration-500 ease-out" style={{ left: `${floor}%` }} />
        <div className="absolute top-3.5 right-0 h-5 w-0.5 rounded bg-ath" />
        <span className="absolute top-0 left-2 text-[10px] font-semibold tracking-wide text-floor uppercase">Vault buys back here</span>
        <span className="absolute top-0 right-2 text-[10px] font-semibold tracking-wide text-ath uppercase">ATH 100 SOL</span>
      </div>
      <div className="relative mt-0.5 h-4 text-[11px] tabular">
        <span className="absolute left-0 text-faint">0</span>
        {/* near the ATH end the label leans left so it stays inside narrow screens */}
        <span
          className="absolute font-semibold whitespace-nowrap text-floor transition-all duration-500 ease-out"
          style={{ left: `${floor}%`, transform: `translateX(-${floor > 80 ? 75 : 50}%)` }}
        >
          Floor {floor} SOL · −{triggerBps / 100}%
        </span>
      </div>
    </div>
  );
}
