/** Number and link formatting for bot messages. */

const LAMPORTS_DECIMALS = 9;

/**
 * `raw` base units with `decimals` decimals, keeping at most `maxSignificant` significant decimals
 * (leading zeros of an amount below 1 do not count), rounded half up, trailing zeros trimmed and
 * the whole part grouped by thousands: 1234.56789 → "1,234.5679", 0.000123456 → "0.0001235".
 */
export function formatUnits(raw: bigint, decimals: number, maxSignificant = 4): string {
  if (raw < 0n) return `-${formatUnits(-raw, decimals, maxSignificant)}`;
  if (raw === 0n) return "0";
  const scale = 10n ** BigInt(decimals);
  let places: number;
  if (raw >= scale) {
    places = Math.min(maxSignificant, decimals);
  } else {
    const firstNonZero = raw.toString().padStart(decimals, "0").search(/[1-9]/);
    places = Math.min(decimals, firstNonZero + maxSignificant);
  }
  const unit = 10n ** BigInt(decimals - places);
  const rounded = (raw + unit / 2n) / unit;
  const placesScale = 10n ** BigInt(places);
  const whole = (rounded / placesScale).toLocaleString("en-US");
  const frac = places === 0 ? "" : (rounded % placesScale).toString().padStart(places, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Lamports as SOL, at most 4 significant decimals: 12_345_678n → "0.01235". */
export function formatSol(lamports: bigint): string {
  return formatUnits(lamports, LAMPORTS_DECIMALS);
}

/** Token base units as whole tokens; 1,000 tokens and up are shown without decimals. */
export function formatTokens(raw: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  return raw / scale >= 1000n ? formatUnits(raw, decimals, 0) : formatUnits(raw, decimals);
}

/** A price in SOL per whole token with 4 significant digits: 1.5e-7 → "0.00000015". */
export function formatPrice(solPerToken: number): string {
  if (!Number.isFinite(solPerToken) || solPerToken <= 0) return "0";
  return solPerToken.toLocaleString("en-US", { maximumSignificantDigits: 4, useGrouping: true });
}

/** Weight multiplier from parts per million: 523_000n → "0.52x". */
export function formatMultiplier(ppm: bigint): string {
  return `${(Number(ppm) / 1_000_000).toFixed(2)}x`;
}

/** First and last four characters: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" → "7xKX…gAsU". */
export function shortAddress(address: string): string {
  const chars = Array.from(address);
  return chars.length <= 10 ? address : `${chars.slice(0, 4).join("")}…${chars.slice(-4).join("")}`;
}

/**
 * The first `max` characters of user text, counted in code points: cutting UTF-16 units can split an
 * emoji in half, and Telegram refuses a message with half an emoji (400), so it would never arrive.
 */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** `clip` with "…" when something was cut. */
export function ellipsize(text: string, max: number): string {
  const cut = clip(text, max);
  return cut === text ? text : `${cut}…`;
}

export type Cluster = "mainnet-beta" | "devnet" | "testnet" | "localnet";

export interface Links {
  /** Web app origin without a trailing slash. */
  webUrl: string;
  cluster: Cluster;
}

export function coinUrl(links: Links, mint: string): string {
  return `${links.webUrl}/coin/${mint}`;
}

export function solscanTxUrl(sig: string, cluster: Cluster): string {
  const base = `https://solscan.io/tx/${sig}`;
  if (cluster === "mainnet-beta") return base;
  if (cluster === "localnet") return `${base}?cluster=custom&customUrl=${encodeURIComponent("http://127.0.0.1:8899")}`;
  return `${base}?cluster=${cluster}`;
}

export function solscanAccountUrl(address: string, cluster: Cluster): string {
  const base = `https://solscan.io/account/${address}`;
  if (cluster === "mainnet-beta") return base;
  if (cluster === "localnet") return `${base}?cluster=custom&customUrl=${encodeURIComponent("http://127.0.0.1:8899")}`;
  return `${base}?cluster=${cluster}`;
}

/** Deep links into the bot: `t.me/<bot>?start=<payload>` (private chat) or `?startgroup=<payload>` (add to a group). */
export function botLink(botUsername: string | null, payload?: string, group = false): string | null {
  if (!botUsername) return null;
  const base = `https://t.me/${botUsername}`;
  return payload === undefined ? (group ? `${base}?startgroup=true` : base) : `${base}?${group ? "startgroup" : "start"}=${encodeURIComponent(payload)}`;
}

/** A SOL amount from the API (a float), at most 4 significant decimals: 0.0153 → "0.0153", 52.31 → "52.31". */
export function formatSolNumber(sol: number): string {
  if (!Number.isFinite(sol) || sol <= 0) return "0";
  if (sol >= 1000) return Math.round(sol).toLocaleString("en-US");
  if (sol >= 1) return sol.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return sol.toLocaleString("en-US", { maximumSignificantDigits: 3 });
}

/** Big token amounts in short form: 3_500_000 → "3.5M", 12_300 → "12.3K". */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
}
