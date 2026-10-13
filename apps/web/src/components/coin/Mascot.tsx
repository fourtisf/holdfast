import { useId } from "react";
import { mascotPalette } from "@/lib/hash";

const INK = "#0b0d12";

/**
 * Deterministic placeholder mascot: a little holdfast creature gripping its rock. Colors and features
 * are derived from the seed (the mint), so every coin without an uploaded image looks distinct.
 */
export function Mascot({ seed, className, title }: { seed: string; className?: string; title?: string }) {
  const p = mascotPalette(seed);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const bg = `bg-${uid}`;
  const body = `body-${uid}`;

  const eye = (cx: number, wink: boolean) =>
    wink || p.eyes === "happy" ? (
      <path d={`M${cx - 3.4} ${31.5} q3.4 -3.6 6.8 0`} stroke={INK} strokeWidth="2.2" strokeLinecap="round" fill="none" />
    ) : (
      <g>
        <circle cx={cx} cy={31} r="4.3" fill="#fff" />
        <circle cx={cx + 0.6} cy={31.6} r="2.4" fill={INK} />
        <circle cx={cx + 1.4} cy={30.4} r="0.8" fill="#fff" />
      </g>
    );

  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label={title ?? "Coin mascot"}>
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={p.bgFrom} />
          <stop offset="1" stopColor={p.bgTo} />
        </linearGradient>
        <radialGradient id={body} cx="0.38" cy="0.3" r="0.8">
          <stop offset="0" stopColor={p.belly} stopOpacity="0.55" />
          <stop offset="0.45" stopColor={p.body} />
          <stop offset="1" stopColor={p.bodyDark} />
        </radialGradient>
      </defs>
      <rect width="64" height="64" fill={`url(#${bg})`} />
      <circle cx="52" cy="12" r="1.2" fill="#fff" opacity="0.35" />
      <circle cx="10" cy="20" r="0.9" fill="#fff" opacity="0.25" />
      <circle cx="56" cy="30" r="0.7" fill="#fff" opacity="0.3" />

      {/* rock */}
      <ellipse cx="32" cy="60" rx="27" ry="8.5" fill="#000" opacity="0.35" />
      <path d="M8 64c2-7 9-10 24-10s22 3 24 10Z" fill={p.bgTo} stroke="#000" strokeOpacity="0.25" />

      {/* holdfast roots */}
      <g stroke={p.bodyDark} strokeWidth="3" strokeLinecap="round" fill="none">
        <path d="M23 47c-2 4-6 5-8 9" />
        <path d="M28 49c-1 3-2 5-2 8" />
        <path d="M36 49c1 3 2 5 2 8" />
        <path d="M41 47c2 4 6 5 8 9" />
      </g>

      {/* crest */}
      {p.crest === "frond" ? <path d="M32 15c-1-6 3-10 9-11-1 5-4 9-9 11Z" fill={p.accent} stroke={p.bodyDark} strokeWidth="1" /> : null}
      {p.crest === "sprout" ? (
        <g fill={p.accent}>
          <path d="M31 15c-5-1-8-4-8-8 5 0 8 3 8 8Z" />
          <path d="M33 15c5-1 8-4 8-8-5 0-8 3-8 8Z" />
        </g>
      ) : null}
      {p.crest === "curl" ? <path d="M32 15c0-5 6-6 6-2 0 2-3 2-3 0" stroke={p.accent} strokeWidth="2.4" strokeLinecap="round" fill="none" /> : null}

      {/* body */}
      <path d="M13 37c0-14 8-23 19-23s19 9 19 23c0 9-7 13-19 13S13 46 13 37Z" fill={`url(#${body})`} />
      <ellipse cx="32" cy="41" rx="10" ry="6.5" fill={p.belly} opacity="0.55" />

      {eye(25, false)}
      {eye(39, p.eyes === "wink")}
      {p.cheeks ? (
        <g fill="#ff7d9c" opacity="0.5">
          <ellipse cx="20.5" cy="37.5" rx="3" ry="1.8" />
          <ellipse cx="43.5" cy="37.5" rx="3" ry="1.8" />
        </g>
      ) : null}
      <path d="M28.5 38.5q3.5 3.4 7 0" stroke={INK} strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  );
}
