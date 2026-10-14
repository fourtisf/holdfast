import { CopyButton } from "@/components/ui/CopyButton";
import { XLogoIcon } from "@/components/ui/icons";
import { MOAT_CA, X_HANDLE, X_URL } from "@/lib/config";
import { shortAddress } from "@/lib/format";

/** Thin bar above the nav: the $MOAT contract address (or "Coming soon") and the X account. */
export function AnnouncementBar() {
  return (
    <div className="border-b border-brand/15 bg-brand/[0.06]">
      <div className="mx-auto flex h-9 max-w-[1600px] items-center justify-center gap-2.5 px-4 text-xs lg:px-6">
        <span className="font-display font-semibold tracking-wide text-brand">$MOAT</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="text-muted">CA:</span>
          {MOAT_CA ? (
            <>
              <span className="truncate font-mono text-fg">
                <span className="sm:hidden">{shortAddress(MOAT_CA, 6)}</span>
                <span className="hidden sm:inline">{MOAT_CA}</span>
              </span>
              <CopyButton value={MOAT_CA} label="" size={13} />
            </>
          ) : (
            <span className="font-semibold text-fg">Coming soon</span>
          )}
        </span>
        <span className="text-faint" aria-hidden>
          ·
        </span>
        <a href={X_URL} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1.5 font-semibold text-fg transition-colors hover:text-brand">
          <XLogoIcon size={12} />
          <span className="hidden sm:inline">Follow</span> {X_HANDLE}
        </a>
      </div>
    </div>
  );
}
