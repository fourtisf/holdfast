/**
 * In-memory Solana for the launcher tests. It executes the launcher's transactions instruction by
 * instruction with the effects that matter for the money flow (fees, rent, lamport transfers,
 * account creation, token balances, the pump curve) and the checks that make real transactions
 * fail (missing signers, insufficient lamports, accounts already in use, rent-exemption, packet
 * size, Config.launcher, curve creator == treasury). Failures can be injected per transaction kind.
 */
import { createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Signer,
  type Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import bs58 from "bs58";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  bondingCurvePda,
  configPda,
  HOLDFAST_IDL,
  HOLDFAST_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  treasuryPda,
  vaultPda,
  WSOL_MINT,
} from "@holdfast/chain";

import { TxError, type AccountSnapshot, type FundingInfo, type LaunchChain, type RecentBlockhash } from "../src/chain.js";
import { DEFAULT_RENT, type RentFn } from "@holdfast/chain";
import { pickFunding, type IncomingTransfer } from "../src/funding.js";
import { encodePumpAccount, pump, PUMP_SDK, type BondingCurve, type FeeConfig, type Global } from "../src/pump.js";
import { COIN_VAULT_SIZE, PUMP_USER_VOLUME_ACCUMULATOR_SIZE, pumpMintSize, SPL_TOKEN_ACCOUNT_SIZE, TOKEN_2022_ATA_SIZE, utf8Len } from "@holdfast/chain";
import { PACKET_DATA_SIZE } from "../src/tx.js";

export const pumpCoder = new BorshCoder(pump.pumpIdl as unknown as Idl);
export const holdfastCoder = new BorshCoder(HOLDFAST_IDL);

export type FakeTxKind = "create" | "init" | "devBuy" | "refund" | "launch" | "deliver" | "other";
export type InjectionMode = "reject" | "fail" | "expire" | "crash";

export interface Injection {
  kind: FakeTxKind;
  mode: InjectionMode;
  /** How many matching transactions are affected (default: all). */
  times?: number;
}

export interface LandedTx {
  kind: FakeTxKind;
  signature: string;
  feePayer: string;
  fee: bigint;
  size: number;
  ok: boolean;
  tx: Transaction | VersionedTransaction;
  /** The executed instructions (lookup tables resolved for v0 transactions). */
  instructions: TransactionInstruction[];
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function ed25519Verify(message: Uint8Array, signature: Uint8Array, key: PublicKey): boolean {
  const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, key.toBuffer()]), format: "der", type: "spki" });
  return verifySignature(null, message, publicKey, signature);
}

interface TokenState {
  mint: string;
  owner: string;
  amount: bigint;
}

interface Acct {
  lamports: bigint;
  owner: PublicKey;
  data: Buffer;
  token?: TokenState;
}

class ProgramError extends Error {}

const SYSTEM = SystemProgram.programId.toBase58();
const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();
const ATA = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
const TOKEN = TOKEN_PROGRAM_ID.toBase58();
const TOKEN22 = TOKEN_2022_PROGRAM_ID.toBase58();
const PUMP = PUMP_PROGRAM_ID.toBase58();
const HOLDFAST = HOLDFAST_PROGRAM_ID.toBase58();

const pk = () => Keypair.generate().publicKey;
const bn = (v: bigint | number | string) => new BN(v.toString());

