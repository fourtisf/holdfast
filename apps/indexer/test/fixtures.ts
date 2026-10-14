import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { pino } from "pino";
import {
  associatedTokenAddress,
  bondingCurvePda,
  canonicalPoolPda,
  emitCpiData,
  encodeHoldfastEventLog,
  encodePumpEvent,
  HOLDFAST_PROGRAM_ID,
  parseHoldfastEvents,
  programDataLog,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  treasuryPda,
  vaultPda,
} from "@holdfast/chain";
import { createPgliteDb, migrate, type Db } from "@holdfast/db";
import { MemoryPublisher, processTransaction, type ProcessDeps, type ProcessResult } from "../src/index.js";
import type { ParsedTx, TokenBalance, TxInstruction } from "../src/tx.js";

export const PUMP = PUMP_PROGRAM_ID.toBase58();
export const AMM = PUMP_AMM_PROGRAM_ID.toBase58();
export const HOLDFAST = HOLDFAST_PROGRAM_ID.toBase58();
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58();

export const wallet = () => Keypair.generate().publicKey.toBase58();

export interface CoinFixture {
  mint: string;
  vault: string;
  treasury: string;
  bondingCurve: string;
  pool: string;
  ata(owner: string): string;
}

export function coinFixture(): CoinFixture {
  const mint = Keypair.generate().publicKey;
  return {
    mint: mint.toBase58(),
    vault: vaultPda(mint).toBase58(),
    treasury: treasuryPda(mint).toBase58(),
    bondingCurve: bondingCurvePda(mint).toBase58(),
    pool: canonicalPoolPda(mint).toBase58(),
    ata: (owner: string) => associatedTokenAddress(new PublicKey(owner), mint, TOKEN_2022_PROGRAM_ID).toBase58(),
  };
}

let sigCounter = 0;
export function sig(): string {
  sigCounter++;
  return Keypair.generate().publicKey.toBase58() + Keypair.generate().publicKey.toBase58().slice(0, 20) + String(sigCounter);
}

const bn = (v: bigint | number) => new BN(v.toString());
const pk = (v: string) => new PublicKey(v);

/** Builds a ParsedTx the way an RPC node would report it. */
export class TxBuilder {
  private readonly instructions: TxInstruction[] = [];
  private readonly inner: { index: number; instructions: TxInstruction[] }[] = [];
  private readonly logs: string[] = [];
  private readonly pre: Omit<TokenBalance, "accountIndex">[] = [];
  private readonly post: Omit<TokenBalance, "accountIndex">[] = [];
  readonly signature = sig();

  constructor(
    private readonly slot: number,
    private readonly blockTimeSec: number,
    private readonly signer: string,
  ) {}

