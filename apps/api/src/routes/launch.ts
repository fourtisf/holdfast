import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiContext } from "../context.js";
import { notFound } from "../errors.js";
import { launchCost, toLaunchQuote } from "../launch/cost.js";
import { parseLaunchRequest } from "../launch/schema.js";
import { launchCostSettings } from "../launch/settings.js";

export function launchRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.post("/launch", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => ctx.launches.create(parseLaunchRequest(req.body)));

  /** Deposit needed for a launch (optionally for a given name/ticker/dev buy), from the launcher's cost model. */
  app.get("/launch/quote", async (req) => {
    const q = z
      .object({
        devBuySol: z.coerce.number().min(0).max(10).default(0),
        name: z.string().max(64).optional(),
        ticker: z.string().max(16).optional(),
      })
      .parse(req.query);
    return toLaunchQuote(launchCost(launchCostSettings(ctx.config), q));
  });

  app.get("/launch/:id", async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const status = await ctx.launches.get(id);
    if (!status) throw notFound("Launch not found");
    return status;
  });
}
