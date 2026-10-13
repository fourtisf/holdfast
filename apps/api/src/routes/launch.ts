import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiContext } from "../context.js";
import { notFound } from "../errors.js";
import { parseLaunchRequest } from "../launch/schema.js";

export function launchRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.post("/launch", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => ctx.launches.create(parseLaunchRequest(req.body)));

  app.get("/launch/:id", async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const status = await ctx.launches.get(id);
    if (!status) throw notFound("Launch not found");
    return status;
  });
}
