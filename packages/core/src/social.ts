/**
 * Launchpad helpers shared by the API and the web app: bonding-curve progress, PnL, and the exact
 * message a wallet signs to post a comment (so the server can verify who wrote it).
 */
import { base58 } from "@scure/base";
import { PUMP_INITIAL_REAL_TOKEN_RESERVES } from "./constants.js";

/** Share of the bonding curve sold (0 → just launched, 1 → completed / graduated). */
export function bondingCurveProgress(realTokenReserves: bigint | null, graduated: boolean, initial = PUMP_INITIAL_REAL_TOKEN_RESERVES): number {
  if (graduated) return 1;
  if (realTokenReserves === null) return 0;
  if (realTokenReserves <= 0n) return 1;
  if (realTokenReserves >= initial) return 0;
  return Number(((initial - realTokenReserves) * 1_000_000n) / initial) / 1_000_000;
}

/**
 * Position PnL in SOL, payouts included: what the wallet holds now plus everything it got out
 * (sells, payout SOL, payout tokens at today's value), minus what it paid in.
 */
export function positionPnl(p: { boughtSol: number; soldSol: number; valueSol: number; earnedSol: number; earnedTokensValueSol: number }): { pnlSol: number; pnlPct: number | null } {
  const pnlSol = p.valueSol + p.soldSol + p.earnedSol + p.earnedTokensValueSol - p.boughtSol;
  return { pnlSol, pnlPct: p.boughtSol > 0 ? (pnlSol / p.boughtSol) * 100 : null };
}

export const COMMENT_MAX_LENGTH = 500;
/** A signed comment is accepted this long after signing (clock skew + slow wallets). */
export const COMMENT_SIGNATURE_TTL_MS = 10 * 60_000;

export interface CommentPayload {
  mint: string;
  body: string;
  /** Comment id this one answers, or null. */
  replyTo: number | null;
  /** Unix ms when the user signed. */
  signedAt: number;
}

/** Normalized comment text: trimmed, CRLF → LF, at most 3 consecutive blank lines. */
export function normalizeCommentBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

/** The text a wallet signs (`signMessage`) to post a comment. Human readable on purpose. */
export function commentMessage(p: CommentPayload): string {
  return [
    "Moatpad comment",
    `coin: ${p.mint}`,
    `reply to: ${p.replyTo === null ? "-" : String(p.replyTo)}`,
    `signed at: ${new Date(p.signedAt).toISOString()}`,
    "",
    normalizeCommentBody(p.body),
  ].join("\n");
}

/** Base58 of a wallet signature (what `PostCommentRequest.signature` carries). */
export const encodeSignature = (sig: Uint8Array): string => base58.encode(sig);
export const decodeSignature = (sig: string): Uint8Array => base58.decode(sig);
