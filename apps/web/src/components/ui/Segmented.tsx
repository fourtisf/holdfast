"use client";

import type { ReactNode } from "react";
import { cn } from "./cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  className,
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  size?: "sm" | "md";
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("inline-flex rounded-control bg-surface-2 p-0.5 ring-1 ring-line", className)}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-[8px] font-semibold transition-colors",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
              active ? "bg-surface-3 text-fg shadow-sm ring-1 ring-line-strong" : "text-muted hover:text-fg",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
