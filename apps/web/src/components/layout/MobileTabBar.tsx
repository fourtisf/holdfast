"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useHowItWorks } from "@/components/how-it-works/HowItWorksProvider";
import { cn } from "@/components/ui/cn";
import { BookIcon, CoinsIcon, PlusIcon, TrophyIcon, UserIcon } from "@/components/ui/icons";
import { isActive } from "./TopNav";

const ITEMS = [
  { href: "/", label: "Coins", icon: CoinsIcon },
  { href: "/create", label: "Create", icon: PlusIcon },
  { href: "/leaderboard", label: "Ranks", icon: TrophyIcon },
  { href: "/profile", label: "Profile", icon: UserIcon },
] as const;

export function MobileTabBar() {
  const pathname = usePathname();
  const how = useHowItWorks();
  const item = "flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] font-semibold";
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/92 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden" aria-label="Main">
      <div className="flex">
        {ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link key={href} href={href} className={cn(item, active ? "text-brand" : "text-muted")} aria-current={active ? "page" : undefined}>
              <Icon size={20} />
              {label}
            </Link>
          );
        })}
        <button type="button" onClick={how.open} className={cn(item, "text-muted")}>
          <BookIcon size={20} />
          How it works
        </button>
      </div>
    </nav>
  );
}
