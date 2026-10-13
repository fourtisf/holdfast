import { afterEach, beforeEach, describe, expect, it } from "vitest";
import bs58 from "bs58";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  type ParsedTransactionWithMeta,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { emitCpiData, encodePumpEvent } from "@holdfast/chain";
import { getWalletBalance, loadLedger } from "@holdfast/db";
import {
  fromEnhancedTransactionJson,
  fromHeliusPayloadItem,
  fromParsedTransactionWithMeta,
  fromRawTransactionJson,
  fromVersionedTransactionResponse,
  invokedInstructions,
  type RawTransactionJson,
} from "../src/index.js";
import { coinFixture, harness, launchTx, PUMP, wallet, type CoinFixture, type Harness } from "./fixtures.js";

const T0 = 1_760_000_000;
let h: Harness;
let coin: CoinFixture;

beforeEach(async () => {
  h = await harness();
  coin = coinFixture();
  await h.run(launchTx(coin, { launcher: wallet(), depositor: wallet(), slot: 1, ts: T0, devBuy: 1n }));
});
afterEach(async () => {
  await h.db.close();
});

function tradeEvent(user: string, tokens: bigint) {
  return encodePumpEvent("pump", "TradeEvent", { mint: coin.mint, user, is_buy: true, sol_amount: 1_000_000n, token_amount: tokens, timestamp: T0 + 60 });
}

describe("@solana/web3.js getTransaction (v0 + lookup table)", () => {
  it("normalizes keys, inner instructions and balances, and indexes the buy", async () => {
    const payer = Keypair.generate().publicKey;
    const lookupKey = Keypair.generate().publicKey;
    const fromTable = Keypair.generate().publicKey;
    const table = new AddressLookupTableAccount({
      key: lookupKey,
      state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [fromTable] },
    });
    const ata = new PublicKey(coin.ata(payer.toBase58()));
    const ix = new TransactionInstruction({
      programId: new PublicKey(PUMP),
      keys: [
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: fromTable, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
    });
    const message = new TransactionMessage({ payerKey: payer, recentBlockhash: bs58.encode(Buffer.alloc(32, 7)), instructions: [ix] }).compileToV0Message([table]);
    const keys = [...message.staticAccountKeys.map((k) => k.toBase58()), fromTable.toBase58()];
    const ataIndex = keys.indexOf(ata.toBase58());
    const pumpIndex = keys.indexOf(PUMP);
    const res: VersionedTransactionResponse = {
      slot: 50,
      blockTime: T0 + 60,
      transaction: { message, signatures: [bs58.encode(Buffer.alloc(64, 1))] },
      meta: {
        fee: 5000,
        err: null,
        preBalances: keys.map(() => 1),
        postBalances: keys.map(() => 1),
        logMessages: [`Program ${PUMP} invoke [1]`, `Program ${PUMP} success`],
        innerInstructions: [{ index: 0, instructions: [{ programIdIndex: pumpIndex, accounts: [], data: bs58.encode(emitCpiData(tradeEvent(payer.toBase58(), 500n))) }] }],
        preTokenBalances: [],
        postTokenBalances: [{ accountIndex: ataIndex, mint: coin.mint, owner: payer.toBase58(), uiTokenAmount: { amount: "500", decimals: 6, uiAmount: 0.0005 } }],
        loadedAddresses: { writable: [], readonly: [fromTable] },
      },
      version: 0,
    };

    const tx = fromVersionedTransactionResponse(res);
    expect(tx.accountKeys).toEqual(keys);
    expect(tx.signers).toEqual([payer.toBase58()]);
    expect(tx.instructions[0]?.accounts).toEqual([ata.toBase58(), fromTable.toBase58()]);
    expect(invokedInstructions(tx).map((i) => [i.programId, i.outerIndex])).toEqual([
      [PUMP, 0],
      [PUMP, 0],
    ]);
    expect(tx.postTokenBalances[0]).toMatchObject({ account: ata.toBase58(), owner: payer.toBase58(), amount: 500n });
    expect(tx.blockTime).toBe((T0 + 60) * 1000);

    expect(await h.run(tx)).toMatchObject({ status: "processed", trades: 1, lots: 1 });
    expect((await loadLedger(h.db, coin.mint, payer.toBase58())).lots.map((l) => l.amount)).toEqual([500n]);
  });

  it("getParsedTransaction responses", () => {
    const user = wallet();
    const res = {
      slot: 9,
      blockTime: T0,
      transaction: {
        signatures: ["sig1"],
        message: {
          accountKeys: [
            { pubkey: new PublicKey(user), signer: true, writable: true },
            { pubkey: new PublicKey(PUMP), signer: false, writable: false },
          ],
          instructions: [
            { programId: new PublicKey(PUMP), accounts: [new PublicKey(user)], data: bs58.encode(Buffer.from([1, 2])) },
            { programId: new PublicKey("11111111111111111111111111111111"), program: "system", parsed: { type: "transfer" } },
          ],
          recentBlockhash: "x",
        },
      },
      meta: {
        fee: 0,
        err: null,
        preBalances: [1, 2],
        postBalances: [3, 4],
        innerInstructions: [{ index: 0, instructions: [{ programId: new PublicKey(PUMP), accounts: [], data: bs58.encode(emitCpiData(tradeEvent(user, 1n))) }] }],
        logMessages: [],
        preTokenBalances: [],
        postTokenBalances: [],
      },
    } as unknown as ParsedTransactionWithMeta;
    const tx = fromParsedTransactionWithMeta(res);
    expect(tx.signers).toEqual([user]);
    expect(tx.instructions[1]).toEqual({ programId: "11111111111111111111111111111111", accounts: [], data: new Uint8Array() });
    expect(Array.from(tx.instructions[0]!.data)).toEqual([1, 2]);
    expect(tx.postBalances).toEqual([3n, 4n]);
    expect(invokedInstructions(tx)).toHaveLength(3);
  });
});

