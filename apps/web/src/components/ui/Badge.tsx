import type { ReactNode } from "react";
import { cn } from "./cn";

export type Tone = "brand" | "floor" | "vault" | "buy" | "sell" | "ath" | "payout" | "muted";

const tones: Record<Tone, string> = {
  brand: "bg-brand/12 text-brand ring-brand/25",
  floor: "bg-floor/12 text-floor ring-floor/25",
  vault: "bg-vault/14 text-vault ring-vault/25",
  buy: "bg-buy/12 text-buy ring-buy/25",
  sell: "bg-sell/12 text-sell ring-sell/25",
  ath: "bg-ath/12 text-ath ring-ath/25",
  payout: "bg-payout/12 text-payout ring-payout/25",
  muted: "bg-surface-3 text-muted ring-line-strong",
};

export function Badge({
  tone = "muted",
  children,
  className,
  pulse,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  pulse?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ring-1 ring-inset",
        tones[tone],
        className,
      )}
    >
      {pulse ? <span className="size-1.5 animate-pulse-soft rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
