"use client";

import { cn } from "@/components/ui/cn";
import { StarIcon } from "@/components/ui/icons";
import { useWatchlist } from "@/lib/watchlist";

/** Star toggle for the browser-local watchlist. Safe inside links (stops the click). */
export function WatchButton({ mint, ticker, className, size = 16 }: { mint: string; ticker?: string; className?: string; size?: number }) {
  const { has, toggle } = useWatchlist();
  const on = has(mint);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(mint);
      }}
      aria-pressed={on}
      aria-label={on ? `Remove ${ticker ? `$${ticker}` : "coin"} from watchlist` : `Add ${ticker ? `$${ticker}` : "coin"} to watchlist`}
      title={on ? "In your watchlist" : "Add to watchlist"}
      className={cn("inline-flex items-center justify-center rounded-md transition-colors", on ? "text-ath" : "text-faint hover:text-fg", className)}
    >
      <StarIcon size={size} filled={on} />
    </button>
  );
}
