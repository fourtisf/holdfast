/**
 * Database writes made the way the other services make them, NOTIFY included, so the notifier sees
 * exactly what it sees in production: the indexer (apps/indexer/src/process.ts: trades, buybacks,
 * $MOATPAD burns, graduations), the launcher (apps/launcher/src/worker.ts: launch status transitions,
 * registering the coin) and the payout worker (apps/keeper/src/payout/worker.ts: rounds).
 */
import { createHash, randomUUID } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { buildRoundSnapshot, computeRound, fixedToSolPerToken, RENT_EXEMPT_MIN_LAMPORTS, tradePrice, type LaunchStatusKind, type RoundInputs } from "@holdfast/core";
import {
  addTgLaunch,
  applyVaultDelta,
  ensureVaultState,
  insertCoin,
  insertDefend,
  insertHoldBurn,
  insertLaunch,
  insertRound,
  insertTrade,
  loadLedger,
  markGraduated,
  markPayout,
  nextDepositIndex,
  notify,
  saveCarries,
  saveLedger,
  updateLastPrice,
  updateLaunchStatus,
  updateRoundStatus,
  upsertCandles,
  upsertVaultState,
  type Db,
  type HoldfastNotification,
  type LaunchPatch,
  type LaunchRow,
  type NewCoin,
} from "@holdfast/db";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** A deterministic, valid-looking transaction signature (64 bytes, base58). */
export function sig(label: string): string {
  return base58(createHash("sha512").update(`e2e:${label}`).digest());
}

export function address(label: string): string {
  return Keypair.fromSeed(createHash("sha256").update(`e2e-address:${label}`).digest()).publicKey.toBase58();
}

let slot = 400_000_000;

/** Fixed-point prices (lamports per base unit × 1e18): 3.2e-8 and 2.4e-8 SOL per token (32 and 24 SOL market cap). */
const ATH_FIXED = 32_000_000_000_000n;
const FLOOR_FIXED = 24_000_000_000_000n;
/** The floor price registered coins get, in SOL per token (what the defence message prints). */
export const FLOOR_PRICE_SOL = fixedToSolPerToken(FLOOR_FIXED, 6);

export interface E2eCoin {
  mint: string;
  name: string;
  ticker: string;
  treasury: string;
  decimals: number;
}

/** A Moatpad coin the way the launcher registers it (registerCoin): coin row, vault state, `coin` NOTIFY. */
export async function registerCoin(db: Db, c: { label: string; name: string; ticker: string; floorSol: bigint; createdAt: number; mint?: string }): Promise<E2eCoin> {
  const coin: NewCoin = {
    mint: c.mint ?? address(`mint:${c.label}`),
    name: c.name,
    ticker: c.ticker,
    triggerBps: 2500,
    vault: address(`vault:${c.label}`),
    treasury: address(`treasury:${c.label}`),
    bondingCurve: address(`curve:${c.label}`),
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    decimals: 6,
    createdAt: c.createdAt,
    launchSig: sig(`launch:${c.label}`),
  };
  await db.tx(async (q) => {
    await insertCoin(q, coin);
    await ensureVaultState(q, coin.mint);
    await notify(q, { kind: "coin", mint: coin.mint });
  });
  // A floor bucket and a floor/ATH, as FeesCollected / AthUpdated events leave them.
  await upsertVaultState(db, {
    mint: coin.mint,
    floorSol: c.floorSol,
    holderSol: 0n,
    creatorSol: 0n,
    platformSol: 0n,
    burnSol: 0n,
    holderTokens: 0n,
    ath: ATH_FIXED,
    floor: FLOOR_FIXED,
    defendCount: 0n,
    lastDefendTs: null,
    roundId: 0n,
    totalFees: 0n,
    totalDefended: 0n,
    totalPaidSol: 0n,
    totalPaidTokens: 0n,
    totalBurnedSol: 0n,
    totalCreatorClaimed: 0n,
    totalPlatformSwept: 0n,
    slot: ++slot,
  });
  return { mint: coin.mint, name: c.name, ticker: c.ticker, treasury: coin.treasury, decimals: 6 };
}

export interface IndexedTrade {
  sig: string;
  ixIndex?: number;
  wallet: string;
  side: "buy" | "sell";
  lamports: bigint;
  tokens: bigint;
  ts: number;
  /** Spot price after the trade (SOL per whole token); the indexer stores it as the coin's last price. */
  spotAfter: number;
}

