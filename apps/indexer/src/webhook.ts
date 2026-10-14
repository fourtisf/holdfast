import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { fromHeliusPayloadItem } from "./adapters/helius.js";
import type { ProcessResult } from "./process.js";
import type { ParsedTx } from "./tx.js";

export interface WebhookServerOptions {
  /** Expected `Authorization` header (Helius "authHeader"). Without it every delivery is rejected. */
  secret: string | null;
  process: (tx: ParsedTx) => Promise<ProcessResult>;
  logger?: FastifyBaseLogger | boolean;
  bodyLimit?: number;
  /** Prometheus text for GET /metrics. */
  metrics?: () => string;
  /** GET /healthz (503 when not ok). */
  health?: () => Promise<{ ok: boolean; [k: string]: unknown }>;
}

function sameSecret(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given.replace(/^Bearer\s+/i, ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `POST /webhooks/helius`: Helius raw (preferred) or enhanced transaction webhooks. Items are
 * processed in order; any failure answers 500 so Helius redelivers (processing is idempotent).
 */
export function buildWebhookServer(opts: WebhookServerOptions): FastifyInstance {
  const app = Fastify({
    ...(typeof opts.logger === "object" ? { loggerInstance: opts.logger } : { logger: opts.logger ?? false }),
    bodyLimit: opts.bodyLimit ?? 20 * 1024 * 1024,
  });

  app.get("/healthz", async (_req, reply) => {
    const h = opts.health ? await opts.health().catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) })) : { ok: true };
    return reply.code(h.ok ? 200 : 503).send(h);
  });
  if (opts.metrics) {
    const render = opts.metrics;
    app.get("/metrics", async (_req, reply) => reply.type("text/plain; version=0.0.4; charset=utf-8").send(render()));
  }

  app.post("/webhooks/helius", async (req, reply) => {
    if (!opts.secret || !sameSecret(req.headers.authorization, opts.secret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const items = Array.isArray(req.body) ? (req.body as unknown[]) : [req.body];
    const counts = { received: items.length, processed: 0, duplicate: 0, irrelevant: 0, failedTx: 0 };
    for (const item of items) {
      let tx: ParsedTx;
      try {
        tx = fromHeliusPayloadItem(item);
      } catch (err) {
        req.log.warn({ err }, "skipping unrecognized webhook item");
        continue;
      }
      try {
        const r = await opts.process(tx);
        if (r.status === "processed") counts.processed++;
        else if (r.status === "duplicate") counts.duplicate++;
        else if (r.status === "irrelevant") counts.irrelevant++;
        else counts.failedTx++;
      } catch (err) {
        req.log.error({ err, sig: tx.signature }, "webhook transaction failed");
        return reply.code(500).send({ error: "processing failed", ...counts });
      }
    }
    return counts;
  });

  return app;
}
