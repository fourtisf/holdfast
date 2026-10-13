import { Keypair, PublicKey, SendTransactionError, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { TxError } from "../src/chain.js";
import { Web3LaunchChain } from "../src/web3Chain.js";

const payer = Keypair.generate();
const to = Keypair.generate().publicKey;

function transferTx(lastValidBlockHeight = 100): Transaction {
  return new Transaction({ feePayer: payer.publicKey, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight }).add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: 1 }),
  );
}

interface StubState {
  sent: number;
  height: number;
  status: { confirmationStatus: string; err: unknown } | null;
  sendError?: Error;
  statusAfterSends?: number;
}

function stub(state: StubState): Connection {
  return {
    sendRawTransaction: async () => {
      state.sent += 1;
      if (state.sendError && state.sent === 1) throw state.sendError;
      return "sig";
    },
    getSignatureStatuses: async () => ({ value: [state.statusAfterSends !== undefined && state.sent < state.statusAfterSends ? null : state.status] }),
    getBlockHeight: async () => (state.height += 10),
  } as unknown as Connection;
}

const fast = { pollIntervalMs: 1, rebroadcastIntervalMs: 0 };

describe("Web3LaunchChain.sendAndConfirm", () => {
  it("resolves with the signature once confirmed, rebroadcasting meanwhile", async () => {
    const state: StubState = { sent: 0, height: 0, status: { confirmationStatus: "confirmed", err: null }, statusAfterSends: 3 };
    const chain = new Web3LaunchChain(stub(state), fast);
    const tx = transferTx(1_000);
    const sig = await chain.sendAndConfirm(tx, [payer]);
    expect(sig).toBe(bs58.encode(tx.signature!));
    expect(state.sent).toBeGreaterThanOrEqual(3);
  });

  it("reports a landed error as `failed`", async () => {
    const chain = new Web3LaunchChain(stub({ sent: 0, height: 0, status: { confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } } }), fast);
    await expect(chain.sendAndConfirm(transferTx(), [payer])).rejects.toMatchObject({ outcome: "failed" });
  });

  it("reports `expired` only once the block height passed lastValidBlockHeight", async () => {
    const state: StubState = { sent: 0, height: 0, status: null };
    const chain = new Web3LaunchChain(stub(state), fast);
    const err = await chain.sendAndConfirm(transferTx(50), [payer]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxError);
    expect((err as TxError).outcome).toBe("expired");
    expect(state.height).toBeGreaterThan(50);
  });

  it("reports a preflight failure as `rejected` (never broadcast)", async () => {
    const sendError = new SendTransactionError({ action: "send", signature: "x", transactionMessage: "custom program error: 0x1", logs: ["log"] });
    const chain = new Web3LaunchChain(stub({ sent: 0, height: 0, status: null, sendError }), fast);
    await expect(chain.sendAndConfirm(transferTx(), [payer])).rejects.toMatchObject({ outcome: "rejected" });
  });

  it("keeps confirming after a network error on send (the transaction may have reached a leader)", async () => {
    const chain = new Web3LaunchChain(stub({ sent: 0, height: 0, status: { confirmationStatus: "finalized", err: null }, sendError: new Error("fetch failed") }), fast);
    await expect(chain.sendAndConfirm(transferTx(), [payer])).resolves.toBeTypeOf("string");
  });
});

describe("Web3LaunchChain.findFundingSender", () => {
  it("parses the deposit's signature history", async () => {
    const deposit = Keypair.generate().publicKey;
    const sender = Keypair.generate().publicKey;
    const parsed = (sig: string, source: PublicKey, lamports: number) => ({
      slot: sig === "s1" ? 1 : 2,
      blockTime: 1_760_000_000,
      transaction: {
        signatures: [sig],
        message: {
          accountKeys: [],
          instructions: [{ program: "system", programId: SystemProgram.programId, parsed: { type: "transfer", info: { source: source.toBase58(), destination: deposit.toBase58(), lamports } } }],
        },
      },
      meta: { err: null, preBalances: [], postBalances: [], innerInstructions: [] },
    });
    const conn = {
      getSignaturesForAddress: async () => [
        { signature: "s2", err: null },
        { signature: "bad", err: { InstructionError: [0, "x"] } },
        { signature: "s1", err: null },
      ],
      getParsedTransaction: async (sig: string) => (sig === "s1" ? parsed("s1", sender, 10_000_000) : parsed("s2", sender, 5_000_000)),
    } as unknown as Connection;
    const funding = await new Web3LaunchChain(conn).findFundingSender(deposit);
    expect(funding).toEqual({ sender: sender.toBase58(), signature: "s2", lamports: 15_000_000n, blockTime: 1_760_000_000 });
  });
});