/**
 * One swap indexed like TxRun.recordTrades: trade row (execution price), candles, the coin's last
 * (spot) price, then `trade` NOTIFY on commit. `notifyTimes` > 1 sends the same notification again
 * in later transactions (a replay / a second indexer source).
 */
export async function indexTrade(db: Db, coin: E2eCoin, t: IndexedTrade, notifyTimes = 1): Promise<void> {
  const s = ++slot;
  await db.tx(async (q) => {
    const ok = await insertTrade(q, {
      sig: t.sig,
      ixIndex: t.ixIndex ?? 2,
      mint: coin.mint,
      wallet: t.wallet,
      side: t.side,
      sol: t.lamports,
      tokens: t.tokens,
      price: tradePrice(t.lamports, t.tokens, coin.decimals),
      ts: t.ts,
      slot: s,
      source: "curve",
    });
    if (!ok) throw new Error(`trade ${t.sig} already indexed`);
    await upsertCandles(q, { mint: coin.mint, ts: t.ts, price: tradePrice(t.lamports, t.tokens, coin.decimals), volume: t.lamports, slot: s });
    await updateLastPrice(q, coin.mint, t.spotAfter, t.ts, s);
    await notify(q, [{ kind: "trade", mint: coin.mint, sig: t.sig }, { kind: "vault", mint: coin.mint }]);
  });
  for (let i = 1; i < notifyTimes; i++) await notify(db, { kind: "trade", mint: coin.mint, sig: t.sig });
}

/**
 * A wallet's buy as applyLots stores it (saveLedger: a new FIFO lot from the buy's block time and the
 * balance mirror). The lots are what weight milestones are measured on.
 */
export async function indexLot(db: Db, coin: E2eCoin, l: { wallet: string; amount: bigint; acquiredAt: number; sig: string }): Promise<void> {
  const s = ++slot;
  await db.tx(async (q) => {
    const ledger = await loadLedger(q, coin.mint, l.wallet, { forUpdate: true });
    await saveLedger(q, {
      mint: coin.mint,
      wallet: l.wallet,
      ledger: { ...ledger, balance: ledger.balance + l.amount },
      consumed: [],
      newLots: [{ wallet: l.wallet, mint: coin.mint, amount: l.amount, acquiredAt: l.acquiredAt, sourceSig: l.sig, sourceIx: 2 }],
      slot: s,
    });
  });
}

/** A floor defence: the treasury's buy (side 'vault') plus the Defended event (defends row, vault delta). */
export async function indexBuyback(db: Db, coin: E2eCoin, b: { sig: string; lamports: bigint; tokens: bigint; ts: number }): Promise<void> {
  const s = ++slot;
  const price = tradePrice(b.lamports, b.tokens, coin.decimals);
  await db.tx(async (q) => {
    await insertTrade(q, { sig: b.sig, ixIndex: 3, mint: coin.mint, wallet: coin.treasury, side: "vault", sol: b.lamports, tokens: b.tokens, price, ts: b.ts, slot: s, source: "vault" });
    await upsertCandles(q, { mint: coin.mint, ts: b.ts, price, volume: b.lamports, slot: s });
    await insertDefend(q, { sig: b.sig, mint: coin.mint, solSpent: b.lamports, tokensBought: b.tokens, price, ts: b.ts });
    await applyVaultDelta(q, coin.mint, { floorSol: -b.lamports, holderTokens: b.tokens, totalDefended: b.lamports, defends: 1, lastDefendTs: b.ts });
    await notify(q, [{ kind: "trade", mint: coin.mint, sig: b.sig }, { kind: "vault", mint: coin.mint }]);
  });
}

/** HoldBurned: hold_burns row + vault delta, `burn` NOTIFY. */
export async function indexBurn(db: Db, coin: E2eCoin, b: { sig: string; lamports: bigint; holdBurned: bigint; ts: number }, notifyTimes = 1): Promise<void> {
  await db.tx(async (q) => {
    await applyVaultDelta(q, coin.mint, { burnSol: -b.lamports, totalBurnedSol: b.lamports });
    await insertHoldBurn(q, { sig: b.sig, mint: coin.mint, solSpent: b.lamports, holdBurned: b.holdBurned, ts: b.ts });
    await notify(q, [{ kind: "burn", mint: coin.mint, sig: b.sig }, { kind: "vault", mint: coin.mint }]);
  });
  for (let i = 1; i < notifyTimes; i++) await notify(db, { kind: "burn", mint: coin.mint, sig: b.sig });
}

