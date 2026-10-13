import { cn } from "@/components/ui/cn";
import { formatMarketCap } from "@/lib/format";

/**
 * Where the price sits between the floor (left) and the ATH (right). At the floor the vault is buying,
 * so the bar switches to the floor color and pulses.
 */
export function FloorAthBar({
  progress,
  vaultBuying,
  floorMc,
  athMc,
  detailed = false,
  className,
}: {
  progress: number;
  vaultBuying: boolean;
  floorMc?: number;
  athMc?: number;
  detailed?: boolean;
  className?: string;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 1000) / 10;
  return (
    <div className={cn("w-full", className)}>
      <div
        className={cn(
          "flex items-center justify-between font-medium text-faint uppercase",
          detailed ? "mb-2 text-[11px] tracking-wider" : "mb-1 text-[10px] tracking-wide",
        )}
      >
        <span className={cn(vaultBuying && "text-floor")}>Floor</span>
        <span className={cn("normal-case tracking-normal", vaultBuying ? "text-floor" : "text-muted")}>
          {vaultBuying
            ? "At floor · vault buying"
            : pct >= 99.5
              ? "At ATH"
              : detailed
                ? `${pct.toFixed(0)}% of the way from floor to ATH`
                : `${pct.toFixed(0)}%`}
        </span>
        <span>ATH</span>
      </div>
      <div
        className={cn("relative rounded-full bg-surface-3", detailed ? "h-2.5" : "h-1.5")}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Price position between floor and ATH"
      >
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full", vaultBuying ? "animate-pulse-soft bg-floor" : "bg-linear-to-r from-floor via-brand to-ath")}
          style={{ width: `${Math.max(pct, vaultBuying ? 4 : 2)}%` }}
        />
        <div
          className={cn(
            "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg",
            detailed ? "size-4" : "size-2.5",
            vaultBuying ? "bg-floor" : "bg-fg",
          )}
          style={{ left: `clamp(${detailed ? 8 : 5}px, ${pct}%, calc(100% - ${detailed ? 8 : 5}px))` }}
        />
      </div>
      {detailed && floorMc !== undefined && athMc !== undefined ? (
        <div className="mt-2 flex justify-between text-xs tabular">
          <span className="text-floor">{formatMarketCap(floorMc)}</span>
          <span className="text-ath">{formatMarketCap(athMc)}</span>
        </div>
      ) : null}
    </div>
  );
}
