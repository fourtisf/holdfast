"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";
import { CloseIcon } from "./icons";

export function Modal({
  open,
  onClose,
  title,
  children,
  className,
  footer,
  dismissible = true,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  footer?: ReactNode;
  dismissible?: boolean;
  labelledBy?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) onClose();
      if (e.key === "Tab" && panel.current) {
        const focusable = panel.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])',
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, onClose, dismissible]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div className="absolute inset-0 animate-fade-in bg-[#040508]/75 backdrop-blur-sm" onClick={dismissible ? onClose : undefined} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cn(
          "relative flex max-h-[92dvh] w-full animate-slide-up flex-col overflow-hidden rounded-t-[20px] border border-line-strong bg-surface shadow-2xl outline-none sm:max-w-lg sm:rounded-[20px]",
          className,
        )}
      >
        {title || dismissible ? (
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div id={labelledBy} className="min-w-0 text-base font-semibold tracking-tight">
              {title}
            </div>
            {dismissible ? (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="-mr-1 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-3 hover:text-fg"
              >
                <CloseIcon size={18} />
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer ? <div className="border-t border-line px-5 py-4">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