  private topLevel(programId: string, events: Uint8Array[], viaLogs = false): this {
    const index = this.instructions.length;
    this.instructions.push({ programId, accounts: [], data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) });
    this.logs.push(`Program ${programId} invoke [1]`);
    if (viaLogs) {
      for (const e of events) this.logs.push(programDataLog(e));
    } else if (events.length) {
      this.inner.push({ index, instructions: events.map((e) => ({ programId, accounts: [], data: emitCpiData(e) })) });
      for (let i = 0; i < events.length; i++) this.logs.push(`Program ${programId} invoke [2]`, `Program ${programId} success`);
    }
    this.logs.push(`Program ${programId} success`);
    return this;
  }

  /** pump bonding-curve TradeEvent (emit_cpi unless `viaLogs`). */
  curveTrade(t: { mint: string; user: string; isBuy: boolean; sol: bigint; tokens: bigint; vSol?: bigint; vTok?: bigint; viaLogs?: boolean }): this {
    const e = encodePumpEvent("pump", "TradeEvent", {
      mint: t.mint,
      user: t.user,
      is_buy: t.isBuy,
      sol_amount: t.sol,
      token_amount: t.tokens,
      timestamp: this.blockTimeSec,
      virtual_sol_reserves: t.vSol ?? 30_000_000_000n,
      virtual_token_reserves: t.vTok ?? 1_073_000_000_000_000n,
      ix_name: t.isBuy ? "buy" : "sell",
    });
    return this.topLevel(PUMP, [e], t.viaLogs);
  }

  pumpEvents(events: { name: string; fields: Record<string, unknown> }[]): this {
    return this.topLevel(PUMP, events.map((e) => encodePumpEvent("pump", e.name, e.fields)));
  }

  ammTrade(t: { pool: string; user: string; isBuy: boolean; sol: bigint; tokens: bigint; baseReserves?: bigint; quoteReserves?: bigint; virtualQuote?: bigint }): this {
    const common = {
      pool: t.pool,
      user: t.user,
      timestamp: this.blockTimeSec,
      pool_base_token_reserves: t.baseReserves ?? 200_000_000_000_000n,
      pool_quote_token_reserves: t.quoteReserves ?? 85_000_000_000n,
      virtual_quote_reserves: t.virtualQuote ?? 0n,
    };
    const e = t.isBuy
      ? encodePumpEvent("pump_amm", "BuyEvent", { ...common, base_amount_out: t.tokens, quote_amount_in: t.sol, quote_amount_in_with_lp_fee: t.sol, user_quote_amount_in: t.sol, ix_name: "buy" })
      : encodePumpEvent("pump_amm", "SellEvent", { ...common, base_amount_in: t.tokens, quote_amount_out: t.sol, quote_amount_out_without_lp_fee: t.sol, user_quote_amount_out: t.sol });
    return this.topLevel(AMM, [e]);
  }

  /** Holdfast vault events, logged with `emit!` like the real program. */
  holdfast(events: { name: Parameters<typeof encodeHoldfastEventLog>[0]; fields: Record<string, unknown> }[]): this {
    this.instructions.push({ programId: HOLDFAST, accounts: [], data: new Uint8Array(8) });
    this.logs.push(`Program ${HOLDFAST} invoke [1]`);
    for (const e of events) this.logs.push(encodeHoldfastEventLog(e.name, e.fields));
    this.logs.push(`Program ${HOLDFAST} success`);
    return this;
  }

  /** A token account of `mint` going from `pre` to `post` (null = did not exist / closed). */
  balance(mint: string, account: string, owner: string, pre: bigint | null, post: bigint | null): this {
    if (pre !== null) this.pre.push({ account, mint, owner, amount: pre, decimals: 6 });
    if (post !== null) this.post.push({ account, mint, owner, amount: post, decimals: 6 });
    return this;
  }

  build(): ParsedTx {
    const keys = [this.signer];
    const index = (k: string) => {
      let i = keys.indexOf(k);
      if (i < 0) i = keys.push(k) - 1;
      return i;
    };
    for (const ix of this.instructions) index(ix.programId);
    const pre = this.pre.map((b) => ({ ...b, accountIndex: index(b.account) }));
    const post = this.post.map((b) => ({ ...b, accountIndex: index(b.account) }));
    return {
      signature: this.signature,
      slot: this.slot,
      blockTime: this.blockTimeSec * 1000,
      err: null,
      accountKeys: keys,
      signers: [this.signer],
      logMessages: this.logs,
      instructions: this.instructions,
      innerInstructions: this.inner,
      preTokenBalances: pre,
      postTokenBalances: post,
      preBalances: keys.map(() => 1_000_000_000n),
      postBalances: keys.map(() => 1_000_000_000n),
    };
  }
}

