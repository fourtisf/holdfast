import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AdminCoin, AdminLaunch, AdminLogEntry, AdminOverview, AdminReport, LaunchStatusKind } from "@holdfast/core";
import {
  blockImage,
  countLaunchesByStatus,
  getCoin,
  listLaunches,
  listModeratedCoins,
  listModerationLog,
  listReports,
  logModeration,
  resetLaunchAttempts,
  resolveReports,
  setCoinHidden,
  setCoinNeedsReview,
  type LaunchRow,
} from "@holdfast/db";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ApiContext } from "../context.js";
import { HttpError, notFound } from "../errors.js";
import { requireAdmin, sha256Hex } from "../moderation.js";
import { toLaunchStatus } from "../present.js";
import { base58Address, intParam } from "../validation.js";

const LAUNCH_STATUSES = ["awaiting_deposit", "deposit_received", "creating", "live", "refunding", "refunded", "expired", "failed"] as const;

function toAdminLaunch(l: LaunchRow): AdminLaunch {
  return {
    ...toLaunchStatus(l),
    name: l.form.name,
    ticker: l.form.ticker,
    attempts: l.attempts,
    createdAt: l.createdAt,
    devBuyLamports: l.devBuyLamports.toString(),
  };
}

/** The admin is identified by a short fingerprint of the token (several operators can share one). */
const actorOf = (req: FastifyRequest) => `admin:${sha256Hex(req.headers.authorization ?? "").slice(0, 8)}`;

/**
 * Operator endpoints behind ADMIN_TOKEN (`Authorization: Bearer <token>`); 404 when unset. Nothing
 * here can touch funds: moderation only changes what Holdfast lists and shows.
 */
export function adminRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, config } = ctx;

  app.register(async (scope) => {
    scope.addHook("onRequest", async (req) => requireAdmin(config.adminToken, req));

    scope.get("/admin/overview", async (): Promise<AdminOverview> => {
      const [launches, coins, reports] = await Promise.all([countLaunchesByStatus(db), listModeratedCoins(db, 1_000), listReports(db, { limit: 1_000 })]);
      return {
        launches,
        openReports: reports.length,
        coinsNeedingReview: coins.filter((c) => c.needsReview && !c.hidden).length,
        hiddenCoins: coins.filter((c) => c.hidden).length,
      };
    });

    scope.get("/admin/reports", async (req): Promise<AdminReport[]> => {
      const q = z.object({ all: z.enum(["0", "1"]).default("0"), limit: intParam(100, 1, 500) }).parse(req.query);
      return listReports(db, { open: q.all === "0", limit: q.limit });
    });

    scope.post("/admin/reports/:id/resolve", async (req) => {
      const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
      const { resolution } = z.object({ resolution: z.string().trim().min(1).max(200) }).parse(req.body ?? {});
      const n = await resolveReports(db, { id }, resolution);
      if (n === 0) throw notFound("Open report not found");
      await logModeration(db, { action: "resolve_report", target: String(id), actor: actorOf(req), reason: resolution });
      return { ok: true };
    });

    scope.get("/admin/coins", async (req): Promise<AdminCoin[]> => listModeratedCoins(db, z.object({ limit: intParam(100, 1, 500) }).parse(req.query).limit));

    scope.post("/admin/coins/:mint/hide", async (req) => {
      const { mint } = z.object({ mint: base58Address }).parse(req.params);
      const body = z.object({ reason: z.string().trim().min(1).max(200), blockImage: z.boolean().default(false) }).parse(req.body ?? {});
      const coin = await getCoin(db, mint);
      if (!coin) throw notFound("Coin not found");
      await db.tx(async (q) => {
        await setCoinHidden(q, mint, true, body.reason);
        await resolveReports(q, { targetType: "coin", targetId: mint }, `hidden: ${body.reason}`);
        await logModeration(q, { action: "hide", target: mint, actor: actorOf(req), reason: body.reason });
      });
      if (body.blockImage && coin.imageUrl?.startsWith(`${config.publicMetadataBaseUrl}/`)) {
        const file = coin.imageUrl.slice(config.publicMetadataBaseUrl.length + 1);
        if (/^[0-9a-f]{64}\.[a-z]+$/.test(file)) {
          const bytes = await readFile(join(config.metadataDir, file)).catch(() => null);
          // uploads are content-addressed: the file name is the hash
          await blockImage(db, bytes ? sha256Hex(bytes) : file.split(".")[0]!, body.reason);
        }
      }
      return { ok: true };
    });

    scope.post("/admin/coins/:mint/unhide", async (req) => {
      const { mint } = z.object({ mint: base58Address }).parse(req.params);
      if (!(await setCoinHidden(db, mint, false, null))) throw notFound("Coin not found");
      await logModeration(db, { action: "unhide", target: mint, actor: actorOf(req) });
      return { ok: true };
    });

    scope.post("/admin/coins/:mint/reviewed", async (req) => {
      const { mint } = z.object({ mint: base58Address }).parse(req.params);
      if (!(await getCoin(db, mint))) throw notFound("Coin not found");
      await db.tx(async (q) => {
        await setCoinNeedsReview(q, mint, false);
        await resolveReports(q, { targetType: "coin", targetId: mint }, "reviewed: no action");
        await logModeration(q, { action: "reviewed", target: mint, actor: actorOf(req) });
      });
      return { ok: true };
    });

    scope.get("/admin/launches", async (req): Promise<AdminLaunch[]> => {
      const q = z.object({ status: z.string().max(200).optional(), limit: intParam(100, 1, 500) }).parse(req.query);
      const statuses = (q.status ?? "").split(",").filter(Boolean);
      for (const s of statuses) if (!(LAUNCH_STATUSES as readonly string[]).includes(s)) throw new HttpError(400, `unknown status ${s}`);
      return (await listLaunches(db, { statuses: statuses as LaunchStatusKind[], limit: q.limit })).map(toAdminLaunch);
    });

    scope.post("/admin/launches/:id/retry", async (req) => {
      const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
      const row = await resetLaunchAttempts(db, id);
      if (!row) throw new HttpError(409, "Only launches that are creating or refunding can be retried");
      await logModeration(db, { action: "retry_launch", target: id, actor: actorOf(req) });
      return toAdminLaunch(row);
    });

    scope.get("/admin/log", async (req): Promise<AdminLogEntry[]> => listModerationLog(db, z.object({ limit: intParam(100, 1, 500) }).parse(req.query).limit));
  });
}
