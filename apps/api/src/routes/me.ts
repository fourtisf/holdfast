import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiContext } from "../context.js";
import { position, profile } from "../services/holders.js";
import { base58Address } from "../validation.js";

export function meRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get("/me", async (req) => {
    const { wallet } = z.object({ wallet: base58Address }).parse(req.query);
    return profile(ctx.db, wallet, ctx.now());
  });

  app.get("/me/position", async (req) => {
    const { wallet, mint } = z.object({ wallet: base58Address, mint: base58Address }).parse(req.query);
    return position(ctx.db, wallet, mint, ctx.now());
  });
}
