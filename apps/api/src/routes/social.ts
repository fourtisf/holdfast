import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CreatorProfile, Leaderboard, Page, WalletTrade } from "@holdfast/core";
import { creatorSummary, diamondHands, listWalletTrades, topCreators, topEarners } from "@holdfast/db";
import type { ApiContext } from "../context.js";
import { decodeCursor, encodeCursor, lamportsToSol, rawToTokens } from "../format.js";
import { listCoins } from "../services/market.js";
import { base58Address, intParam } from "../validation.js";

const LeaderboardQuery = z.object({
  kind: z.enum(["earners", "diamond_hands", "creators", "coins"]).default("earners"),
  /** earners only: payouts in the last N days (default: all time). */
  days: z.coerce.number().int().min(1).max(365).optional(),
  limit: intParam(50, 1, 100),
});

type TradesCursor = { t: number; s: string; i: number };

/** Portfolio history, leaderboards and creator pages. */
export function socialRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, now } = ctx;

  app.get("/me/trades", async (req): Promise<Page<WalletTrade>> => {
    const q = z.object({ wallet: base58Address, limit: intParam(50, 1, 200), before: z.string().max(512).optional() }).parse(req.query);
    const cur = decodeCursor<TradesCursor>(q.before);
    const rows = await listWalletTrades(db, q.wallet, { limit: q.limit + 1, before: cur ? { ts: cur.t, sig: cur.s, ixIndex: cur.i } : null });
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        sig: r.sig,
        ixIndex: r.ixIndex,
        wallet: q.wallet,
        side: r.side,
        sol: lamportsToSol(r.sol),
        tokens: rawToTokens(r.tokens, r.decimals),
        price: r.price,
        ts: r.ts,
        source: r.source,
        mint: r.mint,
        ticker: r.ticker,
        name: r.name,
      })),
      nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.ts, s: last.sig, i: last.ixIndex } satisfies TradesCursor) : null,
    };
  });

  app.get("/leaderboard", async (req): Promise<Leaderboard> => {
    const q = LeaderboardQuery.parse(req.query);
    switch (q.kind) {
      case "earners": {
        const rows = await topEarners(db, q.limit, q.days ? now() - q.days * 86_400_000 : null);
        return { kind: "earners", items: rows.map((r) => ({ wallet: r.wallet, earnedSol: lamportsToSol(r.sol), coins: r.coins, payouts: r.payouts })) };
      }
      case "diamond_hands": {
        const rows = await diamondHands(db, q.limit);
        return { kind: "diamond_hands", items: rows.map((r) => ({ wallet: r.wallet, mint: r.mint, ticker: r.ticker, heldSince: r.heldSince, tokens: rawToTokens(r.tokens, r.decimals) })) };
      }
      case "creators": {
        const rows = await topCreators(db, q.limit);
        return {
          kind: "creators",
          items: rows.map((r) => ({ wallet: r.wallet, coins: r.coins, paidToHoldersSol: lamportsToSol(r.paidToHoldersSol), totalFeesSol: lamportsToSol(r.totalFees), firstLaunchAt: r.firstLaunchAt })),
        };
      }
      case "coins": {
        const page = await listCoins(db, { sort: "top_payouts", limit: q.limit, now: now() });
        return { kind: "coins", items: page.items };
      }
    }
  });

  app.get("/creators/:wallet", async (req): Promise<CreatorProfile> => {
    const { wallet } = z.object({ wallet: base58Address }).parse(req.params);
    const [summary, coins] = await Promise.all([creatorSummary(db, wallet), listCoins(db, { sort: "newest", limit: 100, now: now(), filters: { creator: wallet } })]);
    return {
      wallet,
      coinCount: summary.coins,
      paidToHoldersSol: lamportsToSol(summary.paidToHoldersSol),
      totalFeesSol: lamportsToSol(summary.totalFees),
      firstLaunchAt: summary.firstLaunchAt,
      coinsAboveFloor: coins.items.filter((c) => c.vault.floorPrice > 0 && c.price > c.vault.floorPrice).length,
      coins: coins.items,
    };
  });
}
