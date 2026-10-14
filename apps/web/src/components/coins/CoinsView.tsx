"use client";

import type { CoinSort } from "@holdfast/core";
import { useCallback, useMemo, useState } from "react";
import { ButtonLink, Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState, ErrorNote } from "@/components/ui/States";
import { cn } from "@/components/ui/cn";
import { GridIcon, ListIcon, SearchIcon, CloseIcon, FilterIcon, StarIcon } from "@/components/ui/icons";
import { errorMessage } from "@/lib/api";
import { useDebounced } from "@/lib/hooks/useDebounced";
import { useNow } from "@/lib/hooks/useNow";
import { useStoredState } from "@/lib/hooks/useStoredState";
import { CurrencyToggle } from "@/lib/currency";
import { useCoins, type CoinFilters } from "@/lib/hooks/queries";
import { useWatchlist } from "@/lib/watchlist";
import { CoinCard, CoinCardSkeleton } from "./CoinCard";
import { CoinTable } from "./CoinTable";
import { StatCards } from "./StatCards";

type Tab = CoinSort | "watchlist";

const FILTERS: { value: Tab; label: string }[] = [
  { value: "watchlist", label: "Watchlist" },
  { value: "newest", label: "Newest" },
  { value: "trending", label: "Trending" },
  { value: "vault_buying", label: "Vault buying" },
  { value: "top_payouts", label: "Top payouts" },
  { value: "biggest_vault", label: "Biggest vault" },
];

type View = "grid" | "table";
const isView = (v: unknown): v is View => v === "grid" || v === "table";

type Venue = "all" | "curve" | "graduated";
type Age = "any" | "1" | "24" | "168";
type MinMc = "any" | "50" | "100" | "400";
interface ListFilters {
  venue: Venue;
  age: Age;
  minMc: MinMc;
}
const DEFAULT_FILTERS: ListFilters = { venue: "all", age: "any", minMc: "any" };
const isFilters = (v: unknown): v is ListFilters =>
  typeof v === "object" &&
  v !== null &&
  ["all", "curve", "graduated"].includes((v as ListFilters).venue) &&
  ["any", "1", "24", "168"].includes((v as ListFilters).age) &&
  ["any", "50", "100", "400"].includes((v as ListFilters).minMc);

function toQuery(f: ListFilters, watchlist: readonly string[] | null): CoinFilters {
  return {
    graduated: f.venue === "all" ? null : f.venue === "graduated",
    maxAgeHours: f.age === "any" ? null : Number(f.age),
    minMcapSol: f.minMc === "any" ? null : Number(f.minMc),
    mints: watchlist,
  };
}

function activeFilterCount(f: ListFilters): number {
  return Number(f.venue !== "all") + Number(f.age !== "any") + Number(f.minMc !== "any");
}

