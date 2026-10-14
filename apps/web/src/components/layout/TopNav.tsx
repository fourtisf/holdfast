"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useHowItWorks } from "@/components/how-it-works/HowItWorksProvider";
import { cn } from "@/components/ui/cn";
import { BookIcon } from "@/components/ui/icons";
import { USE_MOCKS } from "@/lib/config";
import { CurrencyToggle } from "@/lib/currency";
import { Logo } from "./Logo";
import { PayoutCountdownPill } from "./PayoutCountdown";
import { WalletButton } from "./WalletButton";

export const NAV_LINKS = [
  { href: "/", label: "Coins" },
  { href: "/create", label: "Create" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/profile", label: "Profile" },
] as const;

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" || pathname.startsWith("/coin/") : pathname.startsWith(href);
}

export function TopNav() {
  const pathname = usePathname();
  const how = useHowItWorks();
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-[var(--nav-height)] max-w-[1600px] items-center gap-3 px-4 lg:px-6">
        <Logo />
        {USE_MOCKS ? (
          <span
            className="hidden rounded-md bg-vault/15 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-vault uppercase sm:inline"
            title="NEXT_PUBLIC_USE_MOCKS=1: generated data, no backend"
          >
            Mock data
          </span>
        ) : null}
        <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label="Main">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                "rounded-lg px-3 py-2 text-sm font-semibold transition-colors",
                isActive(pathname, link.href) ? "bg-surface-3 text-fg" : "text-muted hover:text-fg",
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <PayoutCountdownPill className="lg:hidden" />
          <CurrencyToggle className="hidden sm:inline-flex" />
          <button
            type="button"
            onClick={how.open}
            className="hidden h-[38px] items-center gap-2 rounded-control border border-line-strong px-3 text-sm font-semibold text-fg transition-colors hover:bg-surface-2 md:inline-flex"
          >
            <BookIcon size={16} className="text-brand" />
            How it works
          </button>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
