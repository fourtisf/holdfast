import type { FastifyInstance } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import type { ApiContext } from "../context.js";
import { checkRelayable } from "../relay.js";
import { base58Address } from "../validation.js";

const Signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);

/** Signed transactions from the browser go out through our RPC; the browser polls their status here. */
export function txRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.post("/tx/send", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { transaction } = z.object({ transaction: z.string().min(100).max(4_000) }).parse(req.body);
    return { signature: await ctx.relay.send(checkRelayable(transaction)) };
  });

  app.get("/tx/:signature", { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } }, async (req) => {
    const { signature } = z.object({ signature: Signature }).parse(req.params);
    return ctx.relay.status(signature);
  });

  app.get("/balance", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
    const { wallet } = z.object({ wallet: base58Address }).parse(req.query);
    const lamports = await ctx.relay.balance(new PublicKey(wallet));
    return { lamports: lamports.toString(), sol: Number(lamports) / 1e9 };
  });
}
