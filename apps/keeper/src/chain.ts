import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  type AccountInfo,
  type Commitment,
  type Signer,
  type TransactionInstruction,
} from "@solana/web3.js";

/** Everything the keeper and payout worker need from Solana. Faked in tests. */
export interface KeeperChain {
  getAccounts(keys: readonly PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]>;
  /** Builds, signs, sends and confirms a transaction; returns its signature. */
  send(instructions: TransactionInstruction[], signers: Signer[], opts?: SendOptions): Promise<string>;
  /** Serialized size check for batching (legacy transaction, 1232-byte limit). */
  fits(instructions: TransactionInstruction[], feePayer: PublicKey, signerCount: number): boolean;
  nowMs(): number;
}

export const PACKET_DATA_SIZE = 1232;

export interface SendOptions {
  computeUnits?: number;
  /** Compute-unit price override (default: the chain's configured priority fee). */
  microLamports?: number;
}

export function computeBudget(units: number, microLamports: number): TransactionInstruction[] {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (microLamports > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  return ixs;
}

export function transactionFits(instructions: TransactionInstruction[], feePayer: PublicKey, signerCount: number): boolean {
  const tx = new Transaction({ feePayer, recentBlockhash: PublicKey.default.toBase58() });
  tx.add(...computeBudget(400_000, 1), ...instructions);
  try {
    const message = tx.serializeMessage();
    // shortvec signature count + 64 bytes per signature
    return 1 + signerCount * 64 + message.length <= PACKET_DATA_SIZE;
  } catch {
    return false;
  }
}

export class Web3Chain implements KeeperChain {
  constructor(
    readonly connection: Connection,
    private readonly priorityMicroLamports: number,
    private readonly commitment: Commitment = "confirmed",
  ) {}

  async getAccounts(keys: readonly PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    const out: (AccountInfo<Buffer> | null)[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      out.push(...(await this.connection.getMultipleAccountsInfo(keys.slice(i, i + 100), this.commitment)));
    }
    return out;
  }

  async send(instructions: TransactionInstruction[], signers: Signer[], opts: SendOptions = {}): Promise<string> {
    const [payer] = signers;
    if (!payer) throw new Error("at least one signer (fee payer) required");
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash(this.commitment);
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight });
    tx.add(...computeBudget(opts.computeUnits ?? 400_000, opts.microLamports ?? this.priorityMicroLamports), ...instructions);
    tx.sign(...signers);
    const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const res = await this.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, this.commitment);
    if (res.value.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  }

  fits(instructions: TransactionInstruction[], feePayer: PublicKey, signerCount: number): boolean {
    return transactionFits(instructions, feePayer, signerCount);
  }

  nowMs(): number {
    return Date.now();
  }
}
