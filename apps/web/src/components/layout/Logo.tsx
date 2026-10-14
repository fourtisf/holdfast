import Link from "next/link";

/**
 * The Holdfast mark: claws gripping a rock on the floor, an arrow rising from it (brand/README.md).
 * Paths match brand/holdfast-mark.svg.
 */
/** The glyph's elements (plain SVG elements, so the OG image renderer can use them too). */
export function logoGlyph(color = "#04170e") {
  return [
    <path key="a" d="M21 22 L32 11 L43 22 M32 11 V35" fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />,
    <path key="c" d="M32 33 C22 33 17.5 40 19.5 48 M32 33 C42 33 46.5 40 44.5 48" fill="none" stroke={color} strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />,
    <circle key="r" cx="32" cy="45" r="6.5" fill={color} />,
    <path key="f" d="M15 55 H49" fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" />,
  ];
}

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="hf-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#9ff5cc" />
          <stop offset="1" stopColor="#3fd690" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#hf-logo)" />
      {logoGlyph()}
    </svg>
  );
}

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 rounded-lg" aria-label="Holdfast home">
      <LogoMark />
      <span className="text-[17px] font-bold tracking-tight text-fg">Holdfast</span>
    </Link>
  );
}
