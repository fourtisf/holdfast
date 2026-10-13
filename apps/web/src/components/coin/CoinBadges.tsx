import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import { formatBpsAsPct, formatPct } from "@/lib/format";

export function VaultBuyingBadge({ className }: { className?: string }) {
  return (
    <Badge tone="floor" pulse className={className} title="Price is at or below the floor: the vault buys back">
      Vault buying
    </Badge>
  );
}

export function TriggerBadge({ triggerBps, className }: { triggerBps: number; className?: string }) {
  return (
    <Badge tone="muted" className={className} title={`Floor = ATH × (1 − ${formatBpsAsPct(triggerBps)}), permanent`}>
      Floor −{formatBpsAsPct(triggerBps)}
    </Badge>
  );
}

export function ChangePct({ value, className }: { value: number; className?: string }) {
  const tone = value > 0.005 ? "text-buy" : value < -0.005 ? "text-sell" : "text-muted";
  return <span className={cn("tabular", tone, className)}>{formatPct(value, { signed: true })}</span>;
}
