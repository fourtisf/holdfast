/**
 * End-to-end harness: the real compiled vault program + pump.fun stand-ins in LiteSVM, a PGlite
 * database, and the keeper/payout code talking to them through the `KeeperChain` interface.
 * Requires `anchor build -p holdfast_vault` and the mocks in target/deploy (see tests/program).
 */
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import BN from "bn.js";
import { BorshCoder } from "@coral-xyz/anchor";
import { AccountLayout, MintLayout, ACCOUNT_SIZE, MINT_SIZE } from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  Transaction,
  type AccountInfo,
  type AccountMeta,
  type Signer,
  type TransactionInstruction,
} from "@solana/web3.js";
import { Clock, LiteSVM, FailedTransactionMetadata } from "litesvm";
import { address, getTransactionDecoder, lamports as toLamports, type Address } from "@solana/kit";
import {
  HOLDFAST_IDL,
  HOLDFAST_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  associatedTokenAddress,
  bondingCurvePda,
  coinKeys,
  configPda,
  creatorVaultPda,
  initCoinIx,
  parseHoldfastEvents,
  type CoinKeys,
  type HoldfastEvent,
} from "@holdfast/chain";
import { createPgliteDb, migrate, type Db } from "@holdfast/db";

import { computeBudget, transactionFits, type KeeperChain } from "../src/chain.js";
import type { PumpGateway } from "../src/pump.js";

export const SOL = 1_000_000_000n;
export const START_TS = 1_760_000_000n;
const DEPLOY = fileURLToPath(new URL("../../../target/deploy/", import.meta.url));
const addr = (k: PublicKey): Address => address(k.toBase58());
const txDecoder = getTransactionDecoder();

export const programsBuilt = ["holdfast_vault.so", "mock_pump.so", "mock_pump_amm.so"].every((f) => existsSync(DEPLOY + f));

export class LiteSvmChain implements KeeperChain {
  readonly events: HoldfastEvent[] = [];
  /** Test hook: throw instead of sending when this returns true. */
  failWhen: ((ixs: TransactionInstruction[]) => boolean) | null = null;

  constructor(readonly svm: LiteSVM) {}

  async getAccounts(keys: readonly PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    return keys.map((k) => {
      const a = this.svm.getAccount(addr(k));
      if (!a.exists || a.lamports === 0n) return null;
      return { data: Buffer.from(a.data), executable: a.executable, lamports: Number(a.lamports), owner: new PublicKey(a.programAddress), rentEpoch: 0 };
    });
  }

  async send(instructions: TransactionInstruction[], signers: Signer[], opts: { computeUnits?: number } = {}): Promise<string> {
    if (this.failWhen?.(instructions)) throw new Error("injected failure");
    const tx = new Transaction({ feePayer: signers[0]!.publicKey, recentBlockhash: this.svm.latestBlockhash() });
    tx.add(...computeBudget(Math.max(opts.computeUnits ?? 400_000, 1_000_000), 0), ...instructions);
    tx.sign(...signers);
    const res = this.svm.sendTransaction(txDecoder.decode(tx.serialize()) as Parameters<LiteSVM["sendTransaction"]>[0]);
    this.svm.expireBlockhash();
    if (res instanceof FailedTransactionMetadata) {
      throw new Error(`tx failed: ${res.err().toString()}\n${res.meta().logs().join("\n")}`);
    }
    this.events.push(...parseHoldfastEvents(res.logs()));
    return Buffer.from(res.signature()).toString("hex");
  }

  fits(instructions: TransactionInstruction[], feePayer: PublicKey, signerCount: number): boolean {
    return transactionFits(instructions, feePayer, signerCount);
  }

  nowMs(): number {
    return Number(this.svm.getClock().unixTimestamp) * 1000;
  }
}

export interface World {
  svm: LiteSVM;
  chain: LiteSvmChain;
  db: Db;
  keeper: Keypair;
  launcher: Keypair;
  pumpGlobal: PublicKey;
  feeRecipient: PublicKey;
  pump: PumpGateway;
  setTime(unixSec: bigint): void;
  advance(secs: number): void;
  now(): bigint;
  launch(triggerBps?: number): Promise<CoinKeys>;
  setCurveReserves(mint: PublicKey, vtok: bigint, vsol: bigint): void;
  curveReserves(mint: PublicKey): { vtok: bigint; vsol: bigint };
  setTokenAccount(address: PublicKey, mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey, amount: bigint): void;
  tokenBalance(address: PublicKey): bigint;
  lamports(address: PublicKey): bigint;
  airdrop(address: PublicKey, lamports: bigint): void;
}

