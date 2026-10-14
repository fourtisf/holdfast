import { Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, decodeCloseAccountInstruction, decodeTransferCheckedInstruction } from "@solana/spl-token";
import BN from "bn.js";
import { describe, expect, it } from "vitest";
import {
  coinKeys,
  configPda,
  HOLDFAST_IDL,
  HOLDFAST_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  treasuryPda,
  WSOL_MINT,
} from "@holdfast/chain";

import { DEFAULT_PRIORITY, type PriorityConfig } from "@holdfast/chain";
import { pump } from "../src/pump.js";
import { PUMP_MAX_NAME_BYTES, PUMP_MAX_SYMBOL_BYTES, PUMP_MAX_URI_BYTES } from "@holdfast/chain";
import {
  buildCreateTx,
  buildDevBuyTx,
  buildInitTx,
  buildRefundTx,
  PACKET_DATA_SIZE,
  serializedSize,
  signTransaction,
  tokenAccountOf,
} from "../src/tx.js";
import { fakeGlobal, holdfastCoder, pumpCoder } from "./fakeChain.js";

const recent = { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 };
const priority: PriorityConfig = DEFAULT_PRIORITY;
const deposit = Keypair.generate();
const launcher = Keypair.generate();
const creator = Keypair.generate();
const mint = Keypair.generate();
const sender = Keypair.generate().publicKey;
const worst = { name: "N".repeat(PUMP_MAX_NAME_BYTES), symbol: "S".repeat(PUMP_MAX_SYMBOL_BYTES), uri: `https://x.example/${"u".repeat(PUMP_MAX_URI_BYTES - 18)}` };

function programIx(tx: Transaction, program: PublicKey, name?: string): TransactionInstruction {
  const found = tx.instructions.filter((i) => i.programId.equals(program));
  const coder = program.equals(PUMP_PROGRAM_ID) ? pumpCoder : holdfastCoder;
  const ix = name ? found.find((i) => coder.instruction.decode(Buffer.from(i.data))?.name === name) : found[0];
  if (!ix) throw new Error(`no ${name ?? program.toBase58()} instruction`);
  return ix;
}

function requiredSigners(tx: Transaction): string[] {
  const msg = tx.compileMessage();
  return msg.accountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58());
}

function idlAccounts(idl: { instructions: { name: string; accounts: { name: string; writable?: boolean; signer?: boolean }[] }[] }, name: string) {
  return idl.instructions.find((i) => i.name === name)!.accounts;
}

const pumpIdl = pump.pumpIdl as unknown as Parameters<typeof idlAccounts>[0];

describe("tx A: create_v2", () => {
  it("creates the coin with creator = treasury PDA, deposit as user/payer, mint as signer", async () => {
    const tx = await buildCreateTx({ deposit: deposit.publicKey, mint: mint.publicKey, name: "Holdfast", symbol: "HOLD", uri: "https://m.example/a.json", recent, priority });
    const ix = programIx(tx, PUMP_PROGRAM_ID, "create_v2");
    const decoded = pumpCoder.instruction.decode(Buffer.from(ix.data))!;
    const args = decoded.data as { name: string; symbol: string; uri: string; creator: PublicKey; is_mayhem_mode: boolean };
    expect(decoded.name).toBe("create_v2");
    expect(args.creator.equals(treasuryPda(mint.publicKey))).toBe(true);
    expect(args.creator.equals(coinKeys(mint.publicKey).treasury)).toBe(true);
    expect([args.name, args.symbol, args.uri, args.is_mayhem_mode]).toEqual(["Holdfast", "HOLD", "https://m.example/a.json", false]);

    const accounts = idlAccounts(pumpIdl, "create_v2");
    expect(ix.keys).toHaveLength(accounts.length); // SOL quote: no quote remaining accounts
    const byName = Object.fromEntries(accounts.map((a, i) => [a.name, ix.keys[i]!]));
    expect(byName.mint!.pubkey.equals(mint.publicKey)).toBe(true);
    expect([byName.mint!.isSigner, byName.mint!.isWritable]).toEqual([true, true]);
    expect(byName.user!.pubkey.equals(deposit.publicKey)).toBe(true);
    expect([byName.user!.isSigner, byName.user!.isWritable]).toEqual([true, true]);
    expect(byName.bonding_curve!.pubkey.equals(coinKeys(mint.publicKey).bondingCurve)).toBe(true);
    expect(byName.token_program!.pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()).sort()).toEqual([deposit.publicKey.toBase58(), mint.publicKey.toBase58()].sort());

    expect(tx.feePayer!.equals(deposit.publicKey)).toBe(true);
    expect(requiredSigners(tx)).toEqual([deposit.publicKey.toBase58(), mint.publicKey.toBase58()]);
    expect(tx.instructions[0]!.programId.toBase58()).toBe("ComputeBudget111111111111111111111111111111");
  });
});

