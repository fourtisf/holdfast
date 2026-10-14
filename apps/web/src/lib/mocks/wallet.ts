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
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="hf" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9ff5cc"/><stop offset="1" stop-color="#3fd690"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#hf)"/><path d="M21 22 L32 11 L43 22 M32 11 V35" fill="none" stroke="#04170e" stroke-linecap="round" stroke-linejoin="round" stroke-width="6"/><path d="M32 33 C22 33 17.5 40 19.5 48 M32 33 C42 33 46.5 40 44.5 48" fill="none" stroke="#04170e" stroke-linecap="round" stroke-linejoin="round" stroke-width="5.5"/><circle cx="32" cy="45" r="6.5" fill="#04170e"/><path d="M15 55 H49" fill="none" stroke="#04170e" stroke-linecap="round" stroke-linejoin="round" stroke-width="4"/></svg>',
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

  /** Mock signatures are random: the mock API does not verify them. */
  async signMessage(_message: Uint8Array): Promise<Uint8Array> {
    if (!this.publicKey) throw new WalletNotConnectedError();
    await new Promise((r) => setTimeout(r, 300));
    return crypto.getRandomValues(new Uint8Array(64));
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
