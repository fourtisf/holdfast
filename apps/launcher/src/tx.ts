/**
 * Pure transaction builders for the launch flow (no RPC: every chain-derived input is a parameter).
 *
 * A  create:  compute budget + pump.fun `create_v2(name, symbol, uri, creator = treasury PDA,
 *             is_mayhem_mode = false)`; fee payer and `user` = deposit; signers: deposit, mint.
 * B  init:    compute budget + System transfer deposit → launcher (rent reimbursement) + Holdfast
 *             `init_coin(trigger_bps)` (payer: launcher); fee payer = deposit; signers: deposit,
 *             launcher. The launcher's balance is unchanged by B: it is reimbursed in the same
 *             transaction. (The treasury's token accounts and pump volume accumulator are created
 *             later by the vault's `prepare_treasury`, paid from the coin's own fees.)
 * C  devBuy:  compute budget + [deposit ATA create (idempotent), pump `buy_v3`] (SDK) + sender ATA
 *             create (idempotent, payer deposit) + `transfer_checked` of exactly the bought amount
 *             + close of the deposit ATA + (optional) pump `close_user_volume_accumulator`;
 *             fee payer and signer: deposit.
 * R  refund:  compute budget + System transfer deposit → sender; fee payer and signer: deposit.
 *
 * All four are legacy transactions well under the 1232-byte packet limit (see test/tx.test.ts).
 *
 * L  atomic:  one v0 transaction (with the launcher's address lookup table): compute budget +
 *             reimbursement + `create_v2` + `init_coin` + (the buy of C | the exact leftover to the
 *             sender). Fee payer: deposit; signers: deposit, mint, launcher. Nobody can trade between
 *             the creation and the dev buy, and a failure changes nothing. Without a dev buy the
 *             deposit ends at exactly 0 lamports; with one, D follows.
 * D  deliver: compute budget + C's delivery (sender ATA, transfer of the bought tokens, closes);
 *             fee payer and signer: deposit. The refund follows as usual.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Signer,
  type TransactionInstruction,
} from "@solana/web3.js";
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
import { atomicComputeUnits, type PriorityConfig } from "@holdfast/chain";
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
  /** Recorded in the vault: claims the creator share. */
  creator: PublicKey;
  /** Rent the launcher pays inside `init_coin` (see cost.ts `initReimbursement`). */
  reimburseLamports: bigint;
  recent: RecentBlockhash;
  priority: PriorityConfig;
}

export function buildInitTx(p: InitTxParams): Transaction {
  const coin = coinKeys(p.mint, TOKEN_2022_PROGRAM_ID);
  const ixs = computeBudgetIxs(p.priority.units.init, p.priority.microLamports);
  if (p.reimburseLamports > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: p.deposit, toPubkey: p.launcher, lamports: p.reimburseLamports }));
  ixs.push(initCoinIx(coin, p.launcher, p.triggerBps, p.creator));
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

/** The buy of tx C: the deposit's token account (idempotent) + pump `buy_v3` of exactly `tokens`. */
export async function devBuyBuyInstructions(p: Pick<DevBuyTxParams, "deposit" | "mint" | "tokens" | "maxSolCost" | "bondingCurve" | "buybackFeeRecipient">): Promise<TransactionInstruction[]> {
  return PUMP_SDK.buyV3Instructions({
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
}

/** The delivery of tx C: sender token account (idempotent) + transfer of exactly `tokens` + closes. */
export async function devBuyDeliverInstructions(
  p: Pick<DevBuyTxParams, "deposit" | "sender" | "mint" | "tokens" | "closeAccumulator">,
): Promise<TransactionInstruction[]> {
  const depositAta = tokenAccountOf(p.deposit, p.mint);
  const senderAta = tokenAccountOf(p.sender, p.mint);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(p.deposit, senderAta, p.sender, p.mint, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(depositAta, p.mint, senderAta, p.deposit, p.tokens, PUMP_TOKEN_DECIMALS, [], TOKEN_2022_PROGRAM_ID),
    createCloseAccountInstruction(depositAta, p.deposit, p.deposit, [], TOKEN_2022_PROGRAM_ID),
  ];
  if (p.closeAccumulator) ixs.push(await PUMP_SDK.closeUserVolumeAccumulator(p.deposit));
  return ixs;
}

/** C's instructions without the compute budget: buy, then deliver. */
export async function devBuyInstructions(p: Omit<DevBuyTxParams, "recent" | "priority">): Promise<TransactionInstruction[]> {
  return [...(await devBuyBuyInstructions(p)), ...(await devBuyDeliverInstructions(p))];
}

export async function buildDevBuyTx(p: DevBuyTxParams): Promise<Transaction> {
  return newTx(p.deposit, p.recent, [...computeBudgetIxs(p.priority.units.devBuy, p.priority.microLamports), ...(await devBuyInstructions(p))]);
}

export interface DeliverTxParams extends Pick<DevBuyTxParams, "deposit" | "sender" | "mint" | "tokens" | "closeAccumulator"> {
  leftover: { to: PublicKey; lamports: bigint } | null;
  recent: RecentBlockhash;
  priority: PriorityConfig;
}

/** D: deliver the dev-buy tokens bought in the atomic launch tx, and send the leftover on. */
export async function buildDeliverTx(p: DeliverTxParams): Promise<Transaction> {
  const ixs = [...computeBudgetIxs(p.priority.units.devBuy, p.priority.microLamports), ...(await devBuyDeliverInstructions(p))];
  if (p.leftover && p.leftover.lamports > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: p.deposit, toPubkey: p.leftover.to, lamports: p.leftover.lamports }));
  return newTx(p.deposit, p.recent, ixs);
}