describe("tx B: init_coin", () => {
  it("reimburses the launcher and registers the vault with the trigger", async () => {
    const tx = buildInitTx({
      deposit: deposit.publicKey,
      launcher: launcher.publicKey,
      mint: mint.publicKey,
      triggerBps: 3500,
      creator: creator.publicKey,
      reimburseLamports: 16_328_160n,
      recent,
      priority,
    });
    const keys = coinKeys(mint.publicKey, TOKEN_2022_PROGRAM_ID);

    const transfer = tx.instructions.find((i) => i.programId.equals(SystemProgram.programId))!;
    const t = SystemInstruction.decodeTransfer(transfer);
    expect([t.fromPubkey.toBase58(), t.toPubkey.toBase58(), t.lamports]).toEqual([deposit.publicKey.toBase58(), launcher.publicKey.toBase58(), 16_328_160n]);
    // The reimbursement comes first, so the launcher needs no float of its own.
    expect(tx.instructions.indexOf(transfer)).toBeLessThan(tx.instructions.indexOf(programIx(tx, HOLDFAST_PROGRAM_ID)));

    const init = programIx(tx, HOLDFAST_PROGRAM_ID);
    const decoded = holdfastCoder.instruction.decode(Buffer.from(init.data))!;
    expect(decoded).toEqual({ name: "init_coin", data: { trigger_bps: 3500, creator: creator.publicKey } });
    const expected: Record<string, PublicKey> = {
      launcher: launcher.publicKey,
      config: configPda(),
      mint: mint.publicKey,
      vault: keys.vault,
      treasury: keys.treasury,
      bonding_curve: keys.bondingCurve,
      token_program: TOKEN_2022_PROGRAM_ID,
      system_program: SystemProgram.programId,
    };
    const accounts = idlAccounts(HOLDFAST_IDL as unknown as Parameters<typeof idlAccounts>[0], "init_coin");
    expect(init.keys).toHaveLength(accounts.length);
    accounts.forEach((a, i) => {
      const meta = init.keys[i]!;
      expect(meta.pubkey.toBase58(), a.name).toBe(expected[a.name]!.toBase58());
      expect(meta.isSigner, a.name).toBe(Boolean(a.signer));
      expect(meta.isWritable, a.name).toBe(Boolean(a.writable));
    });
    expect(init.keys[0]).toMatchObject({ isSigner: true, isWritable: true }); // launcher pays
    // no treasury token accounts or accumulator at launch: prepare_treasury creates them from fees
    expect(tx.instructions.some((i) => i.programId.equals(PUMP_PROGRAM_ID))).toBe(false);

    expect(tx.feePayer!.equals(deposit.publicKey)).toBe(true);
    expect(requiredSigners(tx)).toEqual([deposit.publicKey.toBase58(), launcher.publicKey.toBase58()]);
  });

  it("leaves out the transfer when nothing is owed", async () => {
    const tx = buildInitTx({
      deposit: deposit.publicKey,
      launcher: launcher.publicKey,
      mint: mint.publicKey,
      triggerBps: 1500,
      creator: creator.publicKey,
      reimburseLamports: 0n,
      recent,
      priority,
    });
    expect(tx.instructions.some((i) => i.programId.equals(SystemProgram.programId))).toBe(false);
    expect(tx.instructions.some((i) => i.programId.equals(PUMP_PROGRAM_ID))).toBe(false);
    expect(holdfastCoder.instruction.decode(Buffer.from(programIx(tx, HOLDFAST_PROGRAM_ID).data))!.data).toEqual({ trigger_bps: 1500, creator: creator.publicKey });
  });
});