/** Graduated event (or the PumpSwap migration): markGraduated, `coin` NOTIFY. */
export async function indexGraduation(db: Db, coin: E2eCoin, atMs: number): Promise<void> {
  await db.tx(async (q) => {
    await markGraduated(q, coin.mint, address(`pool:${coin.mint}`), atMs);
    await notify(q, { kind: "coin", mint: coin.mint });
  });
}

/** Launcher.transition: status change + `launch` NOTIFY in one transaction. Null if the row was not in `from`. */
export async function transition(db: Db, id: string, status: LaunchStatusKind, patch: LaunchPatch, from: readonly LaunchStatusKind[]): Promise<LaunchRow | null> {
  return db.tx(async (q) => {
    const row = await updateLaunchStatus(q, id, status, patch, from);
    if (row) await notify(q, { kind: "launch", launchId: id });
    return row;
  });
}

/** A launch row the bot did not create (barriers): the API's insert, linked to `chatId` like the bot links its own. */
export async function insertBotLaunch(db: Db, chatId: number, ticker: string): Promise<string> {
  const id = randomUUID();
  await db.tx(async (q) => {
    const index = await nextDepositIndex(q);
    await insertLaunch(q, {
      id,
      form: { name: `${ticker} coin`, ticker, triggerBps: 2500 },
      depositAddress: Keypair.generate().publicKey.toBase58(),
      depositIndex: index,
      requiredLamports: 20_000_000n,
      devBuyLamports: 0n,
      expiresAt: Date.now() + 30 * 60_000,
    });
  });
  await addTgLaunch(db, id, chatId);
  return id;
}

/**
 * A payout round run like runPayoutRound + payAndClose: computed snapshot stored, opened (NOTIFY),
 * paying, every payout confirmed, then closed with the carries (NOTIFY round + vault). `holders`
 * hold one lot each, bought a week ago (full weight).
 */
export async function runPayoutRound(
  db: Db,
  coin: E2eCoin,
  r: { roundId: bigint; potSol: bigint; potTokens: bigint; holders: { wallet: string; amount: bigint }[]; now: number },
): Promise<{ entries: { wallet: string; sol: bigint; tokens: bigint }[]; closeSig: string }> {
  const inputs: RoundInputs = {
    mint: coin.mint,
    roundId: r.roundId,
    snapshotAt: r.now - 1_000,
    potSol: r.potSol,
    potTokens: r.potTokens,
    params: { minSolLamports: 50_000n, minTokensRaw: 1_000_000n, rentExemptMinLamports: RENT_EXEMPT_MIN_LAMPORTS, carryExpiryMs: 7 * 86_400_000, maxRecipients: 250 },
    holders: r.holders.map((h) => ({ wallet: h.wallet, lots: [{ amount: h.amount, acquiredAt: r.now - 8 * 86_400_000 }], solBalance: 2n * RENT_EXEMPT_MIN_LAMPORTS, hasTokenAccount: true })),
    carriedIn: [],
  };
  const result = computeRound(inputs);
  const snapshot = buildRoundSnapshot(inputs, result, r.now, coin.decimals);
  if (!(await insertRound(db, snapshot, { status: "computed" }))) throw new Error(`round ${r.roundId} already recorded`);
  const id = r.roundId.toString();
  await updateRoundStatus(db, coin.mint, r.roundId, "opened", { openSig: sig(`round:${coin.mint}:${id}:open`) });
  await notify(db, { kind: "round", mint: coin.mint, roundId: Number(r.roundId) });
  await updateRoundStatus(db, coin.mint, r.roundId, "paying");
  for (const e of result.entries) await markPayout(db, { mint: coin.mint, roundId: r.roundId, idx: e.index, status: "confirmed" });
  const closeSig = sig(`round:${coin.mint}:${id}:close`);
  await db.tx(async (q) => {
    await saveCarries(q, coin.mint, result.carriedOut);
    await updateRoundStatus(q, coin.mint, r.roundId, "closed", { closeSig, error: null });
    await notify(q, [
      { kind: "round", mint: coin.mint, roundId: Number(r.roundId) },
      { kind: "vault", mint: coin.mint },
    ] satisfies HoldfastNotification[]);
  });
  return { entries: result.entries.map((e) => ({ wallet: e.wallet, sol: e.sol, tokens: e.tokens })), closeSig };
}