export function CoinsView() {
  const [tab, setTab] = useState<Tab>("newest");
  const [query, setQuery] = useState("");
  const [view, setView] = useStoredState<View>("holdfast:coins-view", "grid", isView);
  const [filters, setFilters] = useStoredState<ListFilters>("holdfast:coin-filters", DEFAULT_FILTERS, isFilters);
  const [showFilters, setShowFilters] = useState(false);
  const watchlist = useWatchlist();
  const q = useDebounced(query.trim(), 250);
  const now = useNow(15_000);
  const sort: CoinSort = tab === "watchlist" ? "newest" : tab;
  const watching = tab === "watchlist";
  const coinFilters = useMemo(() => toQuery(filters, watching ? watchlist.list : null), [filters, watching, watchlist.list]);
  const { data, error, size, setSize, isLoading, isValidating } = useCoins(sort, q, 24, coinFilters, !watching || watchlist.list.length > 0);
  const filterCount = activeFilterCount(filters);
  const coins = watching && watchlist.list.length === 0 ? [] : (data?.flatMap((p) => p.items) ?? []);
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
                aria-selected={tab === f.value}
                onClick={() => setTab(f.value)}
                className={cn(
                  "flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold ring-1 transition-colors ring-inset",
                  tab === f.value ? "bg-fg text-bg ring-fg" : "bg-surface text-muted ring-line hover:text-fg hover:ring-line-strong",
                )}
              >
                {f.value === "vault_buying" ? (
                  <span className={cn("size-1.5 rounded-full", tab === f.value ? "bg-floor" : "animate-pulse-soft bg-floor")} />
                ) : null}
                {f.value === "watchlist" ? <StarIcon size={13} filled={tab === f.value} className={tab === f.value ? "" : "text-ath"} /> : null}
                {f.label}
                {f.value === "watchlist" && watchlist.list.length > 0 ? <span className="text-[11px] opacity-70 tabular">{watchlist.list.length}</span> : null}
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
            <button
              type="button"
              onClick={() => setShowFilters((v) => !v)}
              aria-expanded={showFilters}
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition-colors",
                filterCount > 0 ? "border-brand/50 text-brand" : "border-line text-muted hover:text-fg",
              )}
            >
              <FilterIcon size={14} />
              Filters{filterCount > 0 ? ` · ${filterCount}` : ""}
            </button>
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

        {showFilters ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-line bg-surface p-3 text-xs">
            <FilterGroup label="Venue">
              <Segmented
                size="sm"
                ariaLabel="Venue"
                value={filters.venue}
                onChange={(venue) => setFilters({ ...filters, venue })}
                options={[
                  { value: "all", label: "All" },
                  { value: "curve", label: "Bonding curve" },
                  { value: "graduated", label: "PumpSwap" },
                ]}
              />
            </FilterGroup>
            <FilterGroup label="Launched">
              <Segmented
                size="sm"
                ariaLabel="Launched within"
                value={filters.age}
                onChange={(age) => setFilters({ ...filters, age })}
                options={[
                  { value: "any", label: "Any time" },
                  { value: "1", label: "1h" },
                  { value: "24", label: "24h" },
                  { value: "168", label: "7d" },
                ]}
              />
            </FilterGroup>
            <FilterGroup label="Min market cap">
              <Segmented
                size="sm"
                ariaLabel="Minimum market cap"
                value={filters.minMc}
                onChange={(minMc) => setFilters({ ...filters, minMc })}
                options={[
                  { value: "any", label: "Any" },
                  { value: "50", label: "50 SOL" },
                  { value: "100", label: "100 SOL" },
                  { value: "400", label: "400 SOL" },
                ]}
              />
            </FilterGroup>
            <FilterGroup label="Show in">
              <CurrencyToggle className="inline-flex sm:hidden" />
              <span className="hidden text-faint sm:inline">SOL / USD toggle at the top</span>
            </FilterGroup>
            {filterCount > 0 ? (
              <button type="button" onClick={() => setFilters(DEFAULT_FILTERS)} className="font-semibold text-muted hover:text-fg sm:ml-auto">
                Reset
              </button>
            ) : null}
          </div>
        ) : null}

        {error ? <ErrorNote>Could not load coins: {errorMessage(error)}</ErrorNote> : null}

        {watching && watchlist.list.length === 0 ? (
          <div className="rounded-card border border-line bg-surface">
            <EmptyState title="Your watchlist is empty" body="Tap the star on any coin to follow it here. The list stays in this browser." />
          </div>
        ) : isLoading && coins.length === 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <CoinCardSkeleton key={i} />
            ))}
          </div>
        ) : coins.length === 0 && !error ? (
          <div className="rounded-card border border-line bg-surface">
            <EmptyState
              title={q ? `No coins match “${q}”` : filterCount > 0 ? "No coins match these filters" : sort === "vault_buying" ? "No vault is buying right now" : "No coins yet"}
              body={filterCount > 0 ? "Loosen a filter to see more." : sort === "vault_buying" ? "Every coin is trading above its floor." : "Be the first to launch one."}
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

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-semibold tracking-wider text-faint uppercase">{label}</span>
      {children}
    </div>
  );
}
