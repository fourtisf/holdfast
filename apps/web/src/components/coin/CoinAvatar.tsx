"use client";

import { useState } from "react";
import { cn } from "@/components/ui/cn";
import { Mascot } from "./Mascot";

/** Uploaded coin image, or the deterministic mascot when there is none (or it fails to load). */
export function CoinAvatar({
  mint,
  imageUrl,
  name,
  className,
  rounded = "rounded-xl",
}: {
  mint: string;
  imageUrl: string | null;
  name: string;
  className?: string;
  rounded?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = imageUrl && !failed;
  return (
    <div className={cn("relative shrink-0 overflow-hidden bg-surface-3 ring-1 ring-white/5", rounded, className)}>
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- user uploads come from arbitrary hosts
        <img src={imageUrl} alt={name} className="size-full object-cover" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <Mascot seed={mint} className="size-full" title={`${name} mascot`} />
      )}
    </div>
  );
}
