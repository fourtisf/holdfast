import { LAUNCH_FEE_LAMPORTS, TRIGGER_OPTIONS_BPS, type LaunchQuote, type LaunchRequest, type Socials, type TriggerBps } from "@holdfast/core";

/** SPEC §2 target. The real cost comes from GET /launch/quote; this is only the fallback while it loads. */
export const SPEC_LAUNCH_FEE_SOL = Number(LAUNCH_FEE_LAMPORTS) / 1e9;
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

export function validateLaunch(form: LaunchForm): LaunchErrors {
  const errors: LaunchErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = "Give your coin a name";
  else if (name.length > NAME_MAX) errors.name = `Max ${NAME_MAX} characters`;
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