const coder = new BorshCoder(HOLDFAST_IDL);

function setRaw(svm: LiteSVM, key: PublicKey, owner: PublicKey, data: Buffer, lamports?: bigint) {
  svm.setAccount({
    address: addr(key),
    lamports: toLamports(lamports ?? svm.minimumBalanceForRentExemption(BigInt(data.length))),
    data: Uint8Array.from(data),
    programAddress: addr(owner),
    executable: false,
    space: BigInt(data.length),
  });
}

export async function createWorld(params: Partial<Record<string, number>> = {}): Promise<World> {
  const svm = new LiteSVM();
  svm.addProgramFromFile(addr(HOLDFAST_PROGRAM_ID), DEPLOY + "holdfast_vault.so");
  svm.addProgramFromFile(addr(PUMP_PROGRAM_ID), DEPLOY + "mock_pump.so");
  svm.addProgramFromFile(addr(PUMP_AMM_PROGRAM_ID), DEPLOY + "mock_pump_amm.so");
  const chain = new LiteSvmChain(svm);
  const keeper = Keypair.generate();
  const launcher = Keypair.generate();
  const airdrop = (key: PublicKey, amount: bigint) => {
    svm.airdrop(addr(key), toLamports(amount));
  };
  for (const kp of [keeper, launcher]) airdrop(kp.publicKey, 1_000n * SOL);

  const setTime = (unixSec: bigint) => {
    const c = svm.getClock();
    svm.setClock(new Clock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, unixSec));
    svm.expireBlockhash();
  };
  setTime(START_TS);

  // Config account written directly (initialize's upgrade-authority path is covered by the Rust suite).
  const configParams = {
    defend_cooldown_secs: 60,
    max_defends_per_hour: 6,
    defend_price_tolerance_bps: 300,
    twap_window_secs: 600,
    twap_min_sample_interval_secs: 30,
    twap_max_gap_secs: 120,
    ath_confirm_secs: 0,
    max_burn_slippage_bps: 500,
    min_round_interval_secs: 60,
    ...params,
  };
  const configData = await coder.accounts.encode("Config", {
    admin: keeper.publicKey,
    pending_admin: PublicKey.default,
    keeper: keeper.publicKey,
    launcher: launcher.publicKey,
    hold_mint: PublicKey.default,
    params: configParams,
    paused: false,
    bump: PublicKey.findProgramAddressSync([Buffer.from("config")], HOLDFAST_PROGRAM_ID)[1],
    reserved: Array(64).fill(0),
  });
  setRaw(svm, configPda(), HOLDFAST_PROGRAM_ID, configData);

  // WSOL mint, mock pump "global" (misbehaviour byte = 0), funded fee recipient
  const mint = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals: 9, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mint);
  setRaw(svm, WSOL_MINT, TOKEN_PROGRAM_ID, mint);
  const pumpGlobal = Keypair.generate().publicKey;
  setRaw(svm, pumpGlobal, PUMP_PROGRAM_ID, Buffer.alloc(8));
  const feeRecipient = Keypair.generate().publicKey;
  airdrop(feeRecipient, SOL);

  const db = await createPgliteDb();
  await migrate(db);

  const world: World = {
    svm,
    chain,
    db,
    keeper,
    launcher,
    pumpGlobal,
    feeRecipient,
    pump: null as unknown as PumpGateway,
    setTime,
    advance: (secs) => setTime(svm.getClock().unixTimestamp + BigInt(secs)),
    now: () => svm.getClock().unixTimestamp,
    async launch(triggerBps = 2_500) {
      const mintKp = Keypair.generate();
      const m = Buffer.alloc(MINT_SIZE);
      MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1_000_000_000_000_000n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, m);
      setRaw(svm, mintKp.publicKey, TOKEN_2022_PROGRAM_ID, m);
      const coin = coinKeys(mintKp.publicKey, TOKEN_2022_PROGRAM_ID);
      const curve = Buffer.alloc(166);
      Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(curve, 0);
      curve.writeBigUInt64LE(1_073_000_000_000_000n, 8);
      curve.writeBigUInt64LE(30n * SOL, 16);
      curve.writeBigUInt64LE(793_100_000_000_000n, 24);
      curve.writeBigUInt64LE(1_000_000_000_000_000n, 40);
      coin.treasury.toBuffer().copy(curve, 49);
      setRaw(svm, coin.bondingCurve, PUMP_PROGRAM_ID, curve);
      world.setTokenAccount(associatedTokenAddress(coin.bondingCurve, coin.mint, TOKEN_2022_PROGRAM_ID), coin.mint, coin.bondingCurve, TOKEN_2022_PROGRAM_ID, 793_100_000_000_000n);
      airdrop(creatorVaultPda(coin.treasury), SOL);
      await chain.send([initCoinIx(coin, launcher.publicKey, triggerBps)], [launcher]);
      return coin;
    },
    setCurveReserves(m, vtok, vsol) {
      const key = bondingCurvePda(m);
      const acc = svm.getAccount(addr(key));
      if (!acc.exists) throw new Error("curve missing");
      const data = Buffer.from(acc.data);
      data.writeBigUInt64LE(vtok, 8);
      data.writeBigUInt64LE(vsol, 16);
      setRaw(svm, key, PUMP_PROGRAM_ID, data, acc.lamports);
    },
    curveReserves(m) {
      const acc = svm.getAccount(addr(bondingCurvePda(m)));
      if (!acc.exists) throw new Error("curve missing");
      const data = Buffer.from(acc.data);
      return { vtok: data.readBigUInt64LE(8), vsol: data.readBigUInt64LE(16) };
    },
    setTokenAccount(key, m, owner, tokenProgram, amount) {
      const data = Buffer.alloc(ACCOUNT_SIZE);
      const native = m.equals(WSOL_MINT);
      const rent = svm.minimumBalanceForRentExemption(BigInt(ACCOUNT_SIZE));
      AccountLayout.encode(
        {
          mint: m,
          owner,
          amount,
          delegateOption: 0,
          delegate: PublicKey.default,
          state: 1,
          isNativeOption: native ? 1 : 0,
          isNative: native ? rent : 0n,
          delegatedAmount: 0n,
          closeAuthorityOption: 0,
          closeAuthority: PublicKey.default,
        },
        data,
      );
      setRaw(svm, key, tokenProgram, data, native ? rent + amount : rent);
    },
    tokenBalance(key) {
      const a = svm.getAccount(addr(key));
      return a.exists ? Buffer.from(a.data).readBigUInt64LE(64) : 0n;
    },
    lamports: (key) => svm.getBalance(addr(key)) ?? 0n,
    airdrop,
  };
  world.pump = new MockPumpGateway(world);
  return world;
}

