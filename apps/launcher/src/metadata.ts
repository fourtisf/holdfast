/**
 * Launch form validation and the pump.fun metadata JSON (`create_v2`'s `uri`). The JSON is
 * content-addressed (`<sha256>.json` in METADATA_STORE, served by the API at
 * PUBLIC_METADATA_BASE_URL/<file>), so writing it again on a retry is a no-op and the uri is stable.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { TRIGGER_OPTIONS_BPS, type LaunchRequest, type Socials, type TriggerBps } from "@holdfast/core";

import { PUMP_MAX_NAME_BYTES, PUMP_MAX_SYMBOL_BYTES, PUMP_MAX_URI_BYTES, utf8Len } from "@holdfast/chain";

export class ValidationError extends Error {
  override readonly name = "ValidationError";
}

export interface MetadataSettings {
  /** Local directory the API serves under PUBLIC_METADATA_BASE_URL. */
  storeDir: string;
  /** e.g. https://api.holdfast.fun/metadata (no trailing slash). */
  publicBaseUrl: string;
  /** `createdOn` value, e.g. https://holdfast.fun */
  siteUrl: string;
}

export interface LaunchForm {
  name: string;
  symbol: string;
  description: string;
  imageUrl: string | null;
  socials: Socials;
  triggerBps: TriggerBps;
  /** Claims the creator share; null = the deposit's sender. */
  creatorWallet: string | null;
}

export const MAX_DESCRIPTION_BYTES = 2_000;
export const MAX_SOCIAL_LENGTH = 200;

export function normalizeBaseUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`metadata base URL must be http(s): ${url}`);
  return url.replace(/\/+$/, "");
}

/** Image URLs must be files under our own metadata base (uploaded through POST /uploads/image), or absent. */
export function validateImageUrl(url: string | null | undefined, publicBaseUrl: string): string | null {
  if (url === undefined || url === null || url.trim() === "") return null;
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url.trim());
    base = new URL(`${normalizeBaseUrl(publicBaseUrl)}/`);
  } catch {
    throw new ValidationError("image URL is not a valid URL");
  }
  let segments: string[];
  try {
    segments = parsed.pathname.split("/").map((s) => decodeURIComponent(s));
  } catch {
    throw new ValidationError("image URL has a malformed path");
  }
  if (
    parsed.origin !== base.origin ||
    !parsed.pathname.startsWith(base.pathname) ||
    parsed.pathname.length <= base.pathname.length ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    segments.some((s) => s === ".." || s === "." || s.includes("/") || s.includes("\\"))
  ) {
    throw new ValidationError("image URL must point at an uploaded file under the metadata base URL");
  }
  return parsed.toString();
}

function cleanSocial(v: string | undefined, label: string): string | undefined {
  const s = v?.trim();
  if (!s) return undefined;
  if (s.length > MAX_SOCIAL_LENGTH) throw new ValidationError(`${label} is too long`);
  return s;
}

export function normalizeForm(form: LaunchRequest, publicBaseUrl: string): LaunchForm {
  const name = (form.name ?? "").trim();
  const symbol = (form.ticker ?? "").trim();
  const description = (form.description ?? "").trim();
  if (!name || utf8Len(name) > PUMP_MAX_NAME_BYTES) throw new ValidationError(`name must be 1-${PUMP_MAX_NAME_BYTES} bytes`);
  if (!symbol || utf8Len(symbol) > PUMP_MAX_SYMBOL_BYTES) throw new ValidationError(`ticker must be 1-${PUMP_MAX_SYMBOL_BYTES} bytes`);
  if (utf8Len(description) > MAX_DESCRIPTION_BYTES) throw new ValidationError(`description must be at most ${MAX_DESCRIPTION_BYTES} bytes`);
  if (!(TRIGGER_OPTIONS_BPS as readonly number[]).includes(form.triggerBps)) throw new ValidationError(`trigger must be one of ${TRIGGER_OPTIONS_BPS.join(", ")} bps`);
  const socials: Socials = {};
  const x = cleanSocial(form.socials?.x, "X link");
  const telegram = cleanSocial(form.socials?.telegram, "Telegram link");
  const website = cleanSocial(form.socials?.website, "website");
  if (x) socials.x = x;
  if (telegram) socials.telegram = telegram;
  if (website) socials.website = website;
  return {
    name,
    symbol,
    description,
    imageUrl: validateImageUrl(form.imageUrl, publicBaseUrl),
    socials,
    triggerBps: form.triggerBps,
    creatorWallet: parseCreatorWallet(form.creatorWallet),
  };
}

