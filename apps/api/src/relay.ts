import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { HOLDFAST_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "@holdfast/chain";
import { HttpError } from "./errors.js";

export type TxState = "pending" | "confirmed" | "failed";

/**
 * The browser never talks to an RPC node directly (the public endpoint refuses browsers): it signs in the wallet and
 * hands the signed transaction to the API, which sends it and reports its status over our own RPC.
 */
export interface TxRelay {
  send(raw: Uint8Array): Promise<string>;
  status(signature: string): Promise<{ status: TxState; error: string | null }>;
  balance(owner: PublicKey): Promise<bigint>;
}

/** Only Moatpad transactions are relayed: they must invoke pump.fun, PumpSwap or the Holdfast program. */
const RELAYED_PROGRAMS = new Set([PUMP_PROGRAM_ID.toBase58(), PUMP_AMM_PROGRAM_ID.toBase58(), HOLDFAST_PROGRAM_ID.toBase58()]);

/** Parses and checks a signed transaction before it is relayed. */
export function checkRelayable(base64: string): Uint8Array {
  let raw: Uint8Array;
  let tx: VersionedTransaction;
  try {
    raw = Uint8Array.from(Buffer.from(base64, "base64"));
    tx = VersionedTransaction.deserialize(raw);
  } catch {
    throw new HttpError(400, "transaction must be a base64 serialized transaction");
  }
  const keys = tx.message.staticAccountKeys;
  const required = tx.message.header.numRequiredSignatures;
  if (tx.signatures.slice(0, required).some((s) => s.every((b) => b === 0))) throw new HttpError(400, "transaction is not fully signed");
  const invoked = tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]?.toBase58());
  if (!invoked.some((p) => p && RELAYED_PROGRAMS.has(p))) throw new HttpError(400, "only Moatpad transactions can be sent here");
  return raw;
}

export class RpcTxRelay implements TxRelay {
  constructor(private readonly connection: Connection) {}

  async send(raw: Uint8Array): Promise<string> {
    try {
      return await this.connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
    } catch (err) {
      const logs = (err as { logs?: string[] }).logs;
      const message = err instanceof Error ? err.message : String(err);
      // Simulation failures describe the transaction (expired blockhash, insufficient funds, slippage): the user's to fix.
      if (/simulation failed|blockhash not found|insufficient|custom program error|already been processed/i.test(message)) {
        throw new HttpError(422, simplify(message, logs));
      }
      throw new HttpError(503, "The network is busy, try again in a moment");
    }
  }

  async status(signature: string): Promise<{ status: TxState; error: string | null }> {
    const { value } = await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: false });
    const s = value[0];
    if (!s) return { status: "pending", error: null };
    if (s.err) return { status: "failed", error: JSON.stringify(s.err) };
    return { status: s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? "confirmed" : "pending", error: null };
  }

  async balance(owner: PublicKey): Promise<bigint> {
    return BigInt(await this.connection.getBalance(owner, "confirmed"));
  }
}

function simplify(message: string, logs: string[] | undefined): string {
  if (/blockhash not found/i.test(message)) return "The transaction expired before it was sent. Try again.";
  if (/insufficient (funds|lamports)/i.test(message) || logs?.some((l) => /insufficient lamports/i.test(l))) return "Not enough SOL in your wallet for this transaction.";
  if (/already been processed/i.test(message)) return "This transaction was already sent.";
  const programLine = logs?.find((l) => /Error Message:|failed:/i.test(l));
  return programLine ? `Transaction rejected: ${programLine.replace(/^Program log: /, "")}` : "Transaction rejected by the network.";
}
