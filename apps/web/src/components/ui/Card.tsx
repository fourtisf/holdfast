import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-card border border-line bg-surface shadow-card", className)} {...props} />;
}

export function CardHeader({
  title,
  icon,
  action,
  className,
  subtitle,
}: {
  title: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  subtitle?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3 px-4 pt-4 pb-3", className)}>
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-fg">
          {icon ? <span className="text-muted">{icon}</span> : null}
          {title}
        </h2>
        {subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}
