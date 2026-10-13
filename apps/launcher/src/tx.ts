/**
 * Pure transaction builders for the launch flow (no RPC: every chain-derived input is a parameter).
 *
 * A  create:  compute budget + pump.fun `create_v2(name, symbol, uri, creator = treasury PDA,
 *             is_mayhem_mode = false)`; fee payer and `user` = deposit; signers: deposit, mint.
 * B  init:    compute budget + System transfer deposit → launcher (rent reimbursement) + Holdfast
 *             `init_coin(trigger_bps)` (payer: launcher) + pump `init_user_volume_accumulator`
 *             (payer: launcher, user: treasury); fee payer = deposit; signers: deposit, launcher.
 *             The launcher's balance is unchanged by B: it is reimbursed in the same transaction.
 * C  devBuy:  compute budget + [deposit ATA create (idempotent), pump `buy_v3`] (SDK) + sender ATA
 *             create (idempotent, payer deposit) + `transfer_checked` of exactly the bought amount
 *             + close of the deposit ATA + (optional) pump `close_user_volume_accumulator`;
 *             fee payer and signer: deposit.
 * R  refund:  compute budget + System transfer deposit → sender; fee payer and signer: deposit.
 *
 * All four are legacy transactions well under the 1232-byte packet limit (see test/tx.test.ts), so
 * no lookup tables are needed.
 */
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, type Signer, type TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import bs58 from "bs58";
import { coinKeys, initCoinIx, pumpCreatorFor, TOKEN_2022_PROGRAM_ID } from "@holdfast/chain";
import { PUMP_TOKEN_DECIMALS } from "@holdfast/core";

import type { RecentBlockhash } from "./chain.js";
import type { PriorityConfig } from "@holdfast/chain";
import { PUMP_SDK, type BondingCurve } from "./pump.js";

export const PACKET_DATA_SIZE = 1232;

export function computeBudgetIxs(units: number, microLamports: bigint): TransactionInstruction[] {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (microLamports > 0n) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  return ixs;
}

function newTx(feePayer: PublicKey, recent: RecentBlockhash, ixs: TransactionInstruction[]): Transaction {
  return new Transaction({ feePayer, blockhash: recent.blockhash, lastValidBlockHeight: recent.lastValidBlockHeight }).add(...ixs);
}

export interface CreateTxParams {
  deposit: PublicKey;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  recent: RecentBlockhash;
  priority: PriorityConfig;
}

export async function buildCreateTx(p: CreateTxParams): Promise<Transaction> {
  const create = await PUMP_SDK.createV2Instruction({
    mint: p.mint,
    name: p.name,
    symbol: p.symbol,
    uri: p.uri,
    creator: pumpCreatorFor(p.mint),
    user: p.deposit,
    mayhemMode: false,
  });
  return newTx(p.deposit, p.recent, [...computeBudgetIxs(p.priority.units.create, p.priority.microLamports), create]);
}

export interface InitTxParams {
  deposit: PublicKey;
  launcher: PublicKey;
  mint: PublicKey;
  triggerBps: number;
  /** Rent the launcher pays inside `init_coin` + the accumulator (see cost.ts `initReimbursement`). */
  reimburseLamports: bigint;
  /** False when the treasury's pump volume accumulator already exists (the init would fail). */
  initTreasuryAccumulator: boolean;
  recent: RecentBlockhash;
  priority: PriorityConfig;
}

export async function buildInitTx(p: InitTxParams): Promise<Transaction> {
  const coin = coinKeys(p.mint, TOKEN_2022_PROGRAM_ID);
  const ixs = computeBudgetIxs(p.priority.units.init, p.priority.microLamports);
  if (p.reimburseLamports > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: p.deposit, toPubkey: p.launcher, lamports: p.reimburseLamports }));
  ixs.push(initCoinIx(coin, p.launcher, p.triggerBps));
  if (p.initTreasuryAccumulator) ixs.push(await PUMP_SDK.initUserVolumeAccumulator({ payer: p.launcher, user: coin.treasury }));
  return newTx(p.deposit, p.recent, ixs);
}

export interface DevBuyTxParams {
  deposit: PublicKey;
  sender: PublicKey;
  mint: PublicKey;
  /** Exact tokens bought; all of them are transferred to the sender. */
  tokens: bigint;
  maxSolCost: bigint;
  bondingCurve: BondingCurve;
  buybackFeeRecipient: PublicKey;
  closeAccumulator: boolean;
  recent: RecentBlockhash;
  priority: PriorityConfig;
}

export function tokenAccountOf(owner: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
}

export async function buildDevBuyTx(p: DevBuyTxParams): Promise<Transaction> {
  const depositAta = tokenAccountOf(p.deposit, p.mint);
  const senderAta = tokenAccountOf(p.sender, p.mint);
  const buy = await PUMP_SDK.buyV3Instructions({
    bondingCurve: p.bondingCurve,
    associatedUserAccountInfo: null,
    mint: p.mint,
    user: p.deposit,
    amount: new BN(p.tokens.toString()),
    quoteAmount: new BN(p.maxSolCost.toString()),
    slippage: 0,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    buybackFeeRecipient: p.buybackFeeRecipient,
  });
  const ixs = [
    ...computeBudgetIxs(p.priority.units.devBuy, p.priority.microLamports),
    ...buy,
    createAssociatedTokenAccountIdempotentInstruction(p.deposit, senderAta, p.sender, p.mint, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(depositAta, p.mint, senderAta, p.deposit, p.tokens, PUMP_TOKEN_DECIMALS, [], TOKEN_2022_PROGRAM_ID),
    createCloseAccountInstruction(depositAta, p.deposit, p.deposit, [], TOKEN_2022_PROGRAM_ID),
  ];
  if (p.closeAccumulator) ixs.push(await PUMP_SDK.closeUserVolumeAccumulator(p.deposit));
  return newTx(p.deposit, p.recent, ixs);
}

export interface RefundTxParams {
  deposit: PublicKey;
  sender: PublicKey;
  lamports: bigint;
  recent: RecentBlockhash;
  priority: PriorityConfig;
}

export function buildRefundTx(p: RefundTxParams): Transaction {
  return newTx(p.deposit, p.recent, [
    ...computeBudgetIxs(p.priority.units.refund, p.priority.microLamports),
    SystemProgram.transfer({ fromPubkey: p.deposit, toPubkey: p.sender, lamports: p.lamports }),
  ]);
}

/** Sign in place and return the (deterministic) transaction signature. */
export function signTransaction(tx: Transaction, signers: Signer[]): string {
  tx.sign(...signers);
  if (!tx.signature) throw new Error("transaction has no fee payer signature");
  return bs58.encode(tx.signature);
}

/** Wire size (signature slots included, signed or not). */
export function serializedSize(tx: Transaction): number {
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
}
