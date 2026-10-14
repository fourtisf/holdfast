import Link from "next/link";

/**
 * The Holdfast mark: a monogram H built like a rampart, two walls with a chevron rising between them
 * (brand/README.md). Geometry matches brand/holdfast-mark.svg; the elements are plain SVG (no
 * components) so the Open Graph image renderer can draw them too.
 */
const LIT = ["14,28 24,20 24,88 14,88", "76,20 86,28 86,88 76,88", "34,54 50,41.2 50,58.2 34,71"];
const SHADE = ["24,20 34,12 34,88 24,88", "66,12 76,20 76,88 66,88", "50,41.2 66,54 66,71 50,58.2"];

export function logoMarkElements(id = "hf") {
  return [
    <defs key="d">
      <linearGradient id={`${id}-lit`} x1="0.1" y1="0" x2="0.9" y2="1">
        <stop offset="0" stopColor="#d4ffe9" />
        <stop offset="0.42" stopColor="#5fe8a8" />
        <stop offset="1" stopColor="#0c8653" />
      </linearGradient>
      <linearGradient id={`${id}-shade`} x1="0.1" y1="0" x2="0.9" y2="1">
        <stop offset="0" stopColor="#1fae72" />
        <stop offset="1" stopColor="#06402a" />
      </linearGradient>
    </defs>,
    ...LIT.map((points, i) => <polygon key={`l${i}`} points={points} fill={`url(#${id}-lit)`} />),
    ...SHADE.map((points, i) => <polygon key={`s${i}`} points={points} fill={`url(#${id}-shade)`} />),
  ];
}

/** The bare mark (viewBox cropped to its bounds, 72 × 76). */
export function LogoMark({ height = 26 }: { height?: number }) {
  return (
    <svg height={height} width={(height * 72) / 76} viewBox="14 12 72 76" aria-hidden>
      {logoMarkElements()}
    </svg>
  );
}

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 rounded-lg" aria-label="Holdfast home">
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-[0.16em] text-fg">HOLDFAST</span>
    </Link>
  );
}
