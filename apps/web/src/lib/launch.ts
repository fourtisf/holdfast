import { LAUNCH_FEE_LAMPORTS, TRIGGER_OPTIONS_BPS, type LaunchQuote, type LaunchRequest, type LaunchStatus, type Socials, type TriggerBps } from "@holdfast/core";

/** SPEC §2 target. The real cost comes from GET /launch/quote; this is only the fallback while it loads. */
export const SPEC_LAUNCH_FEE_SOL = Number(LAUNCH_FEE_LAMPORTS) / 1e9;
/** pump.fun's limit for the name, in UTF-8 bytes: a plain letter takes 1, an accented letter 2, an emoji 4. */
export const NAME_MAX = 32;
export const TICKER_MAX = 10;
export const DESCRIPTION_MAX = 500;
export const DEV_BUY_MAX_SOL = 10;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export interface LaunchForm {
  name: string;
  ticker: string;
  description: string;
  imageUrl: string | null;
  x: string;
  telegram: string;
  website: string;
  triggerBps: TriggerBps;
  devBuy: string;
  /** Claims the creator share; empty = the wallet the deposit comes from. */
  creatorWallet: string;
}

export type LaunchErrors = Partial<Record<keyof LaunchForm, string>>;

/** "$kelp lord" → "KELPLORD": letters and digits only, uppercase, capped. */
export function normalizeTicker(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, TICKER_MAX);
}

