import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps } from "react";
import { cn } from "./cn";

type Variant = "primary" | "secondary" | "ghost" | "buy" | "sell" | "outline";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary: "bg-brand text-brand-ink hover:bg-brand-strong",
  secondary: "bg-surface-3 text-fg hover:bg-line-strong",
  ghost: "text-muted hover:text-fg hover:bg-surface-3",
  outline: "border border-line-strong text-fg hover:border-faint hover:bg-surface-2",
  buy: "bg-buy text-[#03140a] hover:brightness-110",
  sell: "bg-sell text-white hover:brightness-110",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-5 text-[15px] gap-2",
};

export function buttonClass(variant: Variant = "primary", size: Size = "md", className?: string) {
  return cn(
    "inline-flex shrink-0 items-center justify-center rounded-control font-semibold whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45",
    variants[variant],
    sizes[size],
    className,
  );
}

export function Button({ variant, size, className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}

export function ButtonLink({ variant, size, className, ...props }: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}
