import { PublicKey, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import {
  assessRound,
  buildRoundSnapshot,
  computeRound,
  DEFAULT_PAYOUT_COST_MODEL,
  effectiveMinSol,
  effectiveMinTokens,
  type CarryInput,
  type PayoutCostModel,
} from "@holdfast/core";
import {
  associatedTokenAddress,
  closeRoundIx,
  collectFeesIx,
  decodeCoinVault,
  decodePayoutRound,
  openRoundIx,
  payoutIx,
  roundPda,
  type CoinKeys,
  type PayoutIxEntry,
} from "@holdfast/chain";
import { getCoin, getRound, insertRound, markPayout, notify, saveCarries, updateRoundStatus, type Db } from "@holdfast/db";
import type { Logger } from "pino";

import type { KeeperChain } from "../chain.js";
import type { PayoutConfig } from "../config.js";
import type { PumpGateway } from "../pump.js";
import { loadTreasuryAccounts } from "../state.js";
import { gatherRoundInputs } from "./inputs.js";

export interface PayoutDeps {
  db: Db;
  chain: KeeperChain;
  keeper: Keypair;
  pump: PumpGateway | null;
  cfg: PayoutConfig;
  log: Logger;
}

export type RoundOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "paid"; roundId: bigint; recipients: number; paid: number; failed: number; solPaid: bigint; tokensPaid: bigint };

interface Entry {
  index: number;
  wallet: string;
  sol: bigint;
  tokens: bigint;
}

/** Fee model of this worker's payout transactions (see @holdfast/core economics). */
export function payoutCostModel(cfg: PayoutConfig): PayoutCostModel {
  return { ...DEFAULT_PAYOUT_COST_MODEL, priorityMicroLamports: BigInt(cfg.priorityMicroLamports), maxFeeBps: cfg.maxFeeBps };
}

const OPEN_UNITS = DEFAULT_PAYOUT_COST_MODEL.openUnits;
const CLOSE_UNITS = DEFAULT_PAYOUT_COST_MODEL.closeUnits;

/** Current price as lamports per token base unit × 1e18 (from the indexer's last trade), or null. */
async function priceFixed(db: Db, mint: string): Promise<bigint | null> {
  const coin = await getCoin(db, mint);
  if (!coin?.lastPrice || !(coin.lastPrice > 0)) return null;
  // lastPrice: SOL per whole token → lamports per base unit × 1e18
  return BigInt(Math.round(coin.lastPrice * 1e9 * 1e18 / 10 ** coin.decimals));
}