export function fakeGlobal(): Global {
  return {
    initialized: true,
    authority: pk(),
    feeRecipient: pk(),
    initialVirtualTokenReserves: bn("1073000000000000"),
    initialVirtualSolReserves: bn("30000000000"),
    initialRealTokenReserves: bn("793100000000000"),
    tokenTotalSupply: bn("1000000000000000"),
    feeBasisPoints: bn(95),
    withdrawAuthority: pk(),
    enableMigrate: true,
    poolMigrationFee: bn(15_000_001),
    creatorFeeBasisPoints: bn(5),
    feeRecipients: Array.from({ length: 7 }, pk),
    setCreatorAuthority: pk(),
    adminSetCreatorAuthority: pk(),
    createV2Enabled: true,
    whitelistPda: pk(),
    reservedFeeRecipient: pk(),
    mayhemModeEnabled: false,
    reservedFeeRecipients: Array.from({ length: 7 }, pk),
    isCashbackEnabled: false,
    buybackFeeRecipients: Array.from({ length: 8 }, pk),
    buybackBasisPoints: bn(0),
    initialVirtualQuoteReserves: bn("30000000000"),
    whitelistedQuoteMints: [PublicKey.default],
    creatorFeeConfigurable: false,
    maxConfigurableCreatorFeeBps: bn(0),
    holderRewardClaimAuthority: PublicKey.default,
    isHolderRewardEnabled: false,
    maxCurveDepth: 0,
  } as Global;
}

export function fakeFeeConfig(): FeeConfig {
  const fees = (protocol: number, creator: number) => ({ lpFeeBps: bn(0), protocolFeeBps: bn(protocol), creatorFeeBps: bn(creator) });
  return {
    bump: 255,
    admin: pk(),
    flatFees: fees(95, 5),
    feeTiers: [
      { marketCapLamportsThreshold: bn(0), fees: fees(95, 30) },
      { marketCapLamportsThreshold: bn("420000000000"), fees: fees(93, 95) },
    ],
    stableFeeTiers: [],
    exoticFlatFees: fees(0, 0),
  } as unknown as FeeConfig;
}

export interface FakeChainOptions {
  now: () => number;
  /** Config.launcher of the Holdfast program. */
  configLauncher: PublicKey;
  rent?: RentFn;
}

export class FakeChain implements LaunchChain {
  readonly rent: RentFn;
  readonly global = fakeGlobal();
  readonly feeConfig = fakeFeeConfig();
  readonly landed: LandedTx[] = [];
  readonly vaultTriggers = new Map<string, number>();
  injections: Injection[] = [];
  private accounts = new Map<string, Acct>();
  private fundings = new Map<string, IncomingTransfer[]>();
  private readonly tables = new Map<string, AddressLookupTableAccount>();
  private height = 1_000;
  private slot = 10_000;
  private crashWaiters: (() => void)[] = [];
  crashes = 0;

  constructor(private readonly opts: FakeChainOptions) {
    this.rent = opts.rent ?? DEFAULT_RENT;
    this.put(pump.GLOBAL_PDA, { lamports: 1_000_000_000n, owner: PUMP_PROGRAM_ID, data: encodePumpAccount("global", this.global) });
    const fee = encodePumpAccount("feeConfig", this.feeConfig);
    this.put(pump.PUMP_FEE_CONFIG_PDA, {
      lamports: 1_000_000_000n,
      owner: pump.PUMP_FEE_PROGRAM_ID,
      data: Buffer.concat([fee, Buffer.alloc(Math.max(0, pump.FEE_CONFIG_CURRENT_SIZE - fee.length))]),
    });
    const wsol = Buffer.alloc(82);
    wsol[44] = 9;
    wsol[45] = 1;
    this.put(WSOL_MINT, { lamports: 1_000_000_000n, owner: TOKEN_PROGRAM_ID, data: wsol });
  }

  // ---- test controls -----------------------------------------------------------------------------

  put(key: PublicKey, acct: Acct): void {
    this.accounts.set(key.toBase58(), acct);
  }

  /** Give a wallet lamports out of thin air (no funding record). */
  airdrop(key: PublicKey, lamports: bigint): void {
    const a = this.accounts.get(key.toBase58());
    if (a) a.lamports += lamports;
    else this.put(key, { lamports, owner: SystemProgram.programId, data: Buffer.alloc(0) });
  }

  /** Empties an account (e.g. a sender that sent its whole balance). */
  drain(key: PublicKey): void {
    this.accounts.delete(key.toBase58());
  }

