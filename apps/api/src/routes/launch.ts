import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { moderateLaunchText, type WalletLaunchStatus } from "@holdfast/core";
import { getWalletLaunch } from "@holdfast/db";
import { PublicKey } from "@solana/web3.js";
import type { ApiContext } from "../context.js";
import { HttpError, notFound } from "../errors.js";
import { launchCost, toLaunchQuote } from "../launch/cost.js";
import { parseLaunchRequest } from "../launch/schema.js";
import { launchCostSettings } from "../launch/settings.js";

export function launchRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.post("/launch", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    // No deposit address while launches are closed: nothing would process the deposit.
    if (ctx.config.launchesPaused) throw new HttpError(503, "Launches are not open yet");
    const launch = parseLaunchRequest(req.body);
    // Blocked terms never reach the chain; reserved names are accepted and flagged by the launcher.
    const verdict = moderateLaunchText(launch, ctx.config.moderation.lists);
    if (verdict.action === "block") throw new HttpError(422, `This launch is not allowed: ${verdict.reasons.join("; ")}`);
    return ctx.launches.create(launch);
  });

  /**
   * Launch signed by the creator's wallet: the whole launch as one transaction, co-signed by the
   * launcher, for the wallet to sign and send (like a pump.fun create). No deposit address.
   */
  app.post("/launch/wallet", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    if (ctx.config.launchesPaused) throw new HttpError(503, "Launches are not open yet");
    const { wallet, ...rest } = z.object({ wallet: z.string().min(32).max(44) }).passthrough().parse(req.body);
    try {
      new PublicKey(wallet);
    } catch {
      throw new HttpError(400, "wallet must be a Solana address");
    }
    const launch = parseLaunchRequest(rest);
    const verdict = moderateLaunchText(launch, ctx.config.moderation.lists);
    if (verdict.action === "block") throw new HttpError(422, `This launch is not allowed: ${verdict.reasons.join("; ")}`);
    return ctx.walletLauncher.prepare(launch, wallet);
  });

  app.get("/launch/wallet/:mint", async (req): Promise<WalletLaunchStatus> => {
    const { mint } = z.object({ mint: z.string().min(32).max(44) }).parse(req.params);
    const row = await getWalletLaunch(ctx.db, mint);
    if (!row) throw notFound("Launch not found");
    return { mint: row.mint, status: row.status };
  });

  /** Deposit needed for a launch (optionally for a given name/ticker/dev buy), from the launcher's cost model. */
  app.get("/launch/quote", async (req) => {
    const q = z
      .object({
        devBuySol: z.coerce.number().min(0).max(10).default(0),
        name: z.string().max(64).optional(),
        ticker: z.string().max(16).optional(),
      })
      .parse(req.query);
    return { ...toLaunchQuote(launchCost(launchCostSettings(ctx.config), q)), launchesPaused: ctx.config.launchesPaused };
  });

  app.get("/launch/:id", async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const status = await ctx.launches.get(id);
    if (!status) throw notFound("Launch not found");
    return status;
  });
}