/** Account lists for the pump.fun stand-ins (same order as the real IDL). Fee claims are simulated by airdrops. */
class MockPumpGateway implements PumpGateway {
  constructor(private readonly w: World) {}

  async curveBuyAccounts(mint: PublicKey, user: PublicKey, tokenProgram: PublicKey, creator: PublicKey): Promise<AccountMeta[]> {
    const curve = bondingCurvePda(mint);
    const pda = (seeds: Buffer[], program = PUMP_PROGRAM_ID) => PublicKey.findProgramAddressSync(seeds, program)[0];
    const m = (pubkey: PublicKey, isWritable = false): AccountMeta => ({ pubkey, isWritable, isSigner: false });
    return [
      m(this.w.pumpGlobal),
      m(this.w.feeRecipient, true),
      m(mint),
      m(curve, true),
      m(associatedTokenAddress(curve, mint, tokenProgram), true),
      m(associatedTokenAddress(user, mint, tokenProgram), true),
      m(user, true),
      m(new PublicKey("11111111111111111111111111111111")),
      m(tokenProgram),
      m(creatorVaultPda(creator), true),
      m(pda([Buffer.from("__event_authority")])),
      m(PUMP_PROGRAM_ID),
      m(pda([Buffer.from("global_volume_accumulator")])),
      m(pda([Buffer.from("user_volume_accumulator"), user.toBuffer()]), true),
      m(Keypair.generate().publicKey),
      m(Keypair.generate().publicKey),
      m(pda([Buffer.from("bonding-curve-v2"), mint.toBuffer()])),
      m(this.w.feeRecipient, true),
    ];
  }

  async ammBuyAccounts(): Promise<AccountMeta[]> {
    throw new Error("not used in these tests");
  }

  async feeClaimInstructions(): Promise<TransactionInstruction[]> {
    return [];
  }

  async initAccumulatorInstruction(): Promise<TransactionInstruction> {
    throw new Error("not used in these tests");
  }
}

export { BN };
