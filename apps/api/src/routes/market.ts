import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiContext } from "../context.js";
import { candles, coinDetail, defends, listCoins, roundSnapshot, rounds, schedule, stats, trades } from "../services/market.js";
import { holders } from "../services/holders.js";
import { base58Address, intParam, optionalMs } from "../validation.js";

const CoinsQuery = z.object({
  sort: z.enum(["newest", "trending", "vault_buying", "top_payouts", "biggest_vault"]).default("newest"),
  q: z.string().trim().max(64).optional(),
  limit: intParam(24, 1, 100),
  cursor: z.string().max(512).optional(),
});
const MintParams = z.object({ mint: base58Address });
const CandlesQuery = z.object({ tf: z.enum(["1m", "5m", "15m", "1h"]).default("1m"), from: optionalMs, to: optionalMs, limit: intParam(500, 1, 1500) });
const TradesQuery = z.object({ limit: intParam(50, 1, 200), before: z.string().max(512).optional() });
const LimitQuery = (def: number, max: number) => z.object({ limit: intParam(def, 1, max) });
const RoundParams = z.object({ mint: base58Address, roundId: z.coerce.number().int().min(0) });

export function marketRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, now } = ctx;

  app.get("/stats", async () => stats(db, now()));
  app.get("/schedule", async () => schedule(now()));

  app.get("/coins", async (req) => {
    const q = CoinsQuery.parse(req.query);
    return listCoins(db, { sort: q.sort, search: q.q, limit: q.limit, cursor: q.cursor, now: now() });
  });

  app.get("/coins/:mint", async (req) => coinDetail(db, MintParams.parse(req.params).mint, now()));

  app.get("/coins/:mint/candles", async (req) => {
    const { mint } = MintParams.parse(req.params);
    const q = CandlesQuery.parse(req.query);
    return candles(db, mint, q);
  });

  app.get("/coins/:mint/trades", async (req) => {
    const { mint } = MintParams.parse(req.params);
    const q = TradesQuery.parse(req.query);
    return trades(db, mint, q);
  });

  app.get("/coins/:mint/holders", async (req) => {
    const { mint } = MintParams.parse(req.params);
    return holders(db, mint, { limit: LimitQuery(50, 500).parse(req.query).limit, now: now() });
  });

  app.get("/coins/:mint/defends", async (req) => {
    const { mint } = MintParams.parse(req.params);
    return defends(db, mint, LimitQuery(50, 500).parse(req.query).limit);
  });

  app.get("/coins/:mint/rounds", async (req) => {
    const { mint } = MintParams.parse(req.params);
    return rounds(db, mint, LimitQuery(30, 500).parse(req.query).limit);
  });

  app.get("/coins/:mint/rounds/:roundId", async (req) => {
    const p = RoundParams.parse(req.params);
    return roundSnapshot(db, p.mint, p.roundId);
  });
}