describe("tx C: dev buy", () => {
  it("buys exactly `tokens`, transfers all of them to the sender, closes the deposit token account and accumulator", async () => {
    const global = fakeGlobal();
    const curve = { ...pump.newBondingCurve(global), creator: treasuryPda(mint.publicKey) };
    const buyback = global.buybackFeeRecipients[2]!;
    const tx = await buildDevBuyTx({
      deposit: deposit.publicKey,
      sender,
      mint: mint.publicKey,
      tokens: 17_000_000_000_000n,
      maxSolCost: 525_000_000n,
      bondingCurve: curve,
      buybackFeeRecipient: buyback,
      closeAccumulator: true,
      recent,
      priority,
    });
    const depositAta = tokenAccountOf(deposit.publicKey, mint.publicKey);
    const senderAta = tokenAccountOf(sender, mint.publicKey);

    const buy = programIx(tx, PUMP_PROGRAM_ID, "buy_v3");
    const decoded = pumpCoder.instruction.decode(Buffer.from(buy.data))!;
    const args = decoded.data as { amount: BN; max_sol_cost: BN };
    expect([args.amount.toString(), args.max_sol_cost.toString()]).toEqual(["17000000000000", "525000000"]);
    const acc = Object.fromEntries(idlAccounts(pumpIdl, "buy_v3").map((a, i) => [a.name, buy.keys[i]!]));
    expect(acc.user).toMatchObject({ pubkey: deposit.publicKey, isSigner: true, isWritable: true });
    expect(acc.base_mint!.pubkey.equals(mint.publicKey)).toBe(true);
    expect(acc.associated_base_user!.pubkey.equals(depositAta)).toBe(true);
    expect(acc.buyback_fee_recipient!.pubkey.equals(buyback)).toBe(true);
    expect(acc.base_token_program!.pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);

    const atas = tx.instructions.filter((i) => i.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
    expect(atas.map((i) => [i.keys[0]!.pubkey.toBase58(), i.keys[1]!.pubkey.toBase58(), i.keys[2]!.pubkey.toBase58(), i.data[0]])).toEqual([
      [deposit.publicKey.toBase58(), depositAta.toBase58(), deposit.publicKey.toBase58(), 1],
      [deposit.publicKey.toBase58(), senderAta.toBase58(), sender.toBase58(), 1], // idempotent, payer deposit
    ]);
    expect(tx.instructions.indexOf(atas[0]!)).toBeLessThan(tx.instructions.indexOf(buy));

    const token = tx.instructions.filter((i) => i.programId.equals(TOKEN_2022_PROGRAM_ID));
    const transfer = decodeTransferCheckedInstruction(token[0]!, TOKEN_2022_PROGRAM_ID);
    expect(transfer.data.amount).toBe(17_000_000_000_000n);
    expect(transfer.data.decimals).toBe(6);
    expect(transfer.keys.source.pubkey.equals(depositAta)).toBe(true);
    expect(transfer.keys.destination.pubkey.equals(senderAta)).toBe(true);
    expect(transfer.keys.owner.pubkey.equals(deposit.publicKey)).toBe(true);
    const close = decodeCloseAccountInstruction(token[1]!, TOKEN_2022_PROGRAM_ID);
    expect(close.keys.account.pubkey.equals(depositAta)).toBe(true);
    expect(close.keys.destination.pubkey.equals(deposit.publicKey)).toBe(true);

    const closeUva = programIx(tx, PUMP_PROGRAM_ID, "close_user_volume_accumulator");
    expect(closeUva.keys[0]).toMatchObject({ pubkey: deposit.publicKey, isSigner: true });
    expect(closeUva.keys[1]!.pubkey.equals(pump.userVolumeAccumulatorPda(deposit.publicKey))).toBe(true);
    expect(tx.instructions.at(-1)).toBe(closeUva);

    expect(requiredSigners(tx)).toEqual([deposit.publicKey.toBase58()]);
  });
});

describe("refund", () => {
  it("sends the amount from the deposit (fee payer) to the sender", () => {
    const tx = buildRefundTx({ deposit: deposit.publicKey, sender, lamports: 123_456n, recent, priority });
    const t = SystemInstruction.decodeTransfer(tx.instructions.find((i) => i.programId.equals(SystemProgram.programId))!);
    expect([t.fromPubkey.toBase58(), t.toPubkey.toBase58(), t.lamports]).toEqual([deposit.publicKey.toBase58(), sender.toBase58(), 123_456n]);
    expect(requiredSigners(tx)).toEqual([deposit.publicKey.toBase58()]);
  });
});

describe("transaction sizes", () => {
  it("every transaction is a legacy transaction under 1232 bytes, with worst-case metadata", async () => {
    const global = fakeGlobal();
    const curve = { ...pump.newBondingCurve(global), creator: treasuryPda(mint.publicKey) };
    const txs = {
      create: await buildCreateTx({ deposit: deposit.publicKey, mint: mint.publicKey, ...worst, recent, priority }),
      init: buildInitTx({ deposit: deposit.publicKey, launcher: launcher.publicKey, mint: mint.publicKey, triggerBps: 2500, creator: creator.publicKey, reimburseLamports: 1n, recent, priority }),
      devBuy: await buildDevBuyTx({ deposit: deposit.publicKey, sender, mint: mint.publicKey, tokens: 1n, maxSolCost: 1n, bondingCurve: curve, buybackFeeRecipient: global.buybackFeeRecipients[0]!, closeAccumulator: true, recent, priority }),
      refund: buildRefundTx({ deposit: deposit.publicKey, sender, lamports: 1n, recent, priority }),
    };
    signTransaction(txs.create, [deposit, mint]);
    signTransaction(txs.init, [deposit, launcher]);
    signTransaction(txs.devBuy, [deposit]);
    signTransaction(txs.refund, [deposit]);
    const sizes = Object.fromEntries(Object.entries(txs).map(([k, tx]) => [k, tx.serialize().length]));
    console.info("serialized transaction sizes (bytes, worst-case metadata):", sizes);
    for (const [kind, size] of Object.entries(sizes)) {
      expect(size, kind).toBeLessThanOrEqual(PACKET_DATA_SIZE);
      expect(serializedSize(txs[kind as keyof typeof txs]), kind).toBe(size);
    }
    expect(sizes.create).toBeGreaterThan(900); // the long strings really are in there
  });
});
