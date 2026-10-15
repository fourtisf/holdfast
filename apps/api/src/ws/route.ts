import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { WsServerMessage } from "@holdfast/core";
import type { ApiContext } from "../context.js";
import { base58Address } from "../validation.js";
import { subscriptionKey, type HubClient } from "./hub.js";

const channel = z.union([
  z.object({ channel: z.literal("trades"), mint: base58Address }),
  z.object({ channel: z.literal("deposit-status"), launchId: z.string().min(1).max(64) }),
  z.object({ channel: z.literal("stats") }),
]);
const ClientMessage = z.union([
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.enum(["subscribe", "unsubscribe"]) }).and(channel),
]);

const MAX_SUBSCRIPTIONS = 200;

export function wsRoutes(app: FastifyInstance, ctx: ApiContext): void {
  // One long-lived connection per tab: its own per-IP budget, so it does not spend the REST one (users behind one NAT).
  app.get("/ws", { websocket: true, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, (socket: WebSocket) => {
    const client: HubClient = {
      send(msg: WsServerMessage) {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      },
    };
    let subscriptions = 0;
    let alive = true;
    socket.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, ctx.config.wsHeartbeatMs);
    heartbeat.unref();

    socket.on("message", (raw) => {
      let parsed: z.infer<typeof ClientMessage>;
      try {
        parsed = ClientMessage.parse(JSON.parse(raw.toString()));
      } catch {
        client.send({ channel: "error", message: "Invalid message" });
        return;
      }
      if (parsed.type === "ping") {
        client.send({ channel: "pong", serverTime: ctx.now() });
        return;
      }
      const key = subscriptionKey(parsed);
      if (parsed.type === "unsubscribe") {
        if (ctx.hub.unsubscribe(client, key)) subscriptions--;
        return;
      }
      if (subscriptions >= MAX_SUBSCRIPTIONS) {
        client.send({ channel: "error", message: "Too many subscriptions" });
        return;
      }
      if (ctx.hub.subscribe(client, key)) {
        subscriptions++;
        ctx.feed.snapshotFor(client, parsed).catch(() => client.send({ channel: "error", message: "Snapshot unavailable" }));
      }
    });

    socket.on("close", () => {
      clearInterval(heartbeat);
      ctx.hub.removeClient(client);
    });
  });
}
