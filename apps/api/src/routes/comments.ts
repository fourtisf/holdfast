import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  COMMENT_MAX_LENGTH,
  COMMENT_SIGNATURE_TTL_MS,
  commentMessage,
  containsBlockedTerm,
  normalizeCommentBody,
  REPORT_REASONS,
  weightedAmount,
  type Comment,
  type Page,
  type ReportResponse,
} from "@holdfast/core";
import {
  countOpenReports,
  countRecentComments,
  getCoin,
  getComment,
  insertComment,
  insertReport,
  listComments,
  logModeration,
  openLotsForWallets,
  setCommentHidden,
  type CoinRow,
  type CommentRow,
  type Queryable,
} from "@holdfast/db";
import type { ApiContext } from "../context.js";
import { verifyWalletSignature } from "../comments.js";
import { HttpError, notFound } from "../errors.js";
import { reporterHash } from "../moderation.js";
import { base58Address, intParam } from "../validation.js";

/** Per wallet, on top of the per-IP route limit. */
const WALLET_COMMENTS_PER_MINUTE = 3;
/** A signature may be up to this far in the future (client clock ahead). */
const MAX_CLOCK_SKEW_MS = 60_000;

const PostBody = z.object({
  wallet: base58Address,
  body: z.string().max(COMMENT_MAX_LENGTH * 2),
  replyTo: z.number().int().positive().nullable().optional(),
  signedAt: z.number().int().positive(),
  signature: z.string().min(64).max(100),
});

/** Rows → API comments with holder / creator badges at `now`; hidden bodies are withheld. */
async function present(q: Queryable, coin: CoinRow, rows: CommentRow[], now: number): Promise<Comment[]> {
  const lots = await openLotsForWallets(q, coin.mint, rows.map((r) => r.wallet));
  return rows.map((r) => {
    const own = lots.get(r.wallet) ?? [];
    const eligible = own.reduce((s, l) => s + l.amount, 0n);
    const w = weightedAmount(own, now);
    return {
      id: r.id,
      mint: r.mint,
      wallet: r.wallet,
      body: r.hidden ? "" : r.body,
      replyTo: r.replyTo,
      createdAt: r.createdAt,
      holder: eligible > 0n,
      weightMultiplier: eligible > 0n ? Number(w) / 1_000_000 / Number(eligible) : null,
      isCreator: coin.creator === r.wallet,
      hidden: r.hidden,
    };
  });
}

/**
 * Wallet-signed comments. Posting needs no account: the wallet signs a human-readable message
 * (`commentMessage` in @holdfast/core) that binds the coin, the text and the time, so a comment
 * cannot be posted in someone else's name or replayed.
 */
export function commentRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, config, now } = ctx;

  app.get("/coins/:mint/comments", async (req): Promise<Page<Comment>> => {
    const { mint } = z.object({ mint: base58Address }).parse(req.params);
    const q = z.object({ limit: intParam(50, 1, 100), before: z.coerce.number().int().positive().optional() }).parse(req.query);
    const coin = await getCoin(db, mint);
    if (!coin) throw notFound("Coin not found");
    if (coin.hidden) return { items: [], nextCursor: null };
    const rows = await listComments(db, mint, { limit: q.limit + 1, beforeId: q.before ?? null });
    const page = rows.slice(0, q.limit);
    return { items: await present(db, coin, page, now()), nextCursor: rows.length > q.limit ? String(page[page.length - 1]!.id) : null };
  });

  app.post("/coins/:mint/comments", { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } }, async (req): Promise<Comment> => {
    const { mint } = z.object({ mint: base58Address }).parse(req.params);
    const b = PostBody.parse(req.body ?? {});
    const t = now();
    const body = normalizeCommentBody(b.body);
    if (body.length === 0 || body.length > COMMENT_MAX_LENGTH) throw new HttpError(400, `body: 1 to ${COMMENT_MAX_LENGTH} characters`);
    if (b.signedAt < t - COMMENT_SIGNATURE_TTL_MS || b.signedAt > t + MAX_CLOCK_SKEW_MS) throw new HttpError(400, "Signature expired, sign again");
    const replyTo = b.replyTo ?? null;
    if (!verifyWalletSignature(b.wallet, commentMessage({ mint, body, replyTo, signedAt: b.signedAt }), b.signature)) throw new HttpError(401, "Invalid signature");

    const coin = await getCoin(db, mint);
    if (!coin) throw notFound("Coin not found");
    if (coin.hidden) throw new HttpError(403, "Comments are closed on this coin");
    if (replyTo !== null) {
      const parent = await getComment(db, replyTo);
      if (!parent || parent.mint !== mint) throw new HttpError(400, "replyTo: no such comment on this coin");
    }
    if (containsBlockedTerm(body, config.moderation.lists)) throw new HttpError(422, "This comment contains a blocked term");
    if ((await countRecentComments(db, b.wallet, t - 60_000)) >= WALLET_COMMENTS_PER_MINUTE) throw new HttpError(429, "Slow down: too many comments from this wallet");

    const row = await insertComment(db, { mint, wallet: b.wallet, body, replyTo, signedAt: b.signedAt, signature: b.signature, createdAt: t });
    if (!row) throw new HttpError(409, "This signature was already used");
    return (await present(db, coin, [row], t))[0]!;
  });

  app.post("/comments/:id/report", { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (req): Promise<ReportResponse> => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ reason: z.enum(REPORT_REASONS), details: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    const comment = await getComment(db, id);
    if (!comment) throw notFound("Comment not found");
    const target = String(id);
    const recorded = await insertReport(db, { targetType: "comment", targetId: target, mint: comment.mint, reason: body.reason, details: body.details, reporterHash: reporterHash(config.moderation.reportSalt, req.ip) });
    const threshold = config.moderation.autoHideReports;
    if (recorded && threshold > 0 && !comment.hidden && (await countOpenReports(db, "comment", target)) >= threshold) {
      await setCommentHidden(db, id, true, `hidden automatically after ${threshold} reports, pending review`);
      await logModeration(db, { action: "auto_hide_comment", target, actor: "system", reason: `${threshold} open reports` });
    }
    return { recorded };
  });
}
