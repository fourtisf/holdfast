import type { FastifyInstance } from "fastify";
import type { BurnStats } from "@holdfast/core";
import { burnTotals, getCoins, recentBurns } from "@holdfast/db";
import type { ApiContext } from "../context.js";
import { lamportsToSol } from "../format.js";

/** $MOATPAD uses pump.fun's 6 decimals. */
const HOLD_DECIMALS = 1e6;

export function burnRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get("/burns", async (): Promise<BurnStats> => {
    const [totals, recent] = await Promise.all([burnTotals(ctx.db), recentBurns(ctx.db, 20)]);
    const coins = await getCoins(ctx.db, [...new Set(recent.map((b) => b.mint))]);
    return {
      burns: totals.count,
      solSpent: lamportsToSol(totals.solSpent),
      tokensBurned: Number(totals.holdBurned) / HOLD_DECIMALS,
      lastAt: totals.lastAt,
      recent: recent.map((b) => ({
        sig: b.sig,
        mint: b.mint,
        ticker: coins.get(b.mint)?.ticker ?? null,
        solSpent: lamportsToSol(b.solSpent),
        tokensBurned: Number(b.holdBurned) / HOLD_DECIMALS,
        ts: b.ts,
      })),
    };
  });
}
