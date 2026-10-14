import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import pino from "pino";
import { toHex, verifyRoundSnapshot, RENT_EXEMPT_MIN_LAMPORTS } from "@holdfast/core";
import { BorshCoder } from "@coral-xyz/anchor";
import { associatedTokenAddress, decodeCoinVault, HOLDFAST_IDL, HOLDFAST_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, type CoinKeys } from "@holdfast/chain";
import { getRound, insertCoin, insertLot, listPayouts, loadCarries } from "@holdfast/db";

import { crankCoin, loadProgramConfig, type CrankContext } from "../src/crank.js";
import type { PayoutConfig } from "../src/config.js";
import { runPayoutRound, type PayoutDeps } from "../src/payout/worker.js";
import { createWorld, programsBuilt, SOL, type World } from "./harness.js";

const log = pino({ level: "silent" });
const coder = new BorshCoder(HOLDFAST_IDL);
const ixName = (data: Buffer) => coder.instruction.decode(data)?.name;
const HOUR = 3_600_000;
/** Rent prepare_treasury takes from the floor bucket: Token-2022 ATA (170 B) + WSOL ATA (165 B) + pump accumulator (137 B). */
const prepareRent = (w: World) => [170n, 165n, 137n].reduce((s, len) => s + w.svm.minimumBalanceForRentExemption(len), 0n);

const payoutCfg: PayoutConfig = {
  minSolLamports: 20_000n,
  minTokensRaw: 1_000n,
  rentExemptMinLamports: RENT_EXEMPT_MIN_LAMPORTS,
  carryExpiryMs: 0,
  maxRecipients: 1_024,
  coinConcurrency: 1,
  collectBeforeRound: true,
  priorityMicroLamports: 1_000,
  maxFeeBps: 200,
  keeperMinBalanceLamports: 50_000_000n,
};

function crankCtx(w: World): CrankContext {
  return {
    chain: w.chain,
    pump: w.pump,
    keeper: w.keeper,
    log,
    options: {
      collectEverySecs: 120,
      defendSlippageBps: 300,
      curveFeeBpsEstimate: 200,
      ammFeeBpsEstimate: 100,
      burnThresholdLamports: 100_000_000n,
      burnEverySecs: 3_600,
      platformSweepThresholdLamports: 10_000_000n,
      platformSweepEverySecs: 3_600,
      defendJitterMs: 0,
      burnSlippageBps: 400,
    },
  };
}

function payoutDeps(w: World): PayoutDeps {
  return { db: w.db, chain: w.chain, keeper: w.keeper, pump: w.pump, cfg: payoutCfg, log };
}

async function vaultOf(w: World, coin: CoinKeys) {
  const [info] = await w.chain.getAccounts([coin.vault]);
  return decodeCoinVault(info!.data);
}

async function registerCoin(w: World, coin: CoinKeys) {
  await insertCoin(w.db, {
    mint: coin.mint.toBase58(),
    name: "Test",
    ticker: "TST",
    triggerBps: 2500,
    vault: coin.vault.toBase58(),
    treasury: coin.treasury.toBase58(),
    bondingCurve: coin.bondingCurve.toBase58(),
    tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
  });
}

/** A holder wallet with a purchase lot in the DB and a token account on-chain. */
async function holder(w: World, coin: CoinKeys, amount: bigint, ageMs: number, lamports: bigint) {
  const wallet = Keypair.generate().publicKey;
  if (lamports > 0n) w.airdrop(wallet, lamports);
  const ata = associatedTokenAddress(wallet, coin.mint, TOKEN_2022_PROGRAM_ID);
  w.setTokenAccount(ata, coin.mint, wallet, TOKEN_2022_PROGRAM_ID, amount);
  await insertLot(w.db, { wallet: wallet.toBase58(), mint: coin.mint.toBase58(), amount, acquiredAt: w.chain.nowMs() - ageMs, sourceSig: `buy-${wallet.toBase58()}`, sourceIx: 0 });
  return { wallet, ata };
}

/** Crank every 30s for `secs` (keeper cadence). */
async function crankFor(w: World, coin: CoinKeys, secs: number) {
  const memory = { lastCollectAt: 0, lastBurnAt: 0, lastSweepAt: 0 };
  const config = await loadProgramConfig(w.chain);
  const ctx = crankCtx(w);
  for (let t = 0; t <= secs; t += 40) {
    await crankCoin(ctx, coin, config, memory);
    w.advance(40);
  }
}

