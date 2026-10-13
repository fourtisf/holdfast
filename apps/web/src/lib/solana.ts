import { VersionedTransaction, type Connection, type PublicKey } from "@solana/web3.js";
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
