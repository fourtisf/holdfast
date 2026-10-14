import type { FastifyInstance } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import type { TradeBuildResponse, TradeQuote } from "@holdfast/core";
import type { ApiContext } from "../context.js";
import { badRequest } from "../errors.js";
import { requireCoin } from "../services/market.js";
import { assembleTransaction, tradeInstructions } from "../trade/build.js";
import { quoteTrade } from "../trade/quote.js";
import { base58Address } from "../validation.js";

export const MAX_PRIORITY_MICROLAMPORTS = 40_000_000;

const TradeRequest = z.object({
  mint: base58Address,
  /** Optional for quotes: a disconnected UI sends the System Program address (or nothing). */
  wallet: base58Address.optional(),
  side: z.enum(["buy", "sell"]),
  amount: z.number().positive().finite().max(1e12),
  slippageBps: z.number().int().min(0).max(5_000),
  /** Priority fee: compute-unit price in micro-lamports (≤ 0.01 SOL at the curve's CU limit). */
  priorityMicroLamports: z.number().int().min(0).max(MAX_PRIORITY_MICROLAMPORTS).optional(),
});

export function tradeRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const prepare = async (body: unknown, needsWallet: boolean) => {
    const req = TradeRequest.parse(body);
    const wallet = req.wallet ? new PublicKey(req.wallet) : PublicKey.default;
    if (needsWallet && wallet.equals(PublicKey.default)) throw badRequest("wallet: connect a wallet to build a transaction");
    const coin = await requireCoin(ctx.db, req.mint);
    const venue = await ctx.tradeChain.loadVenue(coin, wallet);
    return { req, coin, wallet, venue, ...quoteTrade(venue, req, coin.decimals) };
  };

  // Quote-only without a wallet: no token-account checks happen when quoting.
  app.post("/trade/quote", async (req): Promise<TradeQuote> => (await prepare(req.body, false)).quote);

  app.post("/trade/build", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req): Promise<TradeBuildResponse> => {
    const p = await prepare(req.body, true);
    const [instructions, latest] = await Promise.all([tradeInstructions(p.venue, p.plan, p.wallet), ctx.tradeChain.latestBlockhash()]);
    const tx = assembleTransaction({
      instructions,
      payer: p.wallet,
      blockhash: latest.blockhash,
      computeUnitLimit: p.venue.venue === "curve" ? ctx.config.trade.computeUnitLimitCurve : ctx.config.trade.computeUnitLimitAmm,
      computeUnitPriceMicroLamports: p.req.priorityMicroLamports ?? ctx.config.trade.computeUnitPriceMicroLamports,
    });
    return { quote: p.quote, transaction: Buffer.from(tx.serialize()).toString("base64"), lastValidBlockHeight: latest.lastValidBlockHeight };
  });
}
