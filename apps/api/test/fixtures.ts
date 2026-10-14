import { Keypair } from "@solana/web3.js";
import { buildRoundSnapshot, computeRound, solPerTokenToFixed, type RoundInputs } from "@holdfast/core";
import {
  addExcluded,
  insertCoin,
  insertDefend,
  insertFloorPoint,
  insertLot,
  insertRound,
  insertTrade,
  markPayout,
  saveCarries,
  updateLastPrice,
  updateRoundStatus,
  upsertCandles,
  upsertVaultState,
  upsertWalletBalance,
  type Db,
} from "@holdfast/db";
import { NOW } from "./helpers.js";

const addr = () => Keypair.generate().publicKey.toBase58();
const H = 3_600_000;
const DAY = 24 * H;
const TOK = 1_000_000n; // 1 whole token in base units

export interface MarketFixture {
  mint: string;
  other: string;
  alice: string;
  bob: string;
  carol: string;
  pool: string;
  treasury: string;
  sigs: string[];
}

/**
 * One coin with a known book:
 *  alice: 1000 tokens in a 7-day-old lot (weight 1.0) → 1000 weighted
 *  bob:   1000 tokens bought now (weight 0.1)           → 100 weighted, 0.001 SOL carried
 *  carol: 500 tokens received by transfer (no lot)
 *  pool:  excluded
 */
export async function seedMarket(db: Db): Promise<MarketFixture> {
  const mint = addr();
  const other = addr();
  const [alice, bob, carol, pool, treasury] = [addr(), addr(), addr(), addr(), addr()];
  await insertCoin(db, {
    mint,
    name: "Holdfast Hound",
    ticker: "HOUND",
    description: "good boy",
    socials: { x: "https://x.com/hound" },
    imageUrl: "http://localhost:4000/metadata/abc.png",
    triggerBps: 2500,
    creator: carol,
    vault: addr(),
    treasury,
    bondingCurve: addr(),
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    createdAt: NOW - 3 * DAY,
  });
  await insertCoin(db, {
    mint: other,
    name: "Other Cat",
    ticker: "OCAT",
    triggerBps: 1500,
    vault: addr(),
    treasury: addr(),
    bondingCurve: addr(),
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    createdAt: NOW - 1 * H,
  });
  await addExcluded(db, [{ address: pool, reason: "pool" }]);

  // Trades: price 1e-7 two days ago, 2e-7 an hour ago, a vault buy at 1.5e-7, latest 3e-7.
  const trades = [
    { ts: NOW - 2 * DAY, wallet: alice, side: "buy" as const, sol: 100_000_000n, tokens: 1000n * TOK, price: 1e-7, source: "curve" as const },
    { ts: NOW - H, wallet: bob, side: "buy" as const, sol: 200_000_000n, tokens: 1000n * TOK, price: 2e-7, source: "curve" as const },
    { ts: NOW - 30 * 60_000, wallet: treasury, side: "vault" as const, sol: 150_000_000n, tokens: 1000n * TOK, price: 1.5e-7, source: "vault" as const },
    { ts: NOW - 60_000, wallet: carol, side: "sell" as const, sol: 30_000_000n, tokens: 100n * TOK, price: 3e-7, source: "curve" as const },
  ];
  const sigs: string[] = [];
  for (const [i, t] of trades.entries()) {
    const sig = `${addr()}${i}`;
    sigs.push(sig);
    await insertTrade(db, { sig, ixIndex: 0, mint, slot: 100 + i, ...t });
    await upsertCandles(db, { mint, ts: t.ts, price: t.price, volume: t.sol, slot: 100 + i });
  }
  await updateLastPrice(db, mint, 3.1e-7, NOW - 60_000, 103);

  await upsertWalletBalance(db, { mint, wallet: alice, balance: 1000n * TOK, untracked: 0n, slot: 1 });
  await upsertWalletBalance(db, { mint, wallet: bob, balance: 1000n * TOK, untracked: 0n, slot: 1 });
  await upsertWalletBalance(db, { mint, wallet: carol, balance: 500n * TOK, untracked: 500n * TOK, slot: 1 });
  await upsertWalletBalance(db, { mint, wallet: pool, balance: 10_000n * TOK, untracked: 10_000n * TOK, slot: 1 });
  await insertLot(db, { wallet: alice, mint, amount: 1000n * TOK, acquiredAt: NOW - 7 * DAY, sourceSig: sigs[0]!, sourceIx: 0 });
  await insertLot(db, { wallet: bob, mint, amount: 1000n * TOK, acquiredAt: NOW, sourceSig: sigs[1]!, sourceIx: 0 });

  // ATH 4e-7, floor 3e-7 (25% trigger): price 3.1e-7 sits 10% above the floor.
  const ath = solPerTokenToFixed(4e-7);
  const floor = solPerTokenToFixed(3e-7);
  await upsertVaultState(db, {
    mint,
    floorSol: 10_000_000_000n,
    holderSol: 1_000_000_000n,
    burnSol: 100_000_000n,
    holderTokens: 1000n * TOK,
    ath,
    floor,
    defendCount: 1n,
    lastDefendTs: NOW - 30 * 60_000,
    roundId: 1n,
    totalFees: 20_000_000_000n,
    totalDefended: 150_000_000n,
    totalPaidSol: 0n,
    totalPaidTokens: 0n,
    totalBurnedSol: 0n,
    creatorSol: 300_000_000n,
    totalCreatorClaimed: 50_000_000n,
    platformSol: 200_000_000n,
    totalPlatformSwept: 70_000_000n,
    slot: 200,
  });
  await insertFloorPoint(db, mint, { ts: NOW - 2 * DAY, ath: solPerTokenToFixed(2e-7), floor: solPerTokenToFixed(1.5e-7) });
  await insertFloorPoint(db, mint, { ts: NOW - DAY, ath, floor });
  await insertDefend(db, { sig: sigs[2]!, mint, solSpent: 150_000_000n, tokensBought: 1000n * TOK, price: 1.5e-7, ts: NOW - 30 * 60_000 });

  // Round 1 (one hour ago): alice was the only eligible holder.
  const inputs: RoundInputs = {
    mint,
    roundId: 1n,
    snapshotAt: NOW - H,
    potSol: 500_000_000n,
    potTokens: 0n,
    params: { minSolLamports: 1_000_000n, minTokensRaw: 1n, rentExemptMinLamports: 890_880n, carryExpiryMs: 0, maxRecipients: 10 },
    holders: [{ wallet: alice, lots: [{ amount: 1000n * TOK, acquiredAt: NOW - 7 * DAY }], solBalance: 10n ** 9n, hasTokenAccount: true }],
    carriedIn: [],
  };
  const result = computeRound(inputs);
  await insertRound(db, buildRoundSnapshot(inputs, result, NOW - H + 5_000));
  await updateRoundStatus(db, mint, 1, "closed", { openSig: "open1", closeSig: "close1" });
  await markPayout(db, { mint, roundId: 1, idx: 0, status: "confirmed", sig: "paysig1" });
  await saveCarries(db, mint, [{ wallet: bob, sol: 1_000_000n, tokens: 0n, since: NOW - H }]);

  return { mint, other, alice, bob, carol, pool, treasury, sigs };
}
