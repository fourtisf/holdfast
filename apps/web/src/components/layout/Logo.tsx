import Link from "next/link";

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="hf-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#9ff5cc" />
          <stop offset="1" stopColor="#3fd690" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#hf-logo)" />
      <path d="M16 6.5c-2.6 2.2-2.6 5.3 0 7.6 2.6 2.3 2.6 5.4 0 7.4" stroke="#04170e" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      <path
        d="M16 21.5c-1.8 1.3-4.6 1.6-6.5 3.5M16 21.5c1.8 1.3 4.6 1.6 6.5 3.5M16 21.5v4"
        stroke="#04170e"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
      />
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
