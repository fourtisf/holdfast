import { Keypair, PublicKey, SystemProgram, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { incomingTransfers, pickFunding } from "../src/funding.js";

const deposit = Keypair.generate().publicKey.toBase58();
const alice = Keypair.generate().publicKey.toBase58();
const bob = Keypair.generate().publicKey.toBase58();
const program = Keypair.generate().publicKey;

const transfer = (source: string, destination: string, lamports: number) => ({
  program: "system",
  programId: SystemProgram.programId,
  parsed: { type: "transfer", info: { source, destination, lamports } },
});

function tx(opts: {
  sig: string;
  slot: number;
  instructions?: unknown[];
  inner?: unknown[];
  keys?: string[];
  pre?: number[];
  post?: number[];
  err?: unknown;
}): ParsedTransactionWithMeta {
  return {
    slot: opts.slot,
    blockTime: 1_760_000_000 + opts.slot,
    transaction: {
      signatures: [opts.sig],
      message: {
        accountKeys: (opts.keys ?? []).map((k) => ({ pubkey: new PublicKey(k), signer: false, writable: true })),
        instructions: opts.instructions ?? [],
        recentBlockhash: "",
      },
    },
    meta: {
      err: opts.err ?? null,
      fee: 5000,
      preBalances: opts.pre ?? [],
      postBalances: opts.post ?? [],
      innerInstructions: opts.inner ? [{ index: 0, instructions: opts.inner }] : [],
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe("incomingTransfers", () => {
  it("finds top-level and inner System transfers into the address", () => {
    const t = tx({ sig: "s1", slot: 1, instructions: [transfer(alice, deposit, 100), transfer(alice, bob, 7)], inner: [transfer(bob, deposit, 5)] });
    expect(incomingTransfers(t, deposit).map((x) => [x.source, x.lamports])).toEqual([
      [alice, 100n],
      [bob, 5n],
    ]);
  });

  it("ignores failed transactions and the address's own outgoing transfers", () => {
    expect(incomingTransfers(tx({ sig: "s", slot: 1, instructions: [transfer(alice, deposit, 1)], err: { InstructionError: [0, "x"] } }), deposit)).toEqual([]);
    expect(incomingTransfers(tx({ sig: "s", slot: 1, instructions: [transfer(deposit, alice, 1)], keys: [deposit, alice], pre: [10, 0], post: [4, 1] }), deposit)).toEqual([]);
  });

  it("falls back to the fee payer when an unparsed instruction credited the address", () => {
    const t = tx({
      sig: "s2",
      slot: 2,
      instructions: [{ programId: program, accounts: [], data: "" }],
      keys: [bob, deposit],
      pre: [1_000, 0],
      post: [400, 595],
    });
    expect(incomingTransfers(t, deposit)).toEqual([{ source: bob, lamports: 595n, signature: "s2", blockTime: 1_760_000_002, slot: 2 }]);
  });
});

describe("pickFunding", () => {
  it("returns the largest contributor with its latest transfer", () => {
    const funding = pickFunding([
      { source: alice, lamports: 10n, signature: "a1", blockTime: 1, slot: 1 },
      { source: bob, lamports: 15n, signature: "b1", blockTime: 2, slot: 2 },
      { source: alice, lamports: 10n, signature: "a2", blockTime: 3, slot: 3 },
    ]);
    expect(funding).toEqual({ sender: alice, signature: "a2", lamports: 20n, blockTime: 3 });
    expect(pickFunding([])).toBeNull();
  });
});
