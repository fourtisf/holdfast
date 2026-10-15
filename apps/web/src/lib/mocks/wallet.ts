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
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="mp-ring" x1="0.15" y1="0" x2="0.85" y2="1"><stop offset="0" stop-color="#fff0c2"/><stop offset="0.3" stop-color="#e7bd62"/><stop offset="0.62" stop-color="#9d7126"/><stop offset="0.85" stop-color="#e3b85d"/><stop offset="1" stop-color="#f6dc95"/></linearGradient><linearGradient id="mp-gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff1c6"/><stop offset="0.5" stop-color="#e8bc5b"/><stop offset="1" stop-color="#a97b2a"/></linearGradient><radialGradient id="mp-disc" cx="0.38" cy="0.3" r="0.8"><stop offset="0" stop-color="#3b3e45"/><stop offset="0.55" stop-color="#121418"/><stop offset="1" stop-color="#040506"/></radialGradient><linearGradient id="mp-word" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbe8b4"/><stop offset="1" stop-color="#c99a3e"/></linearGradient><linearGradient id="mp-tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#17181c"/><stop offset="1" stop-color="#050607"/></linearGradient></defs><rect width="100" height="100" rx="22" fill="url(#mp-tile)"/><circle cx="50" cy="50" r="44.25" fill="none" stroke="url(#mp-ring)" stroke-width="6.5"/><circle cx="50" cy="50" r="35.5" fill="url(#mp-disc)"/><polygon points="27.04,69.95 27.04,33.05 31.55,33.05 31.55,37.56 36.06,37.56 36.06,33.05 40.57,33.05 50.00,49.04 59.43,33.05 63.94,33.05 63.94,37.56 68.45,37.56 68.45,33.05 72.96,33.05 72.96,69.95 59.43,69.95 59.43,52.32 50.00,66.26 40.57,52.32 40.57,69.95" fill="url(#mp-gold)"/></svg>',
      )
    : "");

export const MockWalletName = "Demo Wallet" as WalletName<"Demo Wallet">;

/** Wallet adapter used only in mock mode: connects as MOCK_WALLET and "sends" without touching an RPC. */
export class MockWalletAdapter extends BaseWalletAdapter<"Demo Wallet"> {
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
