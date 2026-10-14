import { VersionedTransaction, type Connection, type PublicKey } from "@solana/web3.js";
import { roundOpenedFromLogs } from "@holdfast/core";
import { USE_MOCKS } from "./config";

export function decodeTransaction(base64: string): VersionedTransaction {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return VersionedTransaction.deserialize(bytes);
}

/** Wait for a submitted trade to confirm (mock mode resolves locally without an RPC). */
export async function confirmSignature(connection: Connection, signature: string, tx: VersionedTransaction, lastValidBlockHeight: number): Promise<void> {
  if (USE_MOCKS) {
    await new Promise((r) => setTimeout(r, 900));
    return;
  }
  const result = await connection.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, "confirmed");
  if (result.value.err) throw new Error("Transaction failed on-chain");
}

export async function getSolBalance(connection: Connection, owner: PublicKey): Promise<number> {
  if (USE_MOCKS) return 4.2;
  return (await connection.getBalance(owner, "confirmed")) / 1e9;
}

/**
 * The merkle root a round committed on-chain: the RoundOpened event in its `open_round` transaction
 * (null when the transaction is unknown to this RPC; mock mode has no chain to ask).
 */
export async function fetchCommittedRoot(connection: Connection, openSig: string, mint: string, roundId: number): Promise<{ root: string | null; failed: boolean }> {
  if (USE_MOCKS) return { root: null, failed: false };
  const tx = await connection.getTransaction(openSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) return { root: null, failed: false };
  const ev = roundOpenedFromLogs(tx.meta?.logMessages ?? []).find((e) => e.mint === mint && e.roundId === roundId);
  return { root: ev?.snapshotHash ?? null, failed: tx.meta?.err !== null && tx.meta?.err !== undefined };
}
