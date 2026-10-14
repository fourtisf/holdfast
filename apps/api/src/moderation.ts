import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import { isImageBlocked, type Queryable } from "@holdfast/db";

import type { ModerationConfig } from "./config.js";
import { HttpError } from "./errors.js";

export const sha256Hex = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

/** Hash of the reporter's IP: counts distinct reporters without storing who they are. */
export function reporterHash(salt: string, ip: string): string {
  return sha256Hex(`${salt}\u0000${ip}`);
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Upload gate: images an admin blocked are refused by hash, and, if configured, every image goes
 * through the operator's classifier (e.g. a CSAM / NSFW detection service) before it is stored.
 */
export async function checkImage(db: Queryable, cfg: ModerationConfig, buf: Buffer, mime: string, log: FastifyBaseLogger, fetchFn: FetchLike = globalThis.fetch as unknown as FetchLike): Promise<void> {
  if (await isImageBlocked(db, sha256Hex(buf))) throw new HttpError(422, "This image is not allowed");
  if (!cfg.imageWebhookUrl) return;
  try {
    const res = await fetchFn(cfg.imageWebhookUrl, { method: "POST", headers: { "content-type": mime }, body: new Uint8Array(buf), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`classifier answered HTTP ${res.status}`);
    const verdict = (await res.json()) as { flagged?: unknown };
    if (verdict.flagged === true) throw new HttpError(422, "This image is not allowed");
  } catch (err) {
    if (err instanceof HttpError) throw err;
    log.warn({ err: (err as Error).message }, "image classifier unavailable");
    if (cfg.imageFailClosed) throw new HttpError(503, "Image check unavailable, try again later");
  }
}

/** Constant-time bearer token check for /admin/*. */
export function requireAdmin(token: string | null, req: FastifyRequest): void {
  if (!token) throw new HttpError(404, "Not found");
  const header = req.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(sha256Hex(given));
  const b = Buffer.from(sha256Hex(token));
  if (!given || !timingSafeEqual(a, b)) throw new HttpError(401, "Unauthorized");
}