const HANDLE = /^@?([A-Za-z0-9_]{1,32})$/;
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Accept a handle ("@kelp") or a URL for X / Telegram; websites get https:// when missing. */
export function normalizeSocial(kind: keyof Socials, input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (kind === "x" || kind === "telegram") {
    const handle = HANDLE.exec(value);
    if (handle) return kind === "x" ? `https://x.com/${handle[1]}` : `https://t.me/${handle[1]}`;
  }
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes(".")) return null;
    if (kind === "x" && !/(^|\.)(x|twitter)\.com$/i.test(url.hostname)) return null;
    if (kind === "telegram" && !/(^|\.)(t\.me|telegram\.me)$/i.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function parseDevBuy(input: string): number | null {
  if (input.trim() === "") return 0;
  const n = Number(input);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** SOL the user must send: the quoted launch cost + dev buy (+ dev-buy accounts/buffer), or the spec fee while loading. */
export function requiredDepositSol(devBuySol: number, quote?: LaunchQuote | null): number {
  if (quote) return quote.requiredSol;
  return Math.round((SPEC_LAUNCH_FEE_SOL + devBuySol) * 1e9) / 1e9;
}

/** Launch cost shown in copy ("Send X SOL"): the quote once loaded, the spec fee before. */
export function launchFeeSol(quote?: LaunchQuote | null): number {
  return quote?.launchFeeSol ?? SPEC_LAUNCH_FEE_SOL;
}

/** Launch ids are UUIDs: anything else is not a launch, so it is not looked up. */
export function isLaunchId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** `solana:` transfer request for the wallet link and QR code, the same URI the API hands out at POST /launch. */
export function solanaPayUrl(address: string, lamports: string, ticker: string): string {
  const amount = lamportsToSolExact(BigInt(lamports));
  const params = new URLSearchParams({ amount, label: "Moatpad", message: `Launch $${ticker}` });
  return `solana:${address}?${params.toString().replace(/\+/g, "%20")}`;
}

/** The name's size as pump.fun counts it (UTF-8 bytes). */
export function nameBytes(name: string): number {
  return new TextEncoder().encode(name.trim()).length;
}

export function validateLaunch(form: LaunchForm): LaunchErrors {
  const errors: LaunchErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = "Give your coin a name";
  else if (nameBytes(name) > NAME_MAX) errors.name = name.length > NAME_MAX ? `Max ${NAME_MAX} characters` : `Too long for pump.fun: accented letters and emoji take 2 to 4 of the ${NAME_MAX} allowed`;
  if (!form.ticker) errors.ticker = "Pick a ticker";
  else if (form.ticker.length > TICKER_MAX) errors.ticker = `Max ${TICKER_MAX} characters`;
  if (form.description.length > DESCRIPTION_MAX) errors.description = `Max ${DESCRIPTION_MAX} characters`;
  for (const kind of ["x", "telegram", "website"] as const) {
    if (form[kind].trim() && !normalizeSocial(kind, form[kind]))
      errors[kind] = kind === "website" ? "Enter a valid URL" : `Enter a ${kind === "x" ? "X" : "Telegram"} handle or link`;
  }
  if (!(TRIGGER_OPTIONS_BPS as readonly number[]).includes(form.triggerBps)) errors.triggerBps = "Choose a floor";
  const creator = form.creatorWallet.trim();
  if (creator && !BASE58_ADDRESS.test(creator)) errors.creatorWallet = "Enter a Solana wallet address";
  const dev = parseDevBuy(form.devBuy);
  if (dev === null) errors.devBuy = "Enter an amount in SOL";
  else if (dev > DEV_BUY_MAX_SOL) errors.devBuy = `Max ${DEV_BUY_MAX_SOL} SOL`;
  return errors;
}

export function toLaunchRequest(form: LaunchForm): LaunchRequest {
  const socials: Socials = {};
  for (const kind of ["x", "telegram", "website"] as const) {
    const url = normalizeSocial(kind, form[kind]);
    if (url) socials[kind] = url;
  }
  const devBuySol = parseDevBuy(form.devBuy) ?? 0;
  return {
    name: form.name.trim(),
    ticker: form.ticker,
    description: form.description.trim() || undefined,
    imageUrl: form.imageUrl ?? undefined,
    socials: Object.keys(socials).length ? socials : undefined,
    triggerBps: form.triggerBps,
    devBuySol: devBuySol > 0 ? devBuySol : undefined,
    creatorWallet: form.creatorWallet.trim() || undefined,
  };
}

/** Who claims the creator fees, as the payment screen says it: the wallet the form named, or the one that pays. */
export function creatorFeesRecipient(creatorWallet: string | null): string {
  return creatorWallet ?? "The wallet you pay from";
}

/**
 * What happens while the coin is created. pump.fun's "creator" is the coin's vault (its creator fees fund the vault),
 * not the Moatpad creator who claims 15% of them, so the copy says fees, not creator.
 */
export function creatingStepsText(devBuySol: number): string {
  return `pump.fun creator fees routed to the coin's vault, floor locked${devBuySol > 0 ? ", dev buy" : ""}.`;
}

/** The launcher's reason for a failed launch, when it is one the user can act on (their form was refused). */
const INVALID_LAUNCH = "invalid launch: ";

/** What went wrong, for the user: the launcher's own error text can carry transaction logs and signatures. */
export function launchFailureText(error: string | null): string | null {
  if (!error) return null;
  if (error.startsWith(INVALID_LAUNCH)) return error.slice(INVALID_LAUNCH.length);
  return "Something went wrong on our side while creating the coin.";
}

/** The launcher's notes on a live launch: the dev buy was given up, or the leftover refund is still being retried. */
export function liveLaunchNotes(error: string | null): string[] {
  const notes: string[] = [];
  if (error?.includes("dev buy skipped")) notes.push("Your dev buy could not be made: its SOL goes back to the wallet that paid, and you hold no tokens from it.");
  if (error?.includes("refund pending")) notes.push("Your leftover SOL is still being refunded to the wallet that paid.");
  return notes;
}

/** Part of the deposit arrived (still waiting): how much, and how much is missing. Null when nothing (or everything) arrived. */
export function partialDeposit(status: Pick<LaunchStatus, "receivedLamports" | "requiredLamports"> | null): { receivedLamports: bigint; missingLamports: bigint } | null {
  if (!status) return null;
  const received = BigInt(status.receivedLamports);
  const required = BigInt(status.requiredLamports);
  if (received <= 0n || received >= required) return null;
  return { receivedLamports: received, missingLamports: required - received };
}

/**
 * What the payment screen asks for, in lamports: the required amount as the launch status last gave it (the launcher
 * raises a launch quoted below its real cost), or only the missing part once some of it arrived.
 */
export function amountDue(requiredLamports: string, status: Pick<LaunchStatus, "receivedLamports" | "requiredLamports"> | null): bigint {
  return partialDeposit(status)?.missingLamports ?? BigInt(status?.requiredLamports ?? requiredLamports);
}

/** Lamports as an exact SOL amount (all nine decimals that matter): 6_789n → "0.000006789". */
export function lamportsToSolExact(lamports: bigint): string {
  const whole = (lamports / 1_000_000_000n).toString();
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