/** One payout round for one coin: collect → snapshot → open → pay in batches → reconcile → close. */
export async function runPayoutRound(deps: PayoutDeps, coin: CoinKeys): Promise<RoundOutcome> {
  const { db, chain, keeper, cfg, log } = deps;
  const mint = coin.mint.toBase58();

  const readVault = async () => {
    const [info] = await chain.getAccounts([coin.vault]);
    return info ? decodeCoinVault(info.data) : null;
  };
  let vault = await readVault();
  if (!vault) return { kind: "skipped", reason: "vault not found" };

  if (cfg.collectBeforeRound && !vault.roundOpen) {
    try {
      const claims = deps.pump ? await deps.pump.feeClaimInstructions(coin, keeper.publicKey, vault.venue === "amm") : [];
      const existing = await loadTreasuryAccounts(chain, coin, vault.venue);
      await chain.send([...claims, collectFeesIx(coin, existing)], [keeper], { computeUnits: 400_000 });
      vault = (await readVault()) ?? vault;
    } catch (err) {
      log.debug({ mint, err: (err as Error).message }, "pre-round fee collection failed (continuing)");
    }
  }

  if (vault.roundOpen) return resumeRound(deps, coin, vault.roundId);

  const nextId = vault.roundId + 1n;
  // A round computed but never opened (crash before open_round) is stale: drop and recompute.
  await db.tx(async (q) => {
    await q.query("DELETE FROM payouts WHERE mint = $1 AND round_id = $2 AND EXISTS (SELECT 1 FROM payout_rounds r WHERE r.mint = $1 AND r.round_id = $2 AND r.status = 'computed')", [mint, String(nextId)]);
    await q.query("DELETE FROM payout_rounds WHERE mint = $1 AND round_id = $2 AND status = 'computed'", [mint, String(nextId)]);
  });

  // Minimum payouts are raised so that no recipient's share of a batch fee exceeds maxFeeBps; the
  // effective values are part of the published inputs, so the snapshot stays re-verifiable.
  const model = payoutCostModel(cfg);
  const price = await priceFixed(db, mint);
  const roundCfg: PayoutConfig = { ...cfg, minSolLamports: effectiveMinSol(cfg.minSolLamports, model), minTokensRaw: effectiveMinTokens(cfg.minTokensRaw, model, price) };
  const { inputs, tokenAccounts } = await gatherRoundInputs(db, chain, coin, vault, roundCfg, chain.nowMs());
  const result = computeRound(inputs);
  if (result.entries.length === 0) return { kind: "skipped", reason: "nothing payable this round" };

  const economics = assessRound(model, result.entries.length, result.solPot, result.tokenPot, price);
  if (!economics.worthIt) {
    // Nothing moves: the pot stays in the on-chain bucket and the next round pays it, bigger.
    log.debug({ mint, fee: String(economics.feeLamports), value: String(economics.valueLamports), recipients: economics.recipients }, "round not worth its fees yet");
    return { kind: "skipped", reason: `pot too small for its fees (${economics.feeLamports} lamports of fees for ${economics.valueLamports} paid)` };
  }
  const [keeperInfo] = await chain.getAccounts([keeper.publicKey]);
  const keeperBalance = BigInt(keeperInfo?.lamports ?? 0);
  if (keeperBalance < cfg.keeperMinBalanceLamports + economics.feeLamports) {
    log.error({ mint, keeper: keeper.publicKey.toBase58(), balance: String(keeperBalance) }, "keeper balance too low to open a round");
    return { kind: "skipped", reason: "keeper balance too low" };
  }

  const snapshot = buildRoundSnapshot(inputs, result, chain.nowMs());
  if (!(await insertRound(db, snapshot, { status: "computed" }))) return { kind: "skipped", reason: `round ${nextId} already recorded` };

  const openSig = await chain.send(
    [openRoundIx(coin, keeper.publicKey, nextId, result.solPot, result.tokenPot, result.merkleRoot, result.entries.length)],
    [keeper],
    { computeUnits: OPEN_UNITS, microLamports: cfg.priorityMicroLamports },
  );
  await updateRoundStatus(db, mint, nextId, "opened", { openSig });
  await notify(db, { kind: "round", mint, roundId: Number(nextId) });
  log.info({ mint, roundId: String(nextId), recipients: result.entries.length, sol: String(result.solPot), tokens: String(result.tokenPot) }, "round opened");

  return payAndClose(deps, coin, nextId, result.entries, result.carriedOut, tokenAccounts);
}

async function resumeRound(deps: PayoutDeps, coin: CoinKeys, roundId: bigint): Promise<RoundOutcome> {
  const { db, chain, keeper, log } = deps;
  const mint = coin.mint.toBase58();
  const stored = await getRound(db, mint, roundId);
  if (!stored) {
    // Unknown round (DB lost): close it; unpaid amounts stay in the on-chain bucket, carries untouched.
    log.error({ mint, roundId: String(roundId) }, "open round missing from DB; closing it without payouts");
    await chain.send([closeRoundIx(coin, keeper.publicKey, roundId)], [keeper]);
    return { kind: "skipped", reason: "closed orphan round" };
  }
  log.warn({ mint, roundId: String(roundId) }, "resuming open round");
  const snapshot = stored.snapshot;
  const entries: Entry[] = snapshot.entries.map((e) => ({ index: e.index, wallet: e.wallet, sol: BigInt(e.solLamports), tokens: BigInt(e.tokensRaw) }));
  const tokenAccounts = new Map(entries.filter((e) => e.tokens > 0n).map((e) => [e.wallet, associatedTokenAddress(new PublicKey(e.wallet), coin.mint, coin.tokenProgram)]));
  const carriedOut: CarryInput[] = snapshot.carriedOut.map((c) => ({ wallet: c.wallet, sol: BigInt(c.solLamports), tokens: BigInt(c.tokensRaw), since: c.since }));
  return payAndClose(deps, coin, roundId, entries, carriedOut, tokenAccounts);
}

