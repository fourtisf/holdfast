import { cn } from "@/components/ui/cn";

/** 0.1× at purchase → 1.0× after 7 days, optionally marking where a position sits. */
export function WeightRamp({ marker, className }: { marker?: number; className?: string }) {
  const w = 240;
  const h = 72;
  const x = (days: number) => 8 + (days / 8) * (w - 16);
  const y = (weight: number) => h - 14 - weight * (h - 26);
  const m = marker !== undefined ? Math.min(1, Math.max(0.1, marker)) : undefined;
  const mDays = m !== undefined ? ((m - 0.1) / 0.9) * 7 : 0;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn("w-full", className)} role="img" aria-label="Weight grows from 0.1× to 1.0× over 7 days">
      <line x1={x(0)} x2={x(8)} y1={y(0)} y2={y(0)} stroke="var(--color-line-strong)" />
      <line x1={x(0)} x2={x(8)} y1={y(1)} y2={y(1)} stroke="var(--color-line)" strokeDasharray="3 4" />
      <path d={`M${x(0)} ${y(0.1)} L${x(7)} ${y(1)} L${x(8)} ${y(1)}`} stroke="var(--color-brand)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <path d={`M${x(0)} ${y(0.1)} L${x(7)} ${y(1)} L${x(8)} ${y(1)} L${x(8)} ${y(0)} L${x(0)} ${y(0)} Z`} fill="var(--color-brand)" opacity="0.08" />
      <circle cx={x(0)} cy={y(0.1)} r="3.5" fill="var(--color-brand)" />
      <circle cx={x(7)} cy={y(1)} r="3.5" fill="var(--color-brand)" />
      {m !== undefined ? <circle cx={x(mDays)} cy={y(m)} r="5" fill="var(--color-fg)" stroke="var(--color-bg)" strokeWidth="2" /> : null}
      <text x={x(0)} y={y(0.1) - 8} fill="var(--color-muted)" fontSize="10">
        0.1×
      </text>
      <text x={x(7) - 6} y={y(1) - 7} fill="var(--color-muted)" fontSize="10" textAnchor="end">
        1.0×
      </text>
      <text x={x(0)} y={h - 2} fill="var(--color-faint)" fontSize="9">
        buy
      </text>
      <text x={x(7)} y={h - 2} fill="var(--color-faint)" fontSize="9" textAnchor="middle">
        7 days
      </text>
    </svg>
  );
}
