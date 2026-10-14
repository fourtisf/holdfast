import type { FastifyInstance } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import type { CreatorClaimBuildResponse } from "@holdfast/core";
import { claimCreatorFeesIx } from "@holdfast/chain";
import { getVaultState } from "@holdfast/db";
import type { ApiContext } from "../context.js";
import { HttpError } from "../errors.js";
import { lamportsToSol } from "../format.js";
import { requireCoin } from "../services/market.js";
import { assembleTransaction } from "../trade/build.js";
import { base58Address } from "../validation.js";
import { MAX_PRIORITY_MICROLAMPORTS } from "./trade.js";

/** `claim_creator_fees` is one system transfer: a small compute budget is plenty. */
export const CLAIM_COMPUTE_UNITS = 40_000;

const ClaimRequest = z.object({
  mint: base58Address,
  wallet: base58Address,
  priorityMicroLamports: z.number().int().min(0).max(MAX_PRIORITY_MICROLAMPORTS).optional(),
});

export function creatorRoutes(app: FastifyInstance, ctx: ApiContext): void {
  /** Unsigned claim transaction for the coin's creator; the program itself checks the signer again. */
  app.post("/creator/claim/build", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req): Promise<CreatorClaimBuildResponse> => {
    const body = ClaimRequest.parse(req.body);
    const coin = await requireCoin(ctx.db, body.mint);
    if (coin.creator !== body.wallet) throw new HttpError(403, "Only the coin's creator wallet can claim its fees");
    const claimable = (await getVaultState(ctx.db, coin.mint))?.creatorSol ?? 0n;
    if (claimable <= 0n) throw new HttpError(409, "Nothing to claim yet");

    const wallet = new PublicKey(body.wallet);
    const latest = await ctx.tradeChain.latestBlockhash();
    const tx = assembleTransaction({
      instructions: [claimCreatorFeesIx({ mint: new PublicKey(coin.mint), vault: new PublicKey(coin.vault), treasury: new PublicKey(coin.treasury) }, wallet)],
      payer: wallet,
      blockhash: latest.blockhash,
      computeUnitLimit: CLAIM_COMPUTE_UNITS,
      computeUnitPriceMicroLamports: body.priorityMicroLamports ?? ctx.config.trade.computeUnitPriceMicroLamports,
    });
    return { transaction: Buffer.from(tx.serialize()).toString("base64"), lastValidBlockHeight: latest.lastValidBlockHeight, claimableSol: lamportsToSol(claimable) };
  });
}
