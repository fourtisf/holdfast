import type { ReactNode } from "react";
import { cn } from "./cn";

export function EmptyState({
  title,
  body,
  action,
  icon,
  className,
}: {
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-10 text-center", className)}>
      {icon ? <div className="mb-1 text-faint">{icon}</div> : null}
      <p className="text-sm font-semibold text-fg">{title}</p>
      {body ? <p className="max-w-sm text-sm text-muted">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-control border border-sell/30 bg-sell/10 px-3 py-2 text-sm text-sell", className)}>{children}</div>;
}