async function payAndClose(
  deps: PayoutDeps,
  coin: CoinKeys,
  roundId: bigint,
  entries: Entry[],
  carriedOut: CarryInput[],
  tokenAccounts: Map<string, PublicKey>,
): Promise<RoundOutcome> {
  const { db, chain, keeper, log } = deps;
  const mint = coin.mint.toBase58();

  const paidOnChain = await readPaidBitmap(chain, coin, roundId);
  const pending = entries.filter((e) => !paidOnChain(e.index));
  const toIx = (batch: Entry[]): TransactionInstruction =>
    payoutIx(
      coin,
      keeper.publicKey,
      roundId,
      batch.map<PayoutIxEntry>((e) => ({
        index: e.index,
        wallet: new PublicKey(e.wallet),
        sol: e.sol,
        tokens: e.tokens,
        tokenAccount: e.tokens > 0n ? tokenAccounts.get(e.wallet) : undefined,
      })),
    );

  if (pending.length > 0) await updateRoundStatus(db, mint, roundId, "paying");
  for (const batch of planBatches(pending, toIx, (ixs) => chain.fits(ixs, keeper.publicKey, 1), DEFAULT_PAYOUT_COST_MODEL.batchSize)) {
    await sendBatch(deps, coin, roundId, batch, toIx);
  }

  // Reconcile against the on-chain bitmap: it is the source of truth for what was paid.
  const paid = await readPaidBitmap(chain, coin, roundId);
  const failed: Entry[] = [];
  let solPaid = 0n;
  let tokensPaid = 0n;
  for (const e of entries) {
    if (paid(e.index)) {
      solPaid += e.sol;
      tokensPaid += e.tokens;
      await markPayout(db, { mint, roundId, idx: e.index, status: "confirmed" });
    } else {
      failed.push(e);
      await markPayout(db, { mint, roundId, idx: e.index, status: "failed" });
    }
  }

  const closeSig = await chain.send([closeRoundIx(coin, keeper.publicKey, roundId)], [keeper], { computeUnits: CLOSE_UNITS, microLamports: deps.cfg.priorityMicroLamports });
  await db.tx(async (q) => {
    await saveCarries(q, mint, mergeCarries(carriedOut, failed, chain.nowMs()));
    await updateRoundStatus(q, mint, roundId, "closed", { closeSig, error: failed.length > 0 ? `${failed.length} payouts carried to the next round` : null });
    await notify(q, [{ kind: "round", mint, roundId: Number(roundId) }, { kind: "vault", mint }]);
  });
  log.info({ mint, roundId: String(roundId), paid: entries.length - failed.length, failed: failed.length }, "round closed");
  return { kind: "paid", roundId, recipients: entries.length, paid: entries.length - failed.length, failed: failed.length, solPaid, tokensPaid };
}

/** Sends a batch; on failure retries its entries one by one so one bad recipient cannot block the rest. */
async function sendBatch(deps: PayoutDeps, coin: CoinKeys, roundId: bigint, batch: Entry[], toIx: (b: Entry[]) => TransactionInstruction): Promise<void> {
  const { db, chain, keeper, log } = deps;
  const mint = coin.mint.toBase58();
  try {
    const units = DEFAULT_PAYOUT_COST_MODEL.batchBaseUnits + DEFAULT_PAYOUT_COST_MODEL.batchUnitsPerRecipient * batch.length;
    const sig = await chain.send([toIx(batch)], [keeper], { computeUnits: units, microLamports: deps.cfg.priorityMicroLamports });
    for (const e of batch) await markPayout(db, { mint, roundId, idx: e.index, status: "sent", sig });
  } catch (err) {
    if (batch.length === 1) {
      log.warn({ mint, roundId: String(roundId), wallet: batch[0]!.wallet, err: (err as Error).message }, "payout failed; will be carried");
      return;
    }
    for (const e of batch) await sendBatch(deps, coin, roundId, [e], toIx);
  }
}

async function readPaidBitmap(chain: KeeperChain, coin: CoinKeys, roundId: bigint): Promise<(i: number) => boolean> {
  const [info] = await chain.getAccounts([roundPda(coin.mint, roundId)]);
  if (!info) return () => false;
  return decodePayoutRound(info.data).isPaid;
}

/** Greedy packing of entries into transactions under the packet size limit. */
export function planBatches<T>(entries: readonly T[], toIx: (batch: T[]) => TransactionInstruction, fits: (ixs: TransactionInstruction[]) => boolean, maxPerBatch = 12): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  for (const e of entries) {
    const candidate = [...current, e];
    if (candidate.length > maxPerBatch || (current.length > 0 && !fits([toIx(candidate)]))) {
      batches.push(current);
      current = [e];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Unpaid entries join the carry book (their amounts never left the on-chain bucket). */
export function mergeCarries(carriedOut: readonly CarryInput[], failed: readonly Entry[], nowMs: number): CarryInput[] {
  const book = new Map(carriedOut.map((c) => [c.wallet, { ...c }]));
  for (const f of failed) {
    const existing = book.get(f.wallet);
    if (existing) {
      existing.sol += f.sol;
      existing.tokens += f.tokens;
    } else {
      book.set(f.wallet, { wallet: f.wallet, sol: f.sol, tokens: f.tokens, since: nowMs });
    }
  }
  return [...book.values()].sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
}