export const holdfastFields = {
  coinInitialized: (c: CoinFixture, ts: number, triggerBps = 2500) => ({
    mint: pk(c.mint),
    vault: pk(c.vault),
    treasury: pk(c.treasury),
    trigger_bps: triggerBps,
    bonding_curve: pk(c.bondingCurve),
    ts: bn(ts),
  }),
  treasuryPrepared: (c: CoinFixture, rentPaid: bigint, ts: number) => ({
    mint: pk(c.mint),
    rent_paid: bn(rentPaid),
    token_account: true,
    wsol_account: true,
    volume_accumulator_program: pk("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
    ts: bn(ts),
  }),
  feesCollected: (c: CoinFixture, amount: bigint, ts: number, tokens = 0n) => ({
    mint: pk(c.mint),
    amount: bn(amount),
    floor: bn((amount * 6n) / 10n),
    holder: bn((amount * 3n) / 10n),
    burn: bn(amount - (amount * 6n) / 10n - (amount * 3n) / 10n),
    unwrapped_wsol: bn(0),
    tokens: bn(tokens),
    ts: bn(ts),
  }),
  athUpdated: (c: CoinFixture, ath: bigint, floor: bigint, ts: number) => ({ mint: pk(c.mint), twap: bn(ath), ath: bn(ath), floor: bn(floor), ts: bn(ts) }),
  defended: (c: CoinFixture, sol: bigint, tokens: bigint, ts: number) => ({
    mint: pk(c.mint),
    sol_spent: bn(sol),
    tokens_bought: bn(tokens),
    spot_price: bn(1),
    floor_price: bn(2),
    venue: 0,
    ts: bn(ts),
  }),
  roundOpened: (c: CoinFixture, roundId: bigint, ts: number) => ({
    mint: pk(c.mint),
    round_id: bn(roundId),
    sol_pot: bn(1000),
    token_pot: bn(0),
    snapshot_hash: Array.from({ length: 32 }, () => 0),
    recipient_count: 1,
    ts: bn(ts),
  }),
  payoutBatch: (c: CoinFixture, roundId: bigint, sol: bigint, ts: number) => ({
    mint: pk(c.mint),
    round_id: bn(roundId),
    recipients: 1,
    sol: bn(sol),
    tokens: bn(0),
    ts: bn(ts),
  }),
  roundClosed: (c: CoinFixture, roundId: bigint, ts: number) => ({ mint: pk(c.mint), round_id: bn(roundId), sol_paid: bn(1000), tokens_paid: bn(0), ts: bn(ts) }),
};

export const silentLog = pino({ level: "silent" });

export interface Harness {
  db: Db;
  publisher: MemoryPublisher;
  deps: ProcessDeps;
  run(tx: ParsedTx): Promise<ProcessResult>;
}

export async function harness(overrides: Partial<ProcessDeps> = {}): Promise<Harness> {
  const db = await createPgliteDb();
  await migrate(db);
  const publisher = new MemoryPublisher();
  const deps: ProcessDeps = {
    db,
    log: silentLog,
    holdfastProgramId: HOLDFAST,
    parseHoldfastEvents: (logs) => parseHoldfastEvents(logs),
    publisher,
    reductionOrder: "fifo",
    ...overrides,
  };
  return { db, publisher, deps, run: (tx) => processTransaction(tx, deps) };
}

/** Launch tx: create + init_coin + dev buy by the launcher, tokens forwarded to the depositor. */
export function launchTx(c: CoinFixture, opts: { launcher: string; depositor: string; slot: number; ts: number; devBuy: bigint }): ParsedTx {
  return new TxBuilder(opts.slot, opts.ts, opts.launcher)
    .pumpEvents([
      {
        name: "CreateEvent",
        fields: { name: "Dog Coin", symbol: "DOG", uri: "https://meta/dog.json", mint: c.mint, bonding_curve: c.bondingCurve, user: opts.launcher, creator: c.treasury, timestamp: opts.ts, token_program: TOKEN_2022 },
      },
    ])
    .holdfast([{ name: "CoinInitialized", fields: holdfastFields.coinInitialized(c, opts.ts) }])
    .curveTrade({ mint: c.mint, user: opts.launcher, isBuy: true, sol: 100_000_000n, tokens: opts.devBuy })
    .balance(c.mint, c.ata(c.bondingCurve), c.bondingCurve, null, 1_000_000_000_000_000n - opts.devBuy)
    .balance(c.mint, c.ata(opts.launcher), opts.launcher, null, 0n)
    .balance(c.mint, c.ata(opts.depositor), opts.depositor, null, opts.devBuy)
    .build();
}
