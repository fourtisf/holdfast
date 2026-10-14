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
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="hf-lit" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#d4ffe9"/><stop offset="0.42" stop-color="#5fe8a8"/><stop offset="1" stop-color="#0c8653"/></linearGradient><linearGradient id="hf-shade" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#1fae72"/><stop offset="1" stop-color="#06402a"/></linearGradient><linearGradient id="hf-deep-lit" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#18b071"/><stop offset="1" stop-color="#0a5a39"/></linearGradient><linearGradient id="hf-deep-shade" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#0b6d47"/><stop offset="1" stop-color="#03281a"/></linearGradient><linearGradient id="hf-tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#132a20"/><stop offset="1" stop-color="#04090a"/></linearGradient><radialGradient id="hf-glow" cx="0.5" cy="0.42" r="0.55"><stop offset="0" stop-color="#5fe8a8" stop-opacity="0.22"/><stop offset="1" stop-color="#5fe8a8" stop-opacity="0"/></radialGradient></defs><rect width="100" height="100" rx="23" fill="url(#hf-tile)"/><rect width="100" height="100" rx="23" fill="url(#hf-glow)"/><rect x="0.6" y="0.6" width="98.8" height="98.8" rx="22.4" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="1.2"/><g transform="translate(50 50) scale(0.9) translate(-50 -50)"><polygon points="14,28 34,12 34,88 14,88" fill="url(#hf-lit)"/><polygon points="66,12 86,28 86,88 66,88" fill="url(#hf-lit)"/><polygon points="34,54 50,41.2 66,54 66,71 50,58.2 34,71" fill="url(#hf-lit)"/></g></svg>',
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
