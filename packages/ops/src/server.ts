import { createServer, type Server } from "node:http";

import type { Metrics } from "./metrics.js";

export interface HealthReport {
  ok: boolean;
  /** Free-form details shown in the /healthz body (no secrets). */
  details?: Record<string, unknown>;
}

/** A JSON POST endpoint on the ops server (internal: the ops port is not published). */
export type OpsPostHandler = (body: unknown) => Promise<{ status: number; body: unknown }>;

/** Largest JSON body a POST handler accepts. */
const MAX_POST_BYTES = 64 * 1024;

export interface OpsServer {
  port: number;
  close(): Promise<void>;
}

/**
 * GET /healthz → 200 / 503 with `{ ok, ...details }`; GET /metrics → Prometheus text. For the
 * services that have no HTTP server of their own (keeper, payout worker, launcher). `post` adds
 * internal JSON endpoints (the launcher's wallet-launch builder, called by the API).
 */
export async function startOpsServer(opts: {
  port: number;
  host?: string;
  metrics: Metrics;
  health: () => HealthReport | Promise<HealthReport>;
  post?: Record<string, OpsPostHandler>;
}): Promise<OpsServer> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const handler = req.method === "POST" ? opts.post?.[path] : undefined;
    if (handler) {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_POST_BYTES) req.destroy();
        else chunks.push(c);
      });
      req.on("end", () => {
        const reply = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
        } catch {
          reply(400, { error: "body must be JSON" });
          return;
        }
        handler(body).then(
          (r) => reply(r.status, r.body),
          (err: unknown) => reply(500, { error: err instanceof Error ? err.message : String(err) }),
        );
      });
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (path === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" }).end(opts.metrics.render());
      return;
    }
    if (path === "/healthz") {
      Promise.resolve()
        .then(() => opts.health())
        .then(
          (h) => res.writeHead(h.ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ok: h.ok, ...(h.details ?? {}) })),
          (err: unknown) => res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })),
        );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "0.0.0.0", () => resolve());
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : opts.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Healthy while the last successful loop iteration is younger than `maxAgeMs`. */
export function freshness(lastSuccessMs: number | null, maxAgeMs: number, now = Date.now()): HealthReport {
  const age = lastSuccessMs === null ? null : now - lastSuccessMs;
  return { ok: age !== null && age <= maxAgeMs, details: { lastSuccessAgoMs: age } };
}