/** The creator signs its claims, so it must be a regular (on-curve) wallet, not a program address. */
export function parseCreatorWallet(value: string | undefined): string | null {
  const s = value?.trim();
  if (!s) return null;
  let key: PublicKey;
  try {
    key = new PublicKey(s);
  } catch {
    throw new ValidationError("creator wallet is not a valid Solana address");
  }
  if (!PublicKey.isOnCurve(key.toBytes())) throw new ValidationError("creator wallet must be a regular wallet: it signs the fee claims");
  return key.toBase58();
}

/** The JSON pump.fun's frontend and wallets read from the token's `uri`. */
export interface PumpMetadataJson {
  name: string;
  symbol: string;
  description: string;
  image?: string;
  showName: true;
  createdOn: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export function buildMetadataJson(form: LaunchForm, siteUrl: string): PumpMetadataJson {
  const json: PumpMetadataJson = { name: form.name, symbol: form.symbol, description: form.description, showName: true, createdOn: siteUrl };
  if (form.imageUrl) json.image = form.imageUrl;
  if (form.socials.x) json.twitter = form.socials.x;
  if (form.socials.telegram) json.telegram = form.socials.telegram;
  if (form.socials.website) json.website = form.socials.website;
  // Fixed key order, so the same form always hashes to the same file.
  const ordered: Record<string, unknown> = {};
  for (const k of ["name", "symbol", "description", "image", "showName", "createdOn", "twitter", "telegram", "website"] as const) {
    if (json[k] !== undefined) ordered[k] = json[k];
  }
  return ordered as unknown as PumpMetadataJson;
}

/** Length of every uri we generate: `<base>/<64 hex>.json`. */
export function metadataUriLength(publicBaseUrl: string): number {
  return utf8Len(normalizeBaseUrl(publicBaseUrl)) + 1 + 64 + ".json".length;
}

export function assertUriFits(publicBaseUrl: string): void {
  const len = metadataUriLength(publicBaseUrl);
  if (len > PUMP_MAX_URI_BYTES) throw new Error(`PUBLIC_METADATA_BASE_URL is too long: metadata URIs would be ${len} bytes (pump.fun max ${PUMP_MAX_URI_BYTES})`);
}

export interface StoredMetadata {
  sha256: string;
  file: string;
  path: string;
  uri: string;
  body: string;
}

export function metadataDocument(json: PumpMetadataJson, settings: MetadataSettings): StoredMetadata {
  const body = JSON.stringify(json);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const file = `${sha256}.json`;
  return { sha256, file, path: join(settings.storeDir, file), uri: `${normalizeBaseUrl(settings.publicBaseUrl)}/${file}`, body };
}

/** Write the metadata JSON (atomically, idempotently) and return its public uri. */
export async function writeMetadata(json: PumpMetadataJson, settings: MetadataSettings): Promise<StoredMetadata> {
  const doc = metadataDocument(json, settings);
  try {
    if ((await readFile(doc.path, "utf8")) === doc.body) return doc;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await mkdir(settings.storeDir, { recursive: true });
  const tmp = `${doc.path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, doc.body, { encoding: "utf8", mode: 0o644 });
  await rename(tmp, doc.path);
  return doc;
}
