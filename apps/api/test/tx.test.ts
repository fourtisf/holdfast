import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { PUMP_PROGRAM_ID } from "@holdfast/chain";
import type { Db } from "@holdfast/db";
import { checkRelayable, type TxRelay } from "../src/relay.js";
import { freshDb, makeApi, NOW, type TestApi } from "./helpers.js";

const payer = Keypair.generate();
const blockhash = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
function tx(program: PublicKey | null, sign = true): string {
  const ixs = [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })];
  if (program) ixs.push(new TransactionInstruction({ programId: program, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1]) }));
  const t = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  if (sign) t.sign([payer]);
  return Buffer.from(t.serialize()).toString("base64");
}

const sent: Uint8Array[] = [];
const relay: TxRelay = {
  async send(raw) {
    sent.push(raw);
    return "5".repeat(88);
  },
  async status(signature) {
    return { status: signature.startsWith("2") ? "confirmed" : "pending", error: null };
  },
  async balance() {
    return 4_200_000_000n;
  },
};

let db: Db;
let api: TestApi;
beforeAll(async () => {
  db = await freshDb();
  api = await makeApi(db, {}, () => NOW, { relay });
});
afterAll(async () => {
  await api.app.close();
  await db.close();
});

describe("checkRelayable", () => {
  it("accepts a fully signed transaction that calls pump.fun, PumpSwap or Holdfast, and nothing else", () => {
    expect(checkRelayable(tx(PUMP_PROGRAM_ID))).toBeInstanceOf(Uint8Array);
    expect(() => checkRelayable(tx(null))).toThrow(/only Moatpad/);
    expect(() => checkRelayable(tx(PUMP_PROGRAM_ID, false))).toThrow(/not fully signed/);
    expect(() => checkRelayable("not base64 at all")).toThrow(/base64/);
  });
});

describe("/tx and /balance", () => {
  it("relays a Moatpad transaction, refuses others, reports status and balance", async () => {
    const ok = await api.app.inject({ method: "POST", url: "/tx/send", payload: { transaction: tx(PUMP_PROGRAM_ID) } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ signature: "5".repeat(88) });
    expect(sent).toHaveLength(1);
    expect((await api.app.inject({ method: "POST", url: "/tx/send", payload: { transaction: tx(null) } })).statusCode).toBe(400);
    expect(sent).toHaveLength(1);
    expect((await api.app.inject({ method: "GET", url: `/tx/${"2".repeat(88)}` })).json()).toEqual({ status: "confirmed", error: null });
    expect((await api.app.inject({ method: "GET", url: "/tx/abc" })).statusCode).toBe(400);
    const bal = await api.app.inject({ method: "GET", url: `/balance?wallet=${payer.publicKey.toBase58()}` });
    expect(bal.json()).toEqual({ lamports: "4200000000", sol: 4.2 });
  });
});

describe("RpcTxRelay", () => {
  it("reports a transaction whose blockhash ran out without landing as expired, and maps simulation errors to 422", async () => {
    const { RpcTxRelay } = await import("../src/relay.js");
    let valid = true;
    const conn = {
      sendRawTransaction: async () => "3".repeat(88),
      getSignatureStatuses: async () => ({ value: [null] }),
      isBlockhashValid: async () => ({ value: valid }),
    };
    const relay = new RpcTxRelay(conn as never, () => 0);
    const raw = Buffer.from(tx(PUMP_PROGRAM_ID), "base64");
    expect(await relay.send(raw)).toBe("3".repeat(88));
    expect(await relay.status("3".repeat(88))).toEqual({ status: "pending", error: null });
    valid = false;
    expect(await relay.status("3".repeat(88))).toEqual({ status: "expired", error: null });

    const failing = new RpcTxRelay({ ...conn, sendRawTransaction: async () => { throw new Error("Transaction simulation failed: Blockhash not found"); } } as never);
    await expect(failing.send(raw)).rejects.toMatchObject({ statusCode: 422, message: "The transaction expired before it was sent. Try again." });
  });
});