  /** A user wallet sends `lamports` to `to` (recorded as a funding transfer, block time = now). */
  fund(from: PublicKey, to: PublicKey, lamports: bigint, atMs = this.opts.now()): string {
    const signature = bs58.encode(randomBytes(64));
    this.airdrop(to, lamports);
    if (!this.accounts.has(from.toBase58())) this.airdrop(from, 1_000_000_000n);
    const list = this.fundings.get(to.toBase58()) ?? [];
    list.push({ source: from.toBase58(), lamports, signature, blockTime: Math.floor(atMs / 1000), slot: ++this.slot });
    this.fundings.set(to.toBase58(), list);
    return signature;
  }

  /** Registers an address lookup table (what `alt create` + `alt sync` would leave on-chain). */
  addLookupTable(key: PublicKey, addresses: PublicKey[]): void {
    this.tables.set(key.toBase58(), new AddressLookupTableAccount({ key, state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses } }));
  }

  inject(injection: Injection): void {
    this.injections.push(injection);
  }

  /** Resolves when the next "crash" injection has landed its transaction. */
  nextCrash(): Promise<void> {
    return new Promise((r) => this.crashWaiters.push(r));
  }

  count(kind: FakeTxKind, ok = true): number {
    return this.landed.filter((t) => t.kind === kind && t.ok === ok).length;
  }

  feesPaidBy(key: PublicKey): bigint {
    return this.landed.filter((t) => t.feePayer === key.toBase58()).reduce((s, t) => s + t.fee, 0n);
  }

  tokenBalance(owner: PublicKey, mint: PublicKey): bigint | null {
    const a = this.accounts.get(getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID).toBase58());
    return a?.token ? a.token.amount : null;
  }

  curve(mint: PublicKey): BondingCurve {
    const a = this.accounts.get(bondingCurvePda(mint).toBase58());
    if (!a) throw new Error("no curve");
    return PUMP_SDK.decodeBondingCurve({ data: a.data, owner: PUMP_PROGRAM_ID, lamports: 0, executable: false });
  }

  /** Another trader buys on the curve (moves the price). */
  snipe(mint: PublicKey, tokens: bigint, lamports: bigint): void {
    const key = bondingCurvePda(mint).toBase58();
    const a = this.accounts.get(key)!;
    const c = this.curve(mint);
    a.data = this.encodeCurve({
      ...c,
      virtualTokenReserves: c.virtualTokenReserves.sub(bn(tokens)),
      realTokenReserves: c.realTokenReserves.sub(bn(tokens)),
      virtualQuoteReserves: c.virtualQuoteReserves.add(bn(lamports)),
      realQuoteReserves: c.realQuoteReserves.add(bn(lamports)),
    });
    a.lamports += lamports;
  }

  // ---- LaunchChain -------------------------------------------------------------------------------

  async getBalance(address: PublicKey): Promise<bigint> {
    return this.accounts.get(address.toBase58())?.lamports ?? 0n;
  }

  async getBalances(addresses: readonly PublicKey[]): Promise<bigint[]> {
    return addresses.map((a) => this.accounts.get(a.toBase58())?.lamports ?? 0n);
  }

  async accountExists(address: PublicKey): Promise<boolean> {
    return this.accounts.has(address.toBase58());
  }

  async getAccountInfo(address: PublicKey): Promise<AccountSnapshot | null> {
    const a = this.accounts.get(address.toBase58());
    if (!a) return null;
    return { lamports: a.lamports, owner: a.owner.toBase58(), data: a.token ? this.tokenData(a) : Buffer.from(a.data) };
  }

  async getMinimumBalanceForRentExemption(dataLength: number): Promise<bigint> {
    return this.rent(dataLength);
  }

  async latestBlockhash(): Promise<RecentBlockhash> {
    this.height += 1;
    return { blockhash: bs58.encode(randomBytes(32)), lastValidBlockHeight: this.height + 150 };
  }

  async findFundingSender(address: PublicKey): Promise<FundingInfo | null> {
    return pickFunding(this.fundings.get(address.toBase58()) ?? []);
  }

  async getLookupTable(address: PublicKey): Promise<AddressLookupTableAccount | null> {
    return this.tables.get(address.toBase58()) ?? null;
  }

  /** Signatures, size and the instruction list of a legacy or v0 transaction. */
  private open(tx: Transaction | VersionedTransaction, signers: Signer[]): { signature: string; size: number; feePayer: string; signerKeys: Set<string>; instructions: TransactionInstruction[] } {
    if (tx instanceof VersionedTransaction) {
      tx.sign(signers);
      const msg = tx.message;
      const signature = bs58.encode(tx.signatures[0]!);
      const keys = msg.staticAccountKeys;
      const required = msg.header.numRequiredSignatures;
      const bytes = msg.serialize();
      for (let i = 0; i < required; i++) {
        const sig = tx.signatures[i]!;
        if (sig.every((b) => b === 0)) throw new TxError("missing signature", "rejected", signature);
        if (!ed25519Verify(bytes, sig, keys[i]!)) throw new TxError("signature verification failed", "rejected", signature);
      }
      const size = tx.serialize().length;
      if (size > PACKET_DATA_SIZE) throw new TxError(`transaction too large: ${size} bytes`, "rejected", signature);
      const tables = msg.addressTableLookups.map((l) => {
        const t = this.tables.get(l.accountKey.toBase58());
        if (!t) throw new TxError(`lookup table ${l.accountKey.toBase58()} not found`, "rejected", signature);
        return t;
      });
      const { instructions } = TransactionMessage.decompile(msg, { addressLookupTableAccounts: tables });
      return { signature, size, feePayer: keys[0]!.toBase58(), signerKeys: new Set(keys.slice(0, required).map((k) => k.toBase58())), instructions };
    }
    tx.sign(...signers);
    const signature = bs58.encode(tx.signature!);
    if (tx.signatures.some((s) => s.signature === null)) throw new TxError("missing signature", "rejected", signature);
    if (!tx.verifySignatures()) throw new TxError("signature verification failed", "rejected", signature);
    const size = tx.serialize().length;
    if (size > PACKET_DATA_SIZE) throw new TxError(`transaction too large: ${size} bytes`, "rejected", signature);
    return { signature, size, feePayer: tx.feePayer!.toBase58(), signerKeys: new Set(tx.signatures.map((s) => s.publicKey.toBase58())), instructions: tx.instructions };
  }

  async sendAndConfirm(tx: Transaction | VersionedTransaction, signers: Signer[], _lastValidBlockHeight?: number): Promise<string> {
    const { signature, size, feePayer, signerKeys, instructions } = this.open(tx, signers);
    const kind = classify(instructions);

    const injection = this.injections.find((i) => i.kind === kind && (i.times === undefined || i.times > 0));
    if (injection?.times !== undefined) injection.times -= 1;
    if (injection?.mode === "reject") throw new TxError(`injected rejection of ${kind}`, "rejected", signature);
    if (injection?.mode === "expire") throw new TxError(`injected expiry of ${kind}`, "expired", signature);

    const fee = this.fee(instructions, signerKeys.size);
    if (injection?.mode === "fail") {
      const payer = this.accounts.get(feePayer);
      if (!payer || payer.lamports < fee) throw new TxError("insufficient funds for fee", "rejected", signature);
      payer.lamports -= fee;
      this.landed.push({ kind, signature, feePayer, fee, size, ok: false, tx, instructions });
      throw new TxError(`injected failure of ${kind}`, "failed", signature);
    }

    // Execute on a copy; commit only if everything succeeds (preflight semantics: no fee on failure).
    const working = new Map<string, Acct>();
    for (const [k, v] of this.accounts) working.set(k, { ...v, data: Buffer.from(v.data), token: v.token ? { ...v.token } : undefined });
    const triggers = new Map<string, number>();
    try {
      const payer = working.get(feePayer);
      if (!payer || payer.lamports < fee) throw new ProgramError("insufficient funds for fee");
      payer.lamports -= fee;
      for (const ix of instructions) {
        for (const k of ix.keys) if (k.isSigner && !signerKeys.has(k.pubkey.toBase58())) throw new ProgramError(`missing signer ${k.pubkey.toBase58()}`);
        this.execute(working, ix, triggers);
      }
      for (const [key, a] of working) {
        const before = this.accounts.get(key);
        const changed = !before || before.lamports !== a.lamports || before.data.length !== a.data.length;
        if (changed && a.lamports > 0n && a.lamports < this.rent(this.dataLen(a))) throw new ProgramError(`insufficient funds for rent: ${key}`);
      }
    } catch (err) {
      if (err instanceof ProgramError) throw new TxError(`simulation failed: ${err.message}`, "rejected", signature);
      throw err;
    }
    this.accounts = new Map([...working].filter(([, a]) => a.lamports > 0n || a.data.length > 0));
    for (const [k, v] of triggers) this.vaultTriggers.set(k, v);
    this.landed.push({ kind, signature, feePayer, fee, size, ok: true, tx, instructions });

    if (injection?.mode === "crash") {
      this.crashes += 1;
      for (const w of this.crashWaiters.splice(0)) w();
      return new Promise<string>(() => {}); // the process "died" right after broadcasting
    }
    return signature;
  }

  // ---- execution ---------------------------------------------------------------------------------

  private fee(instructions: readonly TransactionInstruction[], signatures: number): bigint {
    let units = 200_000 * instructions.filter((i) => !i.programId.equals(ComputeBudgetProgram.programId)).length;
    let price = 0n;
    for (const ix of instructions) {
      if (!ix.programId.equals(ComputeBudgetProgram.programId)) continue;
      if (ix.data[0] === 2) units = ix.data.readUInt32LE(1);
      if (ix.data[0] === 3) price = ix.data.readBigUInt64LE(1);
    }
    return 5_000n * BigInt(signatures) + (price * BigInt(units) + 999_999n) / 1_000_000n;
  }

  private dataLen(a: Acct): number {
    return a.data.length;
  }

  private tokenData(a: Acct): Buffer {
    const data = Buffer.from(a.data);
    new PublicKey(a.token!.mint).toBuffer().copy(data, 0);
    new PublicKey(a.token!.owner).toBuffer().copy(data, 32);
    data.writeBigUInt64LE(a.token!.amount, 64);
    data[108] = 1;
    return data;
  }

  private encodeCurve(curve: BondingCurve): Buffer {
    return encodePumpAccount("bondingCurve", curve);
  }

  private execute(w: Map<string, Acct>, ix: TransactionInstruction, triggers: Map<string, number>): void {
    const program = ix.programId.toBase58();
    const get = (k: PublicKey) => w.get(k.toBase58());
    const debit = (k: PublicKey, lamports: bigint) => {
      const a = get(k);
      if (!a || a.lamports < lamports) throw new ProgramError(`insufficient lamports in ${k.toBase58()}`);
      a.lamports -= lamports;
    };
    const credit = (k: PublicKey, lamports: bigint) => {
      const a = get(k);
      if (a) a.lamports += lamports;
      else w.set(k.toBase58(), { lamports, owner: SystemProgram.programId, data: Buffer.alloc(0) });
    };
    const create = (k: PublicKey, size: number, owner: PublicKey, payer: PublicKey, token?: TokenState): Acct => {
      const existing = get(k);
      if (existing && (existing.data.length > 0 || !existing.owner.equals(SystemProgram.programId))) throw new ProgramError(`account ${k.toBase58()} already in use`);
      const rent = this.rent(size);
      const prefunded = existing?.lamports ?? 0n;
      if (rent > prefunded) debit(payer, rent - prefunded);
      const acct: Acct = { lamports: rent > prefunded ? rent : prefunded, owner, data: Buffer.alloc(size), token };
      w.set(k.toBase58(), acct);
      return acct;
    };
    const tokenAcct = (k: PublicKey): Acct & { token: TokenState } => {
      const a = get(k);
      if (!a?.token) throw new ProgramError(`not a token account: ${k.toBase58()}`);
      return a as Acct & { token: TokenState };
    };

    if (program === COMPUTE_BUDGET) return;

    if (program === SYSTEM) {
      if (ix.data.readUInt32LE(0) !== 2) throw new ProgramError("unsupported system instruction");
      const [from, to] = [ix.keys[0]!.pubkey, ix.keys[1]!.pubkey];
      const src = get(from);
      if (src && (src.data.length > 0 || !src.owner.equals(SystemProgram.programId))) throw new ProgramError("transfer from an account with data");
      const lamports = ix.data.readBigUInt64LE(4);
      debit(from, lamports);
      credit(to, lamports);
      return;
    }

    if (program === ATA) {
      const idempotent = ix.data.length > 0 && ix.data[0] === 1;
      const [payer, ata, owner, mint, , tokenProgram] = ix.keys.map((k) => k.pubkey) as PublicKey[];
      const expected = getAssociatedTokenAddressSync(mint!, owner!, true, tokenProgram!);
      if (!expected.equals(ata!)) throw new ProgramError("ATA address mismatch");
      if (!get(mint!)) throw new ProgramError(`mint ${mint!.toBase58()} does not exist`);
      const existing = get(ata!);
      if (existing?.token) {
        if (idempotent && existing.token.owner === owner!.toBase58() && existing.token.mint === mint!.toBase58()) return;
        throw new ProgramError("ATA already exists");
      }
      const size = tokenProgram!.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_ATA_SIZE : SPL_TOKEN_ACCOUNT_SIZE;
      create(ata!, size, tokenProgram!, payer!, { mint: mint!.toBase58(), owner: owner!.toBase58(), amount: 0n });
      return;
    }

    if (program === TOKEN || program === TOKEN22) {
      if (ix.data[0] === 12) {
        const [source, mint, dest, authority] = ix.keys.map((k) => k.pubkey) as PublicKey[];
        const amount = ix.data.readBigUInt64LE(1);
        const src = tokenAcct(source!);
        const dst = tokenAcct(dest!);
        if (src.token.owner !== authority!.toBase58()) throw new ProgramError("owner mismatch");
        if (src.token.mint !== mint!.toBase58() || dst.token.mint !== mint!.toBase58()) throw new ProgramError("mint mismatch");
        if (src.token.amount < amount) throw new ProgramError("insufficient token balance");
        src.token.amount -= amount;
        dst.token.amount += amount;
        return;
      }
      if (ix.data[0] === 9) {
        const [account, dest, authority] = ix.keys.map((k) => k.pubkey) as PublicKey[];
        const a = tokenAcct(account!);
        if (a.token.owner !== authority!.toBase58()) throw new ProgramError("owner mismatch");
        if (a.token.amount !== 0n) throw new ProgramError("non-native account can only be closed if its balance is zero");
        credit(dest!, a.lamports);
        w.delete(account!.toBase58());
        return;
      }
      throw new ProgramError(`unsupported token instruction ${ix.data[0]}`);
    }

    if (program === PUMP) {
      const decoded = pumpCoder.instruction.decode(Buffer.from(ix.data));
      if (!decoded) throw new ProgramError("unknown pump instruction");
      const def = (pump.pumpIdl as unknown as { instructions: { name: string; accounts: { name: string }[] }[] }).instructions.find((i) => i.name === decoded.name)!;
      const acc = Object.fromEntries(def.accounts.map((a, i) => [a.name, ix.keys[i]?.pubkey])) as Record<string, PublicKey>;
      const args = decoded.data as Record<string, unknown>;
      switch (decoded.name) {
        case "create_v2": {
          const mint = acc.mint!;
          const creator = args.creator as PublicKey;
          if (creator.equals(PublicKey.default)) throw new ProgramError("creator must be set");
          if (args.is_mayhem_mode) throw new ProgramError("mayhem mode not expected");
          if (!bondingCurvePda(mint).equals(acc.bonding_curve!)) throw new ProgramError("bonding curve PDA mismatch");
          const name = args.name as string;
          const symbol = args.symbol as string;
          const uri = args.uri as string;
          const mintAcct = create(mint, pumpMintSize(utf8Len(name), utf8Len(symbol), utf8Len(uri)), TOKEN_2022_PROGRAM_ID, acc.user!);
          mintAcct.data.writeBigUInt64LE(BigInt(this.global.tokenTotalSupply.toString()), 36);
          mintAcct.data[44] = 6;
          mintAcct.data[45] = 1;
          const curve = { ...pump.newBondingCurve(this.global), creator };
          const curveData = this.encodeCurve(curve);
          const c = create(acc.bonding_curve!, curveData.length, PUMP_PROGRAM_ID, acc.user!);
          c.data = curveData;
          const curveAta = getAssociatedTokenAddressSync(mint, acc.bonding_curve!, true, TOKEN_2022_PROGRAM_ID);
          if (!curveAta.equals(acc.associated_bonding_curve!)) throw new ProgramError("associated bonding curve mismatch");
          create(curveAta, TOKEN_2022_ATA_SIZE, TOKEN_2022_PROGRAM_ID, acc.user!, {
            mint: mint.toBase58(),
            owner: acc.bonding_curve!.toBase58(),
            amount: BigInt(this.global.tokenTotalSupply.toString()),
          });
          return;
        }
        case "buy_v3": {
          const mint = acc.base_mint!;
          const curveKey = acc.bonding_curve!;
          const curveAcct = get(curveKey);
          if (!curveAcct) throw new ProgramError("curve not found");
          const curve = PUMP_SDK.decodeBondingCurve({ data: curveAcct.data, owner: PUMP_PROGRAM_ID, lamports: 0, executable: false });
          const amount = BigInt((args.amount as BN).toString());
          const max = BigInt((args.max_sol_cost as BN).toString());
          const curveTokens = tokenAcct(acc.associated_base_bonding_curve!);
          const cost = BigInt(
            pump
              .getBuyV3QuoteAmountFromTokenAmount({
                global: this.global,
                feeConfig: this.feeConfig,
                mintSupply: this.global.tokenTotalSupply,
                bondingCurve: curve,
                amount: bn(amount),
                curveBaseTokenBalance: bn(curveTokens.token.amount),
              })
              .toString(),
          );
          if (cost > max) throw new ProgramError(`slippage: cost ${cost} > max ${max}`);
          if (!this.global.buybackFeeRecipients.some((k) => k.equals(acc.buyback_fee_recipient!))) throw new ProgramError("not a buyback fee recipient");
          const uva = pump.userVolumeAccumulatorPda(acc.user!);
          if (!uva.equals(acc.user_volume_accumulator!)) throw new ProgramError("volume accumulator PDA mismatch");
          if (!get(uva)) create(uva, PUMP_USER_VOLUME_ACCUMULATOR_SIZE, PUMP_PROGRAM_ID, acc.user!);
          debit(acc.user!, cost);
          curveAcct.lamports += cost;
          const userTokens = tokenAcct(acc.associated_base_user!);
          if (userTokens.token.owner !== acc.user!.toBase58() || userTokens.token.mint !== mint.toBase58()) throw new ProgramError("user token account mismatch");
          curveTokens.token.amount -= amount;
          userTokens.token.amount += amount;
          curveAcct.data = this.encodeCurve({
            ...curve,
            virtualTokenReserves: curve.virtualTokenReserves.sub(bn(amount)),
            realTokenReserves: curve.realTokenReserves.sub(bn(amount)),
            virtualQuoteReserves: curve.virtualQuoteReserves.add(bn(cost)),
            realQuoteReserves: curve.realQuoteReserves.add(bn(cost)),
          });
          return;
        }
        case "init_user_volume_accumulator": {
          const uva = pump.userVolumeAccumulatorPda(acc.user!);
          if (!uva.equals(acc.user_volume_accumulator!)) throw new ProgramError("volume accumulator PDA mismatch");
          create(uva, PUMP_USER_VOLUME_ACCUMULATOR_SIZE, PUMP_PROGRAM_ID, acc.payer!);
          return;
        }
        case "close_user_volume_accumulator": {
          const uva = pump.userVolumeAccumulatorPda(acc.user!);
          if (!uva.equals(acc.user_volume_accumulator!)) throw new ProgramError("volume accumulator PDA mismatch");
          const a = get(uva);
          if (!a) throw new ProgramError("volume accumulator not initialized");
          credit(acc.user!, a.lamports);
          w.delete(uva.toBase58());
          return;
        }
        default:
          throw new ProgramError(`unsupported pump instruction ${decoded.name}`);
      }
    }

    if (program === HOLDFAST) {
      const decoded = holdfastCoder.instruction.decode(Buffer.from(ix.data));
      if (decoded?.name !== "init_coin") throw new ProgramError(`unsupported holdfast instruction ${decoded?.name}`);
      const def = (HOLDFAST_IDL.instructions as unknown as { name: string; accounts: { name: string }[] }[]).find((i) => i.name === "init_coin")!;
      const acc = Object.fromEntries(def.accounts.map((a, i) => [a.name, ix.keys[i]?.pubkey])) as Record<string, PublicKey>;
      const trigger = (decoded.data as { trigger_bps: number }).trigger_bps;
      const mint = acc.mint!;
      if (!acc.launcher!.equals(this.opts.configLauncher)) throw new ProgramError("ConstraintHasOne: launcher");
      if (!acc.config!.equals(configPda())) throw new ProgramError("config PDA mismatch");
      if (![1500, 2500, 3500].includes(trigger)) throw new ProgramError("InvalidTrigger");
      if (!vaultPda(mint).equals(acc.vault!) || !treasuryPda(mint).equals(acc.treasury!)) throw new ProgramError("PDA mismatch");
      if (!bondingCurvePda(mint).equals(acc.bonding_curve!)) throw new ProgramError("bonding curve mismatch");
      const curveAcct = get(acc.bonding_curve!);
      if (!curveAcct || !curveAcct.owner.equals(PUMP_PROGRAM_ID)) throw new ProgramError("InvalidOwner: bonding curve");
      const curve = PUMP_SDK.decodeBondingCurve({ data: curveAcct.data, owner: PUMP_PROGRAM_ID, lamports: 0, executable: false });
      if (!curve.creator.equals(acc.treasury!)) throw new ProgramError("CreatorMismatch");
      create(acc.vault!, COIN_VAULT_SIZE, HOLDFAST_PROGRAM_ID, acc.launcher!);
      triggers.set(mint.toBase58(), trigger);
      const reserve = this.rent(0);
      const treasury = get(acc.treasury!)?.lamports ?? 0n;
      if (treasury < reserve) {
        debit(acc.launcher!, reserve - treasury);
        credit(acc.treasury!, reserve - treasury);
      }
      // The treasury's token accounts and volume accumulators come later (prepare_treasury).
      return;
    }

    throw new ProgramError(`unsupported program ${program}`);
  }
}

function discriminatorName(coder: BorshCoder, ix: TransactionInstruction): string | null {
  try {
    return coder.instruction.decode(Buffer.from(ix.data))?.name ?? null;
  } catch {
    return null;
  }
}

export function classify(instructions: readonly TransactionInstruction[]): FakeTxKind {
  const names = instructions.map((ix) => {
    if (ix.programId.equals(PUMP_PROGRAM_ID)) return discriminatorName(pumpCoder, ix);
    if (ix.programId.equals(HOLDFAST_PROGRAM_ID)) return discriminatorName(holdfastCoder, ix);
    return ix.programId.toBase58();
  });
  if (names.includes("create_v2") && names.includes("init_coin")) return "launch";
  if (names.includes("create_v2")) return "create";
  if (names.includes("init_coin")) return "init";
  if (names.includes("buy_v3")) return "devBuy";
  const transfersTokens = instructions.some((ix) => (ix.programId.equals(TOKEN_2022_PROGRAM_ID) || ix.programId.equals(TOKEN_PROGRAM_ID)) && ix.data[0] === 12);
  if (transfersTokens) return "deliver";
  if (names.every((n) => n === SYSTEM || n === COMPUTE_BUDGET)) return "refund";
  return "other";
}
