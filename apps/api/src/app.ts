import { mkdirSync } from "node:fs";
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { Connection } from "@solana/web3.js";
import { ZodError } from "zod";
import { Metrics } from "@holdfast/ops";
import type { Db } from "@holdfast/db";
import type { ApiConfig } from "./config.js";
import type { ApiContext } from "./context.js";
import type { LaunchService } from "./launch/service.js";
import { HttpWalletLauncher, type WalletLauncher } from "./launch/wallet.js";
import { RpcTxRelay, type TxRelay } from "./relay.js";
import type { TradeChain } from "./trade/chain.js";
import { NO_PRICE, type SolPriceSource } from "./services/price.js";
import { commentRoutes } from "./routes/comments.js";
import { socialRoutes } from "./routes/social.js";
import { burnRoutes } from "./routes/burns.js";
import { adminRoutes } from "./routes/admin.js";
import { creatorRoutes } from "./routes/creator.js";
import { launchRoutes } from "./routes/launch.js";
import { moderationRoutes } from "./routes/moderation.js";
import { marketRoutes } from "./routes/market.js";
import { meRoutes } from "./routes/me.js";
import { tradeRoutes } from "./routes/trade.js";
import { txRoutes } from "./routes/tx.js";
import { uploadRoutes } from "./routes/uploads.js";
import type { EventSource } from "./ws/events.js";
import { LiveFeed } from "./ws/feed.js";
import { SubscriptionHub } from "./ws/hub.js";
import { wsRoutes } from "./ws/route.js";

export interface AppDeps {
  db: Db;
  config: ApiConfig;
  tradeChain: TradeChain;
  launches: LaunchService;
  /** Wallet-signed launches (default: the launcher's internal endpoint at config.launcherUrl). */
  walletLauncher?: WalletLauncher;
  /** Sends signed transactions for the browser (default: config.rpcUrl). */
  relay?: TxRelay;
  events: EventSource;
  /** SOL/USD for Stats.solUsd (default: none). Started and stopped with the app when it has start/stop. */
  prices?: SolPriceSource & { start?(): void; stop?(): void };
  now?: () => number;
  logger?: FastifyBaseLogger | boolean;
}

export interface HoldfastApi {
  app: FastifyInstance;
  ctx: ApiContext;
}

function corsOrigin(value: string): boolean | string[] {
  const list = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes("*") ? true : list;
}

function formatZodError(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "Invalid request";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

export async function buildApp(deps: AppDeps): Promise<HoldfastApi> {
  const now = deps.now ?? Date.now;
  const app = Fastify({
    ...(typeof deps.logger === "object" ? { loggerInstance: deps.logger } : { logger: deps.logger ?? false }),
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  const hub = new SubscriptionHub();
  const prices = deps.prices ?? NO_PRICE;
  const metrics = new Metrics();
  // Live path: notifications reaching the API, resyncs after the change feed reconnected, open sockets.
  const feedEvents = metrics.counter("api_feed_events_total", "Change notifications received, by kind");
  const feedResyncs = metrics.counter("api_feed_resyncs_total", "Change feed reconnects (clients told to resync)");
  const lastFeedEvent = metrics.gauge("api_feed_last_event_timestamp_seconds", "When the last change notification arrived");
  const wsClients = metrics.gauge("api_ws_clients", "Open WebSocket connections");
  const feed = new LiveFeed({
    db: deps.db,
    hub,
    launches: deps.launches,
    prices,
    now,
    log: app.log,
    statsIntervalMs: deps.config.statsIntervalMs,
    observe: {
      event: (kind) => {
        feedEvents.inc({ kind });
        lastFeedEvent.setToNow();
      },
      resync: () => feedResyncs.inc(),
    },
  });
  const walletLauncher = deps.walletLauncher ?? new HttpWalletLauncher(deps.config.launcherUrl);
  const relay = deps.relay ?? new RpcTxRelay(new Connection(deps.config.rpcUrl, "confirmed"));
  const ctx: ApiContext = { db: deps.db, config: deps.config, tradeChain: deps.tradeChain, launches: deps.launches, walletLauncher, relay, hub, feed, prices, now };

  app.setErrorHandler((err: FastifyError | ZodError | { statusCode?: number; error?: string; message?: string }, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: formatZodError(err) });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, "request failed");
      return reply.code(status).send({ error: status === 502 || status === 503 ? (err as Error).message : "Internal server error" });
    }
    const message = (err as { message?: string }).message || (err as { error?: string }).error || "Request failed";
    return reply.code(status).send({ error: message });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));

  await app.register(cors, { origin: corsOrigin(deps.config.corsOrigin), methods: ["GET", "POST", "OPTIONS"] });
  if (deps.config.rateLimitPerMinute > 0) {
    await app.register(rateLimit, {
      max: deps.config.rateLimitPerMinute,
      timeWindow: "1 minute",
      errorResponseBuilder: (_req, c) => ({ statusCode: c.statusCode, error: `Rate limit exceeded, retry in ${c.after}`, message: `Rate limit exceeded, retry in ${c.after}` }),
    });
  }
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 } });
  mkdirSync(deps.config.metadataDir, { recursive: true });
  await app.register(fastifyStatic, { root: deps.config.metadataDir, prefix: "/metadata/", decorateReply: false, maxAge: "365d", immutable: true });
  await app.register(websocket, { options: { maxPayload: 4096 } });

  // Prometheus: requests by route template and status class.
  const requests = metrics.counter("api_requests_total", "HTTP requests by route and status class");
  const latency = metrics.counter("api_request_seconds_total", "Summed request handling time by route");
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "unmatched";
    requests.inc({ route, status: `${Math.floor(reply.statusCode / 100)}xx` });
    latency.inc({ route }, reply.elapsedTime / 1000);
  });
  app.get("/metrics", async (_req, reply) => {
    wsClients.set(hub.size);
    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(metrics.render());
  });

  app.get("/healthz", async () => {
    await deps.db.query("SELECT 1");
    return { ok: true, time: now() };
  });
  marketRoutes(app, ctx);
  meRoutes(app, ctx);
  tradeRoutes(app, ctx);
  txRoutes(app, ctx);
  uploadRoutes(app, ctx);
  launchRoutes(app, ctx);
  creatorRoutes(app, ctx);
  moderationRoutes(app, ctx);
  socialRoutes(app, ctx);
  burnRoutes(app, ctx);
  commentRoutes(app, ctx);
  adminRoutes(app, ctx);
  await app.register(async (scope) => wsRoutes(scope, ctx));

  app.addHook("onReady", async () => {
    deps.prices?.start?.();
    await feed.start(deps.events);
  });
  app.addHook("onClose", async () => {
    deps.prices?.stop?.();
    await feed.stop();
  });

  return { app, ctx };
}
