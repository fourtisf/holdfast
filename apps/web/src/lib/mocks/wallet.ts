import {
  BaseWalletAdapter,
  WalletNotConnectedError,
  WalletReadyState,
  type SendTransactionOptions,
  type TransactionOrVersionedTransaction,
  type WalletName,
} from "@solana/wallet-adapter-base";
import { PublicKey, type Connection, type TransactionSignature, type TransactionVersion } from "@solana/web3.js";
import { MOCK_WALLET, randomSignature } from "./ids";

const ICON =
  "data:image/svg+xml;base64," +
  (typeof btoa === "function"
    ? btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#7ef0b8"/><path d="M16 7v14m-6-4a6 6 0 0 0 12 0M12 10h8" stroke="#08090d" stroke-width="2.6" fill="none" stroke-linecap="round"/></svg>',
      )
    : "");

export const MockWalletName = "Demo Wallet (mock)" as WalletName<"Demo Wallet (mock)">;

/** Wallet adapter used only in mock mode: connects as MOCK_WALLET and "sends" without touching an RPC. */
export class MockWalletAdapter extends BaseWalletAdapter<"Demo Wallet (mock)"> {
  name = MockWalletName;
  url = "https://holdfast.local/mock-wallet";
  icon = ICON;
  readyState = WalletReadyState.Installed;
  publicKey: PublicKey | null = null;
  connecting = false;
  supportedTransactionVersions = new Set<TransactionVersion>(["legacy", 0]);

  async connect(): Promise<void> {
    if (this.publicKey) return;
    this.connecting = true;
    await new Promise((r) => setTimeout(r, 150));
    this.publicKey = new PublicKey(MOCK_WALLET);
    this.connecting = false;
    this.emit("connect", this.publicKey);
  }

  async disconnect(): Promise<void> {
    this.publicKey = null;
    this.emit("disconnect");
  }

  async sendTransaction(
    _transaction: TransactionOrVersionedTransaction<this["supportedTransactionVersions"]>,
    _connection: Connection,
    _options?: SendTransactionOptions,
  ): Promise<TransactionSignature> {
    if (!this.publicKey) throw new WalletNotConnectedError();
    await new Promise((r) => setTimeout(r, 700));
    return randomSignature();
  }
}
