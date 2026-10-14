import { PublicKey, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import {
  bondingCurvePda,
  burnHoldIx,
  canonicalPoolPda,
  collectFeesIx,
  decodeBondingCurve,
  decodeConfig,
  decodeMintSupply,
  defendIx,
  graduateIx,
  prepareTreasuryIx,
  updateAthIx,
  VENUE_AMM,
  VENUE_CURVE,
  configPda,
  type CoinKeys,
  type ConfigAccount,
  type CoinVaultAccount,
} from "@holdfast/chain";
import type { Logger } from "pino";

import type { KeeperChain } from "./chain.js";
import { applySlippage, planCrank, quoteBuy, type CrankAction, type CrankMemory, type PlanOptions } from "./plan.js";
import type { PumpGateway } from "./pump.js";
import { loadCoinState, loadPool, type CoinChainState } from "./state.js";

export interface CrankContext {
  chain: KeeperChain;
  pump: PumpGateway;
  keeper: Keypair;
  log: Logger;
  options: Omit<PlanOptions, "holdMintSet"> & { defendJitterMs: number; burnSlippageBps: number };
  /** Called with the fresh vault after any action (DB mirror). */
  onVault?: (coin: CoinKeys, vault: CoinVaultAccount) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export interface CrankResult {
  actions: CrankAction["kind"][];
  sent: { action: CrankAction["kind"]; sig: string }[];
  errors: { action: CrankAction["kind"]; error: string }[];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function loadProgramConfig(chain: KeeperChain): Promise<ConfigAccount> {
  const [info] = await chain.getAccounts([configPda()]);
  if (!info) throw new Error("Holdfast config account not found (program not initialized?)");
  return decodeConfig(info.data);
}

/** One crank pass over a coin: read state, plan, execute each action independently. */
export async function crankCoin(ctx: CrankContext, coin: CoinKeys, config: ConfigAccount, memory: CrankMemory): Promise<CrankResult> {
  const result: CrankResult = { actions: [], sent: [], errors: [] };
  const state = await loadCoinState(ctx.chain, coin);
  if (!state) return result;
  const nowSec = Math.floor(ctx.chain.nowMs() / 1000);
  const actions = planCrank(state, config.params, memory, nowSec, { ...ctx.options, holdMintSet: config.holdMint !== null });
  result.actions = actions.map((a) => a.kind);

  for (const action of actions) {
    try {
      const sig = await execute(ctx, state, config, action);
      if (sig) result.sent.push({ action: action.kind, sig });
      if (action.kind === "collect") memory.lastCollectAt = nowSec;
      if (action.kind === "burn") memory.lastBurnAt = nowSec;
    } catch (err) {
      result.errors.push({ action: action.kind, error: (err as Error).message });
      ctx.log.warn({ mint: coin.mint.toBase58(), action: action.kind, err: (err as Error).message }, "crank action failed");
    }
  }

  if (result.sent.length > 0 && ctx.onVault) {
    const fresh = await loadCoinState(ctx.chain, coin);
    if (fresh) await ctx.onVault(coin, fresh.vault);
  }
  return result;
}

async function send(ctx: CrankContext, ixs: TransactionInstruction[], computeUnits = 300_000): Promise<string> {
  return ctx.chain.send(ixs, [ctx.keeper], { computeUnits });
}

async function execute(ctx: CrankContext, s: CoinChainState, config: ConfigAccount, action: CrankAction): Promise<string | null> {
  const keeper = ctx.keeper.publicKey;
  const coin = s.coin;
  switch (action.kind) {
    case "graduate":
      // The PumpSwap volume accumulator follows through `prepare` on the next pass (venue = amm).
      return s.pool ? send(ctx, [graduateIx(coin, s.pool.address)]) : null;
    case "prepare":
      return send(ctx, [prepareTreasuryIx(coin, s.treasury.volumeAccumulator ? null : s.vault.venue)], 200_000);
    case "update_ath":
      return send(ctx, [updateAthIx(coin, keeper, s.priceAccounts)], 120_000);
    case "collect": {
      const claims = await ctx.pump.feeClaimInstructions(coin, keeper, s.vault.venue === "amm");
      return send(ctx, [...claims, collectFeesIx(coin, { tokenAccount: s.treasury.tokenAccount, wsolAccount: s.treasury.wsolAccount })], 400_000);
    }
    case "defend": {
      const jitter = Math.floor(Math.random() * ctx.options.defendJitterMs);
      if (jitter > 0) await (ctx.sleep ?? defaultSleep)(jitter);
      const venueAccounts =
        s.vault.venue === "amm" && s.pool
          ? await ctx.pump.ammBuyAccounts(s.pool.address, coin.treasury)
          : await ctx.pump.curveBuyAccounts(coin.mint, coin.treasury, coin.tokenProgram, s.curve.creator);
      // Anyone may defend; the keeper just makes sure someone does.
      return send(ctx, [defendIx(coin, keeper, s.priceAccounts, venueAccounts, action.minTokensOut)], 500_000);
    }
    case "burn": {
      const holdMint = config.holdMint;
      if (!holdMint) return null;
      return send(ctx, [await buildBurn(ctx, s, holdMint)], 500_000);
    }
  }
}

/** Finds $HOLD's market (curve or PumpSwap) and builds `burn_hold` with a quote-based `min_hold_out`. */
async function buildBurn(ctx: CrankContext, s: CoinChainState, holdMint: PublicKey): Promise<TransactionInstruction> {
  const keeper = ctx.keeper.publicKey;
  const curveKey = bondingCurvePda(holdMint);
  const [mintInfo, curveInfo] = await ctx.chain.getAccounts([holdMint, curveKey]);
  if (!mintInfo) throw new Error("$HOLD mint not found");
  const holdTokenProgram = mintInfo.owner;
  decodeMintSupply(mintInfo.data);
  const budget = s.vault.burnSol;
  const curve = curveInfo ? decodeBondingCurve(curveInfo.data) : null;

  if (curve && !curve.complete) {
    const expected = quoteBuy(budget, curve.virtualQuoteReserves, curve.virtualTokenReserves, ctx.options.curveFeeBpsEstimate);
    const venueAccounts = await ctx.pump.curveBuyAccounts(holdMint, s.coin.treasury, holdTokenProgram, curve.creator);
    return burnHoldIx(s.coin, keeper, holdMint, holdTokenProgram, VENUE_CURVE, { holdPriceAccount: curveKey }, venueAccounts, applySlippage(expected, ctx.options.burnSlippageBps));
  }
  const pool = await loadPool(ctx.chain, holdMint);
  if (!pool) throw new Error("$HOLD has neither an active curve nor a canonical pool");
  const expected = quoteBuy(budget, pool.quoteAmount + pool.virtualQuoteReserves, pool.baseAmount, ctx.options.ammFeeBpsEstimate);
  const venueAccounts = await ctx.pump.ammBuyAccounts(canonicalPoolPda(holdMint), s.coin.treasury);
  return burnHoldIx(
    s.coin,
    keeper,
    holdMint,
    holdTokenProgram,
    VENUE_AMM,
    { holdPriceAccount: pool.address, poolBaseAccount: pool.poolBaseTokenAccount, poolQuoteAccount: pool.poolQuoteTokenAccount },
    venueAccounts,
    applySlippage(expected, ctx.options.burnSlippageBps),
  );
}
