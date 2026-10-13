/** Pure display formatters. All inputs follow the @holdfast/core API conventions (SOL numbers, unix ms). */

const SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** 1234 → "1.23K", 2_500_000 → "2.5M". Values below 1000 keep up to `smallDecimals` decimals. */
export function formatCompact(value: number, smallDecimals = 2): string {
  if (!Number.isFinite(value)) return "–";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = abs / size;
      const decimals = scaled >= 100 ? 1 : 2;
      return `${sign}${trimZeros(scaled.toFixed(decimals))}${suffix}`;
    }
  }
  return `${sign}${trimZeros(abs.toFixed(smallDecimals))}`;
}

/** SOL amounts with precision that adapts to magnitude. `formatSol(0.01534)` → "0.0153". */
export function formatSolAmount(value: number): string {
  if (!Number.isFinite(value)) return "–";
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs >= 10_000) return formatCompact(value);
  if (abs >= 100) return trimZeros(value.toFixed(1));
  if (abs >= 1) return trimZeros(value.toFixed(2));
  if (abs >= 0.01) return trimZeros(value.toFixed(3));
  if (abs >= 0.0001) return trimZeros(value.toFixed(4));
  if (abs >= 0.000001) return trimZeros(value.toFixed(6));
  return value < 0 ? ">-0.000001" : "<0.000001";
}

export function formatSol(value: number): string {
  return `${formatSolAmount(value)} SOL`;
}

/** Market caps are in SOL in the API. */
export function formatMarketCap(valueSol: number): string {
  return `${formatCompact(valueSol, valueSol < 10 ? 2 : 1)} SOL`;
}

/** Token amounts are whole tokens. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "–";
  if (Math.abs(value) < 1 && value !== 0) return trimZeros(value.toFixed(4));
  return formatCompact(value, 0);
}

/**
 * Tiny memecoin prices use subscript-zero notation: 0.0000000281 → "0.0₇281".
 * Prices ≥ 0.001 are printed with 4 significant digits.
 */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "–";
  if (value === 0) return "0";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1) return sign + trimZeros(abs.toFixed(abs >= 1000 ? 0 : 4));
  if (abs >= 0.001) return sign + trimZeros(abs.toPrecision(4));
  let exponent = Math.floor(Math.log10(abs));
  let digits = Math.round(abs * 10 ** (-exponent + 3)); // 4 significant digits
  if (digits >= 10_000) {
    digits = 1000;
    exponent += 1;
  }
  const zeros = -exponent - 1;
  const mantissa = String(digits).replace(/0+$/, "") || "0";
  const sub = String(zeros)
    .split("")
    .map((d) => SUBSCRIPT_DIGITS[Number(d)])
    .join("");
  return `${sign}0.0${sub}${mantissa}`;
}

/** Values already in percent units (e.g. change24hPct = 12.5 → "+12.5%"). */
export function formatPct(value: number, { signed = false, decimals }: { signed?: boolean; decimals?: number } = {}): string {
  if (!Number.isFinite(value)) return "–";
  const abs = Math.abs(value);
  const d = decimals ?? (abs >= 100 ? 0 : abs >= 10 ? 1 : 2);
  const body = trimZeros(abs.toFixed(d));
  const sign = value < 0 ? "-" : signed && value > 0 ? "+" : "";
  return `${sign}${body}%`;
}

/** Fractions 0..1 (e.g. Holder.share) as a percentage. Very small non-zero shares stay visible. */
export function formatShare(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return "0%";
  const pct = fraction * 100;
  if (pct < 0.01) return "<0.01%";
  return formatPct(pct);
}

export function formatMultiplier(weight: number): string {
  return `${weight.toFixed(2)}×`;
}

export function formatBpsAsPct(bps: number): string {
  return `${trimZeros((bps / 100).toFixed(2))}%`;
}

export function shortAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 1) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

/** "now", "12s", "5m", "3h", "2d", "3mo" (compact, for dense tables). */
export function formatAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

export function formatRelativeTime(ts: number, now: number): string {
  const short = formatAgo(ts, now);
  return short === "now" ? "just now" : `${short} ago`;
}

/** Duration like "6d 4h", "3h 12m", "45m", "30s". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Countdown "mm:ss" (or "h:mm:ss" past an hour). Negative values clamp to 00:00. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
