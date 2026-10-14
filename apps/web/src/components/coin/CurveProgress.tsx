import { cn } from "@/components/ui/cn";

/** pump.fun bonding-curve progress: graduation to PumpSwap happens at 100%. */
export function CurveProgress({ progress, graduated, detailed = false, className }: { progress: number; graduated: boolean; detailed?: boolean; className?: string }) {
  const pct = graduated ? 100 : Math.floor(Math.min(1, Math.max(0, progress)) * 1000) / 10;
  return (
    <div className={cn("w-full", className)} title={graduated ? "Graduated to PumpSwap" : `Bonding curve ${pct.toFixed(1)}% sold`}>
      <div className={cn("flex items-center justify-between font-medium text-faint", detailed ? "mb-2 text-[11px] tracking-wider uppercase" : "mb-1 text-[10px] tracking-wide uppercase")}>
        <span>{graduated ? "PumpSwap" : "Bonding curve"}</span>
        <span className={cn("normal-case tracking-normal", graduated ? "text-ath" : "text-muted")}>
          {graduated ? "Graduated" : detailed ? `${pct.toFixed(1)}% to graduation` : `${pct.toFixed(0)}%`}
        </span>
      </div>
      <div className={cn("relative overflow-hidden rounded-full bg-surface-3", detailed ? "h-2" : "h-1")}>
        <div className={cn("absolute inset-y-0 left-0 rounded-full", graduated ? "bg-ath" : "bg-brand/80")} style={{ width: `${Math.max(pct, 1.5)}%` }} />
      </div>
    </div>
  );
}