describe("Helius webhooks", () => {
  it("raw payload items", async () => {
    const user = wallet();
    const ata = coin.ata(user);
    const raw: RawTransactionJson = {
      slot: 70,
      blockTime: T0 + 70,
      transaction: {
        signatures: [bs58.encode(Buffer.alloc(64, 3))],
        message: {
          accountKeys: [user, ata, PUMP],
          header: { numRequiredSignatures: 1 },
          instructions: [{ programIdIndex: 2, accounts: [1], data: bs58.encode(Buffer.from([9])) }],
        },
      },
      meta: {
        err: null,
        logMessages: [],
        innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 2, accounts: [], data: bs58.encode(emitCpiData(tradeEvent(user, 42n))) }] }],
        preTokenBalances: [],
        postTokenBalances: [{ accountIndex: 1, mint: coin.mint, owner: user, uiTokenAmount: { amount: "42", decimals: 6 } }],
        preBalances: [0, 0, 0],
        postBalances: [0, 0, 0],
        loadedAddresses: { writable: [], readonly: [] },
      },
    };
    const tx = fromHeliusPayloadItem(raw);
    expect(tx).toEqual(fromRawTransactionJson(raw));
    expect(tx.signers).toEqual([user]);
    expect(await h.run(tx)).toMatchObject({ status: "processed", trades: 1, lots: 1 });
  });

  it("enhanced payload items (deltas, no logs)", async () => {
    const user = wallet();
    const other = wallet();
    const enhanced = {
      signature: bs58.encode(Buffer.alloc(64, 4)),
      slot: 80,
      timestamp: T0 + 80,
      feePayer: user,
      transactionError: null,
      instructions: [{ programId: PUMP, accounts: [user], data: bs58.encode(Buffer.from([1])), innerInstructions: [{ programId: PUMP, accounts: [], data: bs58.encode(emitCpiData(tradeEvent(user, 90n))) }] }],
      accountData: [
        { account: user, tokenBalanceChanges: [{ mint: coin.mint, tokenAccount: coin.ata(user), userAccount: user, rawTokenAmount: { tokenAmount: "90", decimals: 6 } }] },
        { account: other, tokenBalanceChanges: [{ mint: "So11111111111111111111111111111111111111112", tokenAccount: "x", userAccount: other, rawTokenAmount: { tokenAmount: "-5", decimals: 9 } }] },
      ],
    };
    const tx = fromHeliusPayloadItem(enhanced);
    expect(tx).toEqual(fromEnhancedTransactionJson(enhanced));
    expect(tx.tokenBalanceMode).toBe("delta");
    expect(tx.logMessages).toBeNull();
    expect(await h.run(tx)).toMatchObject({ status: "processed", trades: 1, lots: 1 });
    expect(await getWalletBalance(h.db, coin.mint, user)).toMatchObject({ balance: 90n, untracked: 0n });
  });

  it("rejects unknown shapes", () => {
    expect(() => fromHeliusPayloadItem({ foo: 1 })).toThrow("unrecognized");
  });
});