export interface AtomicLaunchParams {
  deposit: PublicKey;
  launcher: PublicKey;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  triggerBps: number;
  /** Recorded in the vault: claims the creator share. */
  creator: PublicKey;
  /** Rent the launcher fronts inside `init_coin` (see cost.ts `initReimbursement`). */
  reimburseLamports: bigint;
  /**
   * The buy of tx C, against the curve created in this same transaction (so nobody can buy first).
   * The tokens stay on the deposit's token account; a small follow-up transaction delivers them
   * (`devBuyDeliverInstructions`), because the delivery does not fit in the same packet.
   */
  devBuy: Pick<DevBuyTxParams, "tokens" | "maxSolCost" | "bondingCurve" | "buybackFeeRecipient"> | null;
  /** Everything left on the deposit after the launch, when there is no dev buy (the deposit ends at 0). */
  leftover: { to: PublicKey; lamports: bigint } | null;
  recent: RecentBlockhash;
  priority: PriorityConfig;
}

export async function atomicLaunchInstructions(p: Omit<AtomicLaunchParams, "recent">): Promise<TransactionInstruction[]> {
  const coin = coinKeys(p.mint, TOKEN_2022_PROGRAM_ID);
  const ixs = computeBudgetIxs(atomicComputeUnits(p.priority.units, p.devBuy !== null), p.priority.microLamports);
  if (p.reimburseLamports > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: p.deposit, toPubkey: p.launcher, lamports: p.reimburseLamports }));
  ixs.push(
    await PUMP_SDK.createV2Instruction({
      mint: p.mint,
      name: p.name,
      symbol: p.symbol,
      uri: p.uri,
      creator: pumpCreatorFor(p.mint),
      user: p.deposit,
      mayhemMode: false,
    }),
    initCoinIx(coin, p.launcher, p.triggerBps, p.creator),
  );
  if (p.devBuy) ixs.push(...(await devBuyBuyInstructions({ ...p.devBuy, deposit: p.deposit, mint: p.mint })));
  if (p.devBuy && p.leftover) throw new Error("an atomic launch with a dev buy keeps its leftover for the delivery transaction");
  if (p.leftover && p.leftover.lamports > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: p.deposit, toPubkey: p.leftover.to, lamports: p.leftover.lamports }));
  return ixs;
}

export async function buildAtomicLaunchTx(p: AtomicLaunchParams, lookupTable: AddressLookupTableAccount): Promise<VersionedTransaction> {
  const message = new TransactionMessage({
    payerKey: p.deposit,
    recentBlockhash: p.recent.blockhash,
    instructions: await atomicLaunchInstructions(p),
  }).compileToV0Message([lookupTable]);
  return new VersionedTransaction(message);
}

/** Sign a v0 transaction in place and return its signature (the fee payer's). */
export function signVersioned(tx: VersionedTransaction, signers: Signer[]): string {
  tx.sign(signers);
  const sig = tx.signatures[0];
  if (!sig || sig.every((b) => b === 0)) throw new Error("transaction has no fee payer signature");
  return bs58.encode(sig);
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
