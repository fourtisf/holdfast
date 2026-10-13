"use client";

import type { ReactNode } from "react";
import { cn } from "./cn";

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: ReactNode; count?: number }[];
  className?: string;
}) {
  return (
    <div role="tablist" className={cn("scrollbar-none flex gap-1 overflow-x-auto border-b border-line px-2", className)}>
      {tabs.map((tab) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(tab.value)}
            className={cn(
              "relative -mb-px flex shrink-0 items-center gap-2 px-3 py-3 text-sm font-semibold transition-colors",
              active ? "text-fg" : "text-muted hover:text-fg",
            )}
          >
            {tab.label}
            {tab.count !== undefined ? <span className="rounded-full bg-surface-3 px-1.5 py-px text-[11px] text-muted tabular">{tab.count}</span> : null}
            <span className={cn("absolute inset-x-2 bottom-0 h-0.5 rounded-full", active ? "bg-brand" : "bg-transparent")} />
          </button>
        );
      })}
    </div>
  );
}
