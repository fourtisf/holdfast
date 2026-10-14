/**
 * Launch-form moderation, shared by the API (rejects at submission) and the launcher (checks again
 * before anything goes on-chain). Text is normalized before matching so that "P3d0", "p.e.d.o" or
 * full-width letters do not slip through:
 *   NFKD → strip diacritics → lowercase → leetspeak digits/symbols to letters → drop everything
 *   that is not a letter or digit → collapse runs of the same character.
 *
 * Two lists:
 * - `blocked` terms reject the launch outright (built-in: child-abuse terms and common scam
 *   phrases; operators add more with MODERATION_BLOCKLIST_FILE, one term per line).
 * - `reserved` tickers/names (well-known assets and Holdfast's own $HOLD) are accepted but flagged
 *   for review, because impersonation is the most common launchpad scam.
 */

export type ModerationVerdict =
  | { action: "allow" }
  | { action: "review"; reasons: string[] }
  | { action: "block"; reasons: string[] };

export interface ModerationLists {
  /** Normalized with `normalizeForModeration`; matched as substrings (≥ 4 chars) or whole tokens (shorter). */
  blocked: readonly string[];
  /** Tickers / names that need a human look (exact match after normalization). */
  reserved: readonly string[];
}

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", $: "s", "!": "i", "|": "l", "+": "t" };

/** Lowercase letters/digits only, leetspeak mapped, repeated characters collapsed. */
export function normalizeForModeration(text: string): string {
  const folded = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[0134578@$!|+]/g, (c) => LEET[c] ?? c)
    .replace(/[^\p{L}\p{N}]/gu, "");
  return folded.replace(/(.)\1+/gu, "$1");
}

/**
 * Tokens of the text (split on anything but letters/digits), each normalized. Runs of one-letter
 * tokens are also joined ("p.e.d.o", "p e d o" → "pedo"), the usual way to spell a word apart.
 */
function tokens(text: string): string[] {
  const toks = text
    .normalize("NFKD")
    .split(/[^\p{L}\p{N}@$!|+]+/u)
    .map(normalizeForModeration)
    .filter(Boolean);
  const out = [...toks];
  let run = "";
  for (const t of [...toks, ""]) {
    if (t.length === 1) run += t;
    else {
      if (run.length > 1) out.push(normalizeForModeration(run));
      run = "";
    }
  }
  return out;
}

/**
 * Built-in blocked terms (normalized when used). Deliberately short: it covers what no launchpad may
 * ever host. Hate speech and local-language terms belong in the operator's blocklist file.
 */
export const DEFAULT_BLOCKED_TERMS: readonly string[] = [
  // child sexual abuse material
  "childporn",
  "chilporn",
  "pedo",
  "pedophile",
  "lolicon",
  "shotacon",
  "underageporn",
  "csam",
  // scam phrases aimed at the coin's own buyers
  "freesolairdrop",
  "claimairdrop",
  "doubleyoursol",
  "sendsolget",
  "walletdrainer",
  "seedphrase",
  "privatekey",
];

/** Well-known tickers/names a new coin should not impersonate without review. */
export const DEFAULT_RESERVED: readonly string[] = [
  "hold",
  "holdfast",
  "sol",
  "wsol",
  "solana",
  "usdc",
  "usdt",
  "btc",
  "bitcoin",
  "eth",
  "ethereum",
  "jup",
  "jupiter",
  "bonk",
  "wif",
  "pump",
  "pumpfun",
  "ray",
  "raydium",
  "trump",
  "melania",
];

export const DEFAULT_MODERATION_LISTS: ModerationLists = { blocked: DEFAULT_BLOCKED_TERMS, reserved: DEFAULT_RESERVED };

/** Parses a blocklist file: one term per line, `#` comments, blank lines ignored. */
export function parseBlocklist(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map(normalizeForModeration)
    .filter((t) => t.length > 0);
}

export function withExtraBlocked(lists: ModerationLists, extra: readonly string[]): ModerationLists {
  return { ...lists, blocked: [...new Set([...lists.blocked, ...extra])] };
}

/** Terms this long are matched anywhere (compounds such as "freesolairdrop"); shorter ones only as whole words. */
const SUBSTRING_MIN = 7;

function matches(term: string, joined: string, toks: readonly string[]): boolean {
  // "pedo" must not hit "torpedo", and "cp" not "cape": short terms only as whole tokens (plural ok).
  if (term.length >= SUBSTRING_MIN) return joined.includes(term);
  return toks.some((t) => t === term || t === `${term}s`);
}

export interface LaunchTextFields {
  name: string;
  ticker: string;
  description?: string;
  socials?: Partial<Record<"x" | "telegram" | "website", string>>;
}

/** Verdict for a launch form's text. */
export function moderateLaunchText(fields: LaunchTextFields, lists: ModerationLists = DEFAULT_MODERATION_LISTS): ModerationVerdict {
  const texts: [string, string][] = [
    ["name", fields.name],
    ["ticker", fields.ticker],
    ["description", fields.description ?? ""],
    ...Object.entries(fields.socials ?? {}).map(([k, v]) => [k, v ?? ""] as [string, string]),
  ];
  const blocked: string[] = [];
  const terms = lists.blocked.map(normalizeForModeration).filter(Boolean);
  for (const [field, text] of texts) {
    if (!text) continue;
    const joined = normalizeForModeration(text);
    const toks = tokens(text);
    for (const term of terms) if (matches(term, joined, toks)) blocked.push(`${field} contains a blocked term`);
  }
  if (blocked.length > 0) return { action: "block", reasons: [...new Set(blocked)] };

  const review: string[] = [];
  const ticker = normalizeForModeration(fields.ticker.replace(/^\$/, ""));
  const name = normalizeForModeration(fields.name);
  for (const r of lists.reserved.map(normalizeForModeration)) {
    if (ticker === r) review.push(`ticker matches the reserved asset "${r}"`);
    if (name === r) review.push(`name matches the reserved asset "${r}"`);
  }
  return review.length > 0 ? { action: "review", reasons: [...new Set(review)] } : { action: "allow" };
}

/** Free text (comments): does it contain a blocked term. Reserved names do not apply here. */
export function containsBlockedTerm(text: string, lists: ModerationLists = DEFAULT_MODERATION_LISTS): boolean {
  if (!text) return false;
  const joined = normalizeForModeration(text);
  const toks = tokens(text);
  return lists.blocked.map(normalizeForModeration).some((term) => term && matches(term, joined, toks));
}

export const REPORT_REASONS = ["scam", "impersonation", "nsfw", "hate", "illegal", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
