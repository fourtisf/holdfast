"use client";

import type { CoinSort } from "@holdfast/core";
import { useCallback, useState } from "react";
import { ButtonLink, Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState, ErrorNote } from "@/components/ui/States";
import { cn } from "@/components/ui/cn";
import { GridIcon, ListIcon, SearchIcon, CloseIcon } from "@/components/ui/icons";
import { errorMessage } from "@/lib/api";
import { useDebounced } from "@/lib/hooks/useDebounced";
import { useNow } from "@/lib/hooks/useNow";
import { useStoredState } from "@/lib/hooks/useStoredState";
import { useCoins } from "@/lib/hooks/queries";
import { CoinCard, CoinCardSkeleton } from "./CoinCard";
import { CoinTable } from "./CoinTable";
import { StatCards } from "./StatCards";

const FILTERS: { value: CoinSort; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "trending", label: "Trending" },
  { value: "vault_buying", label: "Vault buying" },
  { value: "top_payouts", label: "Top payouts" },
  { value: "biggest_vault", label: "Biggest vault" },
];

type View = "grid" | "table";
const isView = (v: unknown): v is View => v === "grid" || v === "table";

export function CoinsView() {
  const [sort, setSort] = useState<CoinSort>("newest");
  const [query, setQuery] = useState("");
  const [view, setView] = useStoredState<View>("holdfast:coins-view", "grid", isView);
  const q = useDebounced(query.trim(), 250);
  const now = useNow(15_000);
  const { data, error, size, setSize, isLoading, isValidating } = useCoins(sort, q);
  const coins = data?.flatMap((p) => p.items) ?? [];
  const hasMore = Boolean(data?.[data.length - 1]?.nextCursor);
  const loadingMore = isValidating && size > (data?.length ?? 0);
  const loadMore = useCallback(() => void setSize((s) => s + 1), [setSize]);

  return (
    <div className="flex flex-col gap-5">
      <section>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-fg sm:text-[28px]">Coins that defend their floor</h1>
            <p className="mt-1 max-w-xl text-sm text-muted">
              Creator fees fill each coin&apos;s vault. It buys back at the floor and pays holders every 2 minutes.
            </p>
          </div>
          <ButtonLink href="/create">
            Launch a coin
          </ButtonLink>
        </div>
        <StatCards />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0" role="tablist" aria-label="Sort coins">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={sort === f.value}
                onClick={() => setSort(f.value)}
                className={cn(
                  "flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold ring-1 transition-colors ring-inset",
                  sort === f.value ? "bg-fg text-bg ring-fg" : "bg-surface text-muted ring-line hover:text-fg hover:ring-line-strong",
                )}
              >
                {f.value === "vault_buying" ? (
                  <span className={cn("size-1.5 rounded-full", sort === f.value ? "bg-floor" : "animate-pulse-soft bg-floor")} />
                ) : null}
                {f.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 md:ml-auto">
            <label className="relative flex h-9 min-w-0 flex-1 items-center md:w-64 md:flex-none">
              <SearchIcon size={15} className="pointer-events-none absolute left-3 text-faint" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, ticker or mint"
                aria-label="Search coins"
                className="h-full w-full rounded-full border border-line bg-surface pr-8 pl-9 text-sm text-fg placeholder:text-faint focus:border-line-strong focus:outline-none [&::-webkit-search-cancel-button]:hidden"
              />
              {query ? (
                <button type="button" onClick={() => setQuery("")} className="absolute right-2.5 text-faint hover:text-fg" aria-label="Clear search">
                  <CloseIcon size={14} />
                </button>
              ) : null}
            </label>
            <Segmented
              ariaLabel="View"
              value={view}
              onChange={setView}
              options={[
                { value: "grid", label: <GridIcon size={15} />, title: "Grid view" },
                { value: "table", label: <ListIcon size={15} />, title: "Table view" },
              ]}
            />
          </div>
        </div>

        {error ? <ErrorNote>Could not load coins: {errorMessage(error)}</ErrorNote> : null}

        {isLoading && coins.length === 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <CoinCardSkeleton key={i} />
            ))}
          </div>
        ) : coins.length === 0 && !error ? (
          <div className="rounded-card border border-line bg-surface">
            <EmptyState
              title={q ? `No coins match “${q}”` : sort === "vault_buying" ? "No vault is buying right now" : "No coins yet"}
              body={sort === "vault_buying" ? "Every coin is trading above its floor." : "Be the first to launch one."}
              action={<ButtonLink href="/create">Launch a coin</ButtonLink>}
            />
          </div>
        ) : view === "grid" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4">
            {coins.map((coin) => (
              <CoinCard key={coin.mint} coin={coin} now={now} />
            ))}
          </div>
        ) : (
          <CoinTable coins={coins} now={now} />
        )}

        {hasMore ? (
          <div className="flex justify-center pt-1">
            <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
