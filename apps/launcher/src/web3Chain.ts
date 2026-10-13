/** `LaunchChain` over a web3.js `Connection` (SOLANA_RPC_URL). */
import { Connection, SendTransactionError, type Commitment, type PublicKey, type Signer, type Transaction } from "@solana/web3.js";
import bs58 from "bs58";

import { TxError, type AccountSnapshot, type FundingInfo, type LaunchChain, type RecentBlockhash } from "./chain.js";
import { incomingTransfers, pickFunding } from "./funding.js";

export interface Web3ChainOptions {
  commitment?: Commitment;
  /** How many recent signatures of a deposit address to inspect for its funding transfer. */
  signatureLimit?: number;
  pollIntervalMs?: number;
  rebroadcastIntervalMs?: number;
  /** Consecutive RPC failures while confirming before giving up with outcome `unknown`. */
  maxConfirmErrors?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Web3LaunchChain implements LaunchChain {
  private readonly commitment: Commitment;
  private readonly signatureLimit: number;
  private readonly pollIntervalMs: number;
  private readonly rebroadcastIntervalMs: number;
  private readonly maxConfirmErrors: number;

  constructor(
    readonly connection: Connection,
    opts: Web3ChainOptions = {},
  ) {
    this.commitment = opts.commitment ?? "confirmed";
    this.signatureLimit = opts.signatureLimit ?? 50;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    this.rebroadcastIntervalMs = opts.rebroadcastIntervalMs ?? 2_000;
    this.maxConfirmErrors = opts.maxConfirmErrors ?? 30;
  }

  static fromUrl(url: string, opts: Web3ChainOptions = {}): Web3LaunchChain {
    return new Web3LaunchChain(new Connection(url, opts.commitment ?? "confirmed"), opts);
  }

  async getBalance(address: PublicKey): Promise<bigint> {
    return BigInt(await this.connection.getBalance(address, this.commitment));
  }

  async accountExists(address: PublicKey): Promise<boolean> {
    return (await this.connection.getAccountInfo(address, this.commitment)) !== null;
  }

  async getAccountInfo(address: PublicKey): Promise<AccountSnapshot | null> {
    const info = await this.connection.getAccountInfo(address, this.commitment);
    return info ? { lamports: BigInt(info.lamports), owner: info.owner.toBase58(), data: Buffer.from(info.data) } : null;
  }

  async getMinimumBalanceForRentExemption(dataLength: number): Promise<bigint> {
    return BigInt(await this.connection.getMinimumBalanceForRentExemption(dataLength, this.commitment));
  }

  async latestBlockhash(): Promise<RecentBlockhash> {
    return this.connection.getLatestBlockhash(this.commitment);
  }

  async findFundingSender(address: PublicKey): Promise<FundingInfo | null> {
    const sigs = await this.connection.getSignaturesForAddress(address, { limit: this.signatureLimit }, "confirmed");
    const ok = sigs.filter((s) => s.err === null).map((s) => s.signature);
    if (ok.length === 0) return null;
    const txs = await this.connection.getParsedTransactions(ok, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const target = address.toBase58();
    return pickFunding(txs.flatMap((tx) => incomingTransfers(tx, target)));
  }

  async sendAndConfirm(tx: Transaction, signers: Signer[]): Promise<string> {
    if (!tx.recentBlockhash || tx.lastValidBlockHeight === undefined) throw new Error("transaction needs a recent blockhash and lastValidBlockHeight");
    tx.sign(...signers);
    const signature = bs58.encode(tx.signature!);
    const raw = tx.serialize();
    const lastValid = tx.lastValidBlockHeight;

    try {
      await this.connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: this.commitment, maxRetries: 0 });
    } catch (err) {
      if (err instanceof SendTransactionError && !/already been processed/i.test(err.message)) {
        const logs = (await err.getLogs(this.connection).catch(() => null)) ?? [];
        throw new TxError(`simulation failed: ${err.message}`, "rejected", signature, logs);
      }
      // Network errors: the request may or may not have reached a leader, so keep confirming.
    }

    let errors = 0;
    let lastBroadcast = Date.now();
    for (;;) {
      try {
        const { value } = await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: false });
        const status = value[0];
        if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
          if (status.err) throw new TxError(`transaction failed: ${JSON.stringify(status.err)}`, "failed", signature);
          return signature;
        }
        const height = await this.connection.getBlockHeight(this.commitment);
        if (height > lastValid) {
          const { value: final } = await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
          const s = final[0];
          if (s && !s.err) return signature;
          if (s?.err) throw new TxError(`transaction failed: ${JSON.stringify(s.err)}`, "failed", signature);
          throw new TxError("blockhash expired before confirmation", "expired", signature);
        }
        errors = 0;
      } catch (err) {
        if (err instanceof TxError) throw err;
        if (++errors >= this.maxConfirmErrors) throw new TxError(`could not confirm: ${message(err)}`, "unknown", signature);
      }
      if (Date.now() - lastBroadcast >= this.rebroadcastIntervalMs) {
        lastBroadcast = Date.now();
        this.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
      }
      await sleep(this.pollIntervalMs);
    }
  }
}
