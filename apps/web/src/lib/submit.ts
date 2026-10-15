import type { WalletContextState } from "@solana/wallet-adapter-react";
import type { Connection, VersionedTransaction } from "@solana/web3.js";
import { api } from "./api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Signs in the wallet and sends through the API's RPC, so nothing depends on the browser reaching an RPC node.
 * Wallets that can only send (and the mock wallet) send themselves.
 */
export async function signAndSend(
  wallet: Pick<WalletContextState, "signTransaction" | "sendTransaction">,
  connection: Connection,
  tx: VersionedTransaction,
): Promise<string> {
  if (wallet.signTransaction) {
    const signed = await wallet.signTransaction(tx);
    return (await api.sendTransaction(toBase64(signed.serialize()))).signature;
  }
  return wallet.sendTransaction(tx, connection);
}

/** Polls the API until the transaction is confirmed (about 90 s at most: longer than a blockhash lives). */
export async function waitForConfirmation(signature: string, timeoutMs = 90_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const s = await api.txStatus(signature).catch(() => null);
    if (s?.status === "confirmed") return;
    if (s?.status === "failed") throw new Error("Transaction failed on-chain");
    if (s?.status === "expired") throw new Error("The network dropped the transaction before it landed. Nothing was charged: try again.");
    await sleep(1_500);
  }
  throw new Error("Not confirmed in time. Check the transaction on the explorer before trying again.");
}