describe.skipIf(!programsBuilt)("keeper + payout worker against the compiled program", () => {
  it("collects fees, builds a TWAP ATH, defends the floor and pays a verifiable round", async () => {
    const w = await createWorld();
    const coin = await w.launch(2500);
    await registerCoin(w, coin);

    // the launch created no treasury token accounts: the coin pays for them out of its first fees
    expect(w.lamports(coin.treasuryTokenAccount)).toBe(0n);
    // creator fees reach the treasury (what pump.fun's collect_creator_fee_v2 does)
    w.airdrop(coin.treasury, 10n * SOL);
    await crankFor(w, coin, 660);
    let v = await vaultOf(w, coin);
    const PREPARE_RENT = prepareRent(w);
    const prepared = w.chain.events.find((e) => e.name === "TreasuryPrepared");
    expect(prepared).toMatchObject({ tokenAccount: true, wsolAccount: true, rentPaid: PREPARE_RENT });
    expect(v.totalTreasuryRent).toBe(PREPARE_RENT);
    // 40 / 25 / 15 / 10 / 10, and the keeper already swept the platform's 10% to the treasury
    expect(v.floorSol).toBe(4n * SOL - PREPARE_RENT);
    expect(v.holderSol).toBe(2_500_000_000n);
    expect(v.creatorSol).toBe(1_500_000_000n);
    expect(v.burnSol).toBe(SOL);
    expect(v.platformSol + v.totalPlatformSwept).toBe(SOL);
    expect(v.totalPlatformSwept).toBe(SOL);
    expect(w.lamports(w.platformTreasury)).toBe(2n * SOL); // airdropped 1 SOL + the sweep
    expect(v.athPrice).toBeGreaterThan(0n);
    expect(v.floorPrice).toBe((v.athPrice * 7_500n) / 10_000n);

    // price dumps 30% below the ATH → the keeper defends with 10% of the floor bucket
    const { vtok, vsol } = w.curveReserves(coin.mint);
    w.setCurveReserves(coin.mint, vtok, (vsol * 70n) / 100n);
    await crankFor(w, coin, 0);
    v = await vaultOf(w, coin);
    expect(v.defendCount).toBe(1n);
    const floorBefore = 4n * SOL - PREPARE_RENT;
    expect(v.floorSol).toBe(floorBefore - floorBefore / 10n);
    expect(v.holderTokens).toBeGreaterThan(0n);
    expect(w.chain.events.some((e) => e.name === "Defended")).toBe(true);

    // holders: same size, one fresh (0.1×), one 7 days old (1.0×), one empty wallet with a tiny lot
    const fresh = await holder(w, coin, 1_000_000_000n, 0, SOL);
    const aged = await holder(w, coin, 1_000_000_000n, 7 * 24 * HOUR, SOL);
    const tiny = await holder(w, coin, 1_000n, 0, 0n);

    w.advance(5);
    const freshBefore = w.lamports(fresh.wallet);
    const agedBefore = w.lamports(aged.wallet);
    const tokensBefore = v.holderTokens;
    const outcome = await runPayoutRound(payoutDeps(w), coin);
    expect(outcome.kind).toBe("paid");
    if (outcome.kind !== "paid") return;
    expect(outcome.failed).toBe(0);

    const freshGain = w.lamports(fresh.wallet) - freshBefore;
    const agedGain = w.lamports(aged.wallet) - agedBefore;
    // weight 1.0 vs ~0.1 → the aged holder earns ~10× the fresh one
    expect(agedGain).toBeGreaterThan(freshGain * 9n);
    expect(agedGain).toBeLessThanOrEqual(freshGain * 10n + 10n);
    expect(w.tokenBalance(aged.ata)).toBeGreaterThan(1_000_000_000n);
    expect(w.lamports(tiny.wallet)).toBe(0n); // below rent minimum → carried, not lost

    // published snapshot re-verifies and matches the root committed on-chain
    const stored = await getRound(w.db, coin.mint.toBase58(), outcome.roundId);
    expect(stored?.status).toBe("closed");
    const opened = w.chain.events.find((e) => e.name === "RoundOpened");
    expect(opened && opened.name === "RoundOpened" && toHex(opened.snapshotHash)).toBe(stored!.snapshotHash);
    expect(verifyRoundSnapshot(stored!.snapshot, stored!.snapshotHash)).toEqual({ ok: true, problems: [] });

    const carries = await loadCarries(w.db, coin.mint.toBase58());
    expect(carries.map((c) => c.wallet)).toContain(tiny.wallet.toBase58());
    v = await vaultOf(w, coin);
    expect(v.roundOpen).toBe(false);
    expect(v.holderSol + outcome.solPaid).toBe(2_500_000_000n);
    expect(v.holderTokens + outcome.tokensPaid).toBe(tokensBefore);
    // what is still in the bucket equals the carries plus rounding remainders
    const carriedSol = carries.reduce((s, c) => s + c.sol, 0n);
    expect(v.holderSol).toBeGreaterThanOrEqual(carriedSol);
    expect(v.holderSol - carriedSol).toBeLessThan(10n);
  }, 60_000);

  it("resumes a round interrupted after open_round without paying anyone twice", async () => {
    const w = await createWorld();
    const coin = await w.launch(2500);
    await registerCoin(w, coin);
    w.airdrop(coin.treasury, 10n * SOL);
    const holders = await Promise.all([0, 1, 2, 3, 4].map((i) => holder(w, coin, 1_000_000_000n, i * HOUR, SOL)));
    const before = holders.map((h) => w.lamports(h.wallet));

    // Run 1: payouts to two wallets fail, then the process "crashes" before close_round.
    const blocked = new Set([holders[0]!.wallet.toBase58(), holders[1]!.wallet.toBase58()]);
    w.chain.failWhen = (ixs) =>
      ixs.some((ix) => {
        if (!ix.programId.equals(HOLDFAST_PROGRAM_ID)) return false;
        const name = ixName(ix.data);
        if (name === "close_round") return true;
        return name === "payout" && ix.keys.slice(9).some((k) => blocked.has(k.pubkey.toBase58()));
      });
    await expect(runPayoutRound(payoutDeps(w), coin)).rejects.toThrow("injected failure");
    let v = await vaultOf(w, coin);
    expect(v.roundOpen).toBe(true);
    expect(w.lamports(holders[0]!.wallet)).toBe(before[0]);
    expect(w.lamports(holders[2]!.wallet)).toBeGreaterThan(before[2]!);

    // Run 2: resumes the open round, pays only the two missing wallets, closes.
    w.chain.failWhen = null;
    const outcome = await runPayoutRound(payoutDeps(w), coin);
    expect(outcome.kind).toBe("paid");
    v = await vaultOf(w, coin);
    expect(v.roundOpen).toBe(false);
    const payouts = await listPayouts(w.db, coin.mint.toBase58(), v.roundId);
    expect(payouts).toHaveLength(5);
    expect(payouts.every((p) => p.status === "confirmed")).toBe(true);
    for (const p of payouts) {
      const i = holders.findIndex((h) => h.wallet.toBase58() === p.wallet);
      expect(w.lamports(holders[i]!.wallet) - before[i]!).toBe(p.sol); // paid exactly once
    }
    expect(v.totalPaidSol).toBe(payouts.reduce((s, p) => s + p.sol, 0n));
  }, 60_000);

  it("lets a pot too small for its fees grow on-chain instead of paying it out", async () => {
    const w = await createWorld();
    const coin = await w.launch(2500);
    await registerCoin(w, coin);
    await Promise.all([0, 1, 2].map((i) => holder(w, coin, 1_000_000_000n, i * HOUR, SOL)));
    w.airdrop(coin.treasury, 2_000_000n); // 0.002 SOL of fees → 0.0005 SOL holder pot for 3 wallets
    const small = await runPayoutRound(payoutDeps(w), coin);
    expect(small.kind).toBe("skipped");
    expect(small.kind === "skipped" && small.reason).toMatch(/pot too small for its fees/);
    let v = await vaultOf(w, coin);
    expect(v.roundId).toBe(0n);
    expect(v.holderSol).toBe(500_000n); // booked, still in the bucket

    // more fees arrive: now the round is worth it and pays everything accumulated
    w.airdrop(coin.treasury, SOL);
    w.advance(120);
    const paid = await runPayoutRound(payoutDeps(w), coin);
    expect(paid.kind).toBe("paid");
    v = await vaultOf(w, coin);
    expect(v.totalPaidSol).toBeGreaterThan(250_000_000n);
  }, 60_000);

  it("does not open a round when the keeper could not afford to finish it", async () => {
    const w = await createWorld();
    const coin = await w.launch(2500);
    await registerCoin(w, coin);
    await holder(w, coin, 1_000_000_000n, 0, SOL);
    w.airdrop(coin.treasury, 10n * SOL);
    const outcome = await runPayoutRound({ ...payoutDeps(w), cfg: { ...payoutCfg, keeperMinBalanceLamports: 10n ** 15n } }, coin);
    expect(outcome).toEqual({ kind: "skipped", reason: "keeper balance too low" });
    expect((await vaultOf(w, coin)).roundOpen).toBe(false);
  }, 60_000);

  it("skips when nothing is payable and never opens an empty round", async () => {
    const w = await createWorld();
    const coin = await w.launch(2500);
    await registerCoin(w, coin);
    const outcome = await runPayoutRound(payoutDeps(w), coin);
    expect(outcome).toEqual({ kind: "skipped", reason: "nothing payable this round" });
    expect((await vaultOf(w, coin)).roundId).toBe(0n);
  });
});

