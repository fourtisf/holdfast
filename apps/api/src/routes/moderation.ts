import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { REPORT_REASONS, type ReportResponse } from "@holdfast/core";
import { countOpenReports, getCoin, insertReport, logModeration, setCoinHidden } from "@holdfast/db";

import type { ApiContext } from "../context.js";
import { notFound } from "../errors.js";
import { reporterHash } from "../moderation.js";
import { base58Address } from "../validation.js";

const ReportBody = z.object({
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(500).optional(),
});

export function moderationRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, config } = ctx;

  app.post("/coins/:mint/report", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (req): Promise<ReportResponse> => {
    const { mint } = z.object({ mint: base58Address }).parse(req.params);
    const body = ReportBody.parse(req.body ?? {});
    const coin = await getCoin(db, mint);
    if (!coin) throw notFound("Coin not found");
    const recorded = await insertReport(db, { targetType: "coin", targetId: mint, mint, reason: body.reason, details: body.details, reporterHash: reporterHash(config.moderation.reportSalt, req.ip) });
    const threshold = config.moderation.autoHideReports;
    if (recorded && threshold > 0 && !coin.hidden && (await countOpenReports(db, "coin", mint)) >= threshold) {
      await setCoinHidden(db, mint, true, `hidden automatically after ${threshold} reports, pending review`);
      await logModeration(db, { action: "auto_hide", target: mint, actor: "system", reason: `${threshold} open reports` });
      req.log.warn({ mint }, "coin hidden automatically by reports");
    }
    return { recorded };
  });
}
