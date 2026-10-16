import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { normalizeIP } from "@fastify/rate-limit";
import { INTERNAL_TOKEN_HEADER, TELEGRAM_USER_HEADER } from "@holdfast/core";

/** Telegram user ids are positive integers of at most 52 bits. */
const TELEGRAM_USER_ID = /^[1-9][0-9]{0,15}$/;

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time check of a presented secret (both sides hashed, so neither the content nor the length leaks). */
export function secretMatches(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

/**
 * Rate-limit bucket of a request: its IP (normalized the way @fastify/rate-limit's default key is), or
 * `tg:<user id>` for a request of the Telegram bot that carries INTERNAL_API_TOKEN and the Telegram user
 * it is made for. Every bot user reaches the API from the notifier's address, so per IP they would all
 * share one bucket. The user header counts for nothing without the token (or when the API has none).
 */
export function rateLimitKey(req: Pick<FastifyRequest, "ip" | "headers">, internalToken: string | null): string {
  const ip = normalizeIP(req.ip);
  if (!internalToken) return ip;
  const user = req.headers[TELEGRAM_USER_HEADER];
  const token = req.headers[INTERNAL_TOKEN_HEADER];
  if (typeof user !== "string" || typeof token !== "string" || !TELEGRAM_USER_ID.test(user)) return ip;
  return secretMatches(token, internalToken) ? `tg:${user}` : ip;
}
