"use client";

import { useState } from "react";
import { cn } from "./cn";
import { CheckIcon, CopyIcon } from "./icons";

export function CopyButton({ value, label, className, size = 14 }: { value: string; label?: string; className?: string; size?: number }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const el = document.createElement("textarea");
      el.value = value;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      el.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? "Copied" : `Copy ${label ?? ""}`.trim()}
      aria-label={copied ? "Copied" : `Copy ${label ?? "to clipboard"}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md text-muted transition-colors hover:text-fg",
        copied && "text-brand hover:text-brand",
        className,
      )}
    >
      {copied ? <CheckIcon size={size} /> : <CopyIcon size={size} />}
      {label ? <span>{copied ? "Copied" : label}</span> : null}
    </button>
  );
}
