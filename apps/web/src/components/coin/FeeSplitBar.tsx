import { SPLIT_BURN_BPS, SPLIT_FLOOR_BPS, SPLIT_HOLDER_BPS } from "@holdfast/core";
import { cn } from "@/components/ui/cn";

const SEGMENTS = [
  { bps: SPLIT_FLOOR_BPS, label: "Floor vault", color: "bg-floor", text: "text-floor" },
  { bps: SPLIT_HOLDER_BPS, label: "Holder payouts", color: "bg-payout", text: "text-payout" },
  { bps: SPLIT_BURN_BPS, label: "Buy & burn $MOAT", color: "bg-vault", text: "text-vault" },
];

export function FeeSplitBar({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <div className={className}>
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full">
        {SEGMENTS.map((s) => (
          <div key={s.label} className={s.color} style={{ width: `${s.bps / 100}%` }} />
        ))}
      </div>
      <ul className={cn("mt-2", compact ? "grid gap-1 text-[11px]" : "flex flex-wrap gap-x-4 gap-y-1 text-xs")}>
        {SEGMENTS.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5 text-muted">
            <span className={cn("size-2 rounded-sm", s.color)} />
            <span className={cn("font-semibold tabular", s.text)}>{s.bps / 100}%</span>
            <span className={cn(compact && "truncate")}>{s.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
