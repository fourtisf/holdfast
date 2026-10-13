/**
 * Holdfast vault program client: account decoders, event parsing and instruction builders, all driven
 * by the Anchor IDL in `idl/holdfast_vault.json` (copied from target/idl by `pnpm idl:sync`).
 */
import { createRequire } from "node:module";
import { BorshCoder, EventParser, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";

import { ASSOCIATED_TOKEN_PROGRAM_ID, HOLDFAST_PROGRAM_ID, PUMP_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from "./constants.js";
import { associatedTokenAddress, bondingCurvePda, configPda, roundPda, treasuryPda, vaultPda } from "./pda.js";

const require = createRequire(import.meta.url);
export const HOLDFAST_IDL = require("../idl/holdfast_vault.json") as Idl;
const coder = new BorshCoder(HOLDFAST_IDL);

const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

export const VENUE_CURVE = 0;
export const VENUE_AMM = 1;

// ---- accounts ------------------------------------------------------------------------------------

export interface CoinVaultAccount {
  mint: PublicKey;
  triggerBps: number;
  tokenProgram: PublicKey;
  venue: "curve" | "amm";
  bondingCurve: PublicKey;
  ammPool: PublicKey | null;
  ammPoolBaseAccount: PublicKey | null;
  ammPoolQuoteAccount: PublicKey | null;
  athPrice: bigint;
  floorPrice: bigint;
  floorSol: bigint;
  holderSol: bigint;
  burnSol: bigint;
  holderTokens: bigint;
  lastDefendTs: number;
  defendCount: bigint;
  hourWindowStart: number;
  hourWindowDefends: number;
  /** Timestamp of the newest TWAP observation (0 if none). */
  lastObservationTs: number;
  observationCount: number;
  roundId: bigint;
  roundOpen: boolean;
  lastRoundTs: number;
  totalFees: bigint;
  totalDefendedSol: bigint;
  totalTokensBought: bigint;
  totalPaidSol: bigint;
  totalPaidTokens: bigint;
  totalBurnSol: bigint;
  totalHoldBurned: bigint;
  createdAt: number;
}

export interface ConfigAccount {
  admin: PublicKey;
  keeper: PublicKey;
  launcher: PublicKey;
  holdMint: PublicKey | null;
  paused: boolean;
  params: {
    defendCooldownSecs: number;
    maxDefendsPerHour: number;
    defendPriceToleranceBps: number;
    twapWindowSecs: number;
    twapMinSampleIntervalSecs: number;
    twapMaxGapSecs: number;
    athConfirmSecs: number;
    maxBurnSlippageBps: number;
    minRoundIntervalSecs: number;
  };
}

export interface PayoutRoundAccount {
  vault: PublicKey;
  mint: PublicKey;
  roundId: bigint;
  payer: PublicKey;
  solPot: bigint;
  tokenPot: bigint;
  solPaid: bigint;
  tokenPaid: bigint;
  snapshotHash: Uint8Array;
  recipientCount: number;
  paidCount: number;
  openedAt: number;
  /** paid[i] = index i already paid. */
  isPaid: (index: number) => boolean;
}

type Raw = Record<string, unknown>;
const big = (v: unknown): bigint => BigInt((v as BN).toString());
const num = (v: unknown): number => Number((v as BN | number).toString());
const key = (v: unknown): PublicKey => v as PublicKey;
const optKey = (v: unknown): PublicKey | null => ((v as PublicKey).equals(PublicKey.default) ? null : (v as PublicKey));

function latestObservation(r: Raw): { lastObservationTs: number; observationCount: number } {
  const len = num(r.obs_len);
  if (len === 0) return { lastObservationTs: 0, observationCount: 0 };
  const observations = r.observations as { ts: BN }[];
  const head = num(r.obs_head);
  const idx = (head + observations.length - 1) % observations.length;
  return { lastObservationTs: num(observations[idx]!.ts), observationCount: len };
}

export function decodeCoinVault(data: Buffer): CoinVaultAccount {
  const r = coder.accounts.decode<Raw>("CoinVault", data);
  return {
    mint: key(r.mint),
    triggerBps: num(r.trigger_bps),
    tokenProgram: key(r.token_program),
    venue: num(r.venue) === VENUE_AMM ? "amm" : "curve",
    bondingCurve: key(r.bonding_curve),
    ammPool: optKey(r.amm_pool),
    ammPoolBaseAccount: optKey(r.amm_pool_base_account),
    ammPoolQuoteAccount: optKey(r.amm_pool_quote_account),
    athPrice: big(r.ath_price),
    floorPrice: big(r.floor_price),
    floorSol: big(r.floor_sol),
    holderSol: big(r.holder_sol),
    burnSol: big(r.burn_sol),
    holderTokens: big(r.holder_tokens),
    lastDefendTs: num(r.last_defend_ts),
    defendCount: big(r.defend_count),
    hourWindowStart: num(r.hour_window_start),
    hourWindowDefends: num(r.hour_window_defends),
    ...latestObservation(r),
    roundId: big(r.round_id),
    roundOpen: Boolean(r.round_open),
    lastRoundTs: num(r.last_round_ts),
    totalFees: big(r.total_fees),
    totalDefendedSol: big(r.total_defended_sol),
    totalTokensBought: big(r.total_tokens_bought),
    totalPaidSol: big(r.total_paid_sol),
    totalPaidTokens: big(r.total_paid_tokens),
    totalBurnSol: big(r.total_burn_sol),
    totalHoldBurned: big(r.total_hold_burned),
    createdAt: num(r.created_at),
  };
}

export function decodeConfig(data: Buffer): ConfigAccount {
  const r = coder.accounts.decode<Raw>("Config", data);
  const p = r.params as Raw;
  return {
    admin: key(r.admin),
    keeper: key(r.keeper),
    launcher: key(r.launcher),
    holdMint: optKey(r.hold_mint),
    paused: Boolean(r.paused),
    params: {
      defendCooldownSecs: num(p.defend_cooldown_secs),
      maxDefendsPerHour: num(p.max_defends_per_hour),
      defendPriceToleranceBps: num(p.defend_price_tolerance_bps),
      twapWindowSecs: num(p.twap_window_secs),
      twapMinSampleIntervalSecs: num(p.twap_min_sample_interval_secs),
      twapMaxGapSecs: num(p.twap_max_gap_secs),
      athConfirmSecs: num(p.ath_confirm_secs),
      maxBurnSlippageBps: num(p.max_burn_slippage_bps),
      minRoundIntervalSecs: num(p.min_round_interval_secs),
    },
  };
}

export function decodePayoutRound(data: Buffer): PayoutRoundAccount {
  const r = coder.accounts.decode<Raw>("PayoutRound", data);
  const bitmap = Uint8Array.from(r.paid_bitmap as number[] | Buffer);
  return {
    vault: key(r.vault),
    mint: key(r.mint),
    roundId: big(r.round_id),
    payer: key(r.payer),
    solPot: big(r.sol_pot),
    tokenPot: big(r.token_pot),
    solPaid: big(r.sol_paid),
    tokenPaid: big(r.token_paid),
    snapshotHash: Uint8Array.from(r.snapshot_hash as number[]),
    recipientCount: num(r.recipient_count),
    paidCount: num(r.paid_count),
    openedAt: num(r.opened_at),
    isPaid: (i: number) => ((bitmap[i >> 3] ?? 0) & (1 << (i & 7))) !== 0,
  };
}

// ---- events --------------------------------------------------------------------------------------

export type HoldfastEvent =
  | { name: "CoinInitialized"; mint: PublicKey; vault: PublicKey; treasury: PublicKey; triggerBps: number; bondingCurve: PublicKey; ts: number }
  | { name: "FeesCollected"; mint: PublicKey; amount: bigint; floor: bigint; holder: bigint; burn: bigint; unwrappedWsol: bigint; tokens: bigint; ts: number }
  | { name: "AthUpdated"; mint: PublicKey; twap: bigint; ath: bigint; floor: bigint; ts: number }
  | { name: "Graduated"; mint: PublicKey; pool: PublicKey; coinCreator: PublicKey; ts: number }
  | { name: "Defended"; mint: PublicKey; solSpent: bigint; tokensBought: bigint; spotPrice: bigint; floorPrice: bigint; venue: number; ts: number }
  | { name: "RoundOpened"; mint: PublicKey; roundId: bigint; solPot: bigint; tokenPot: bigint; snapshotHash: Uint8Array; recipientCount: number; ts: number }
  | { name: "PayoutBatch"; mint: PublicKey; roundId: bigint; recipients: number; sol: bigint; tokens: bigint; ts: number }
  | { name: "RoundClosed"; mint: PublicKey; roundId: bigint; solPaid: bigint; tokensPaid: bigint; ts: number }
  | { name: "HoldBurned"; mint: PublicKey; solSpent: bigint; holdBurned: bigint; ts: number };

function camel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function normalizeEvent(name: string, data: Raw): HoldfastEvent {
  const out: Raw = { name };
  for (const [k, v] of Object.entries(data)) {
    let value: unknown = v;
    if (BN.isBN(v)) {
      value = ["ts", "trigger_bps", "recipient_count", "recipients", "venue"].includes(k) ? Number(v.toString()) : BigInt(v.toString());
    } else if (Array.isArray(v)) {
      value = Uint8Array.from(v as number[]);
    }
    out[camel(k)] = value;
  }
  return out as unknown as HoldfastEvent;
}

/** Parses Holdfast events from a transaction's log messages (`Program data:` lines of our program). */
export function parseHoldfastEvents(logs: readonly string[], programId: PublicKey = HOLDFAST_PROGRAM_ID): HoldfastEvent[] {
  const parser = new EventParser(programId, coder);
  const events: HoldfastEvent[] = [];
  for (const ev of parser.parseLogs([...logs])) events.push(normalizeEvent(ev.name, ev.data as Raw));
  return events;
}

/** Encodes an event the way the program logs it (`Program data: <base64>`), for tests and fixtures. */
export function encodeHoldfastEventLog(name: HoldfastEvent["name"], data: Record<string, unknown>): string {
  const layout = (coder.events as unknown as { layouts: Map<string, { discriminator: number[]; layout: { encode: (v: unknown, b: Buffer) => number } }> }).layouts.get(name);
  if (!layout) throw new Error(`unknown event ${name}`);
  const buf = Buffer.alloc(2048);
  const len = layout.layout.encode(data, buf);
  return `Program data: ${Buffer.concat([Buffer.from(layout.discriminator), buf.subarray(0, len)]).toString("base64")}`;
}

// ---- instructions --------------------------------------------------------------------------------

interface IdlAccountItem {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
}

/** Builds an instruction from the IDL account order; optional accounts left out are passed as the program id. */
function buildIx(
  name: string,
  accounts: Record<string, PublicKey | null | undefined>,
  args: Record<string, unknown>,
  remaining: AccountMeta[] = [],
  programId: PublicKey = HOLDFAST_PROGRAM_ID,
): TransactionInstruction {
  const ix = (HOLDFAST_IDL.instructions as unknown as { name: string; accounts: IdlAccountItem[] }[]).find((i) => i.name === name);
  if (!ix) throw new Error(`unknown instruction ${name}`);
  const keys: AccountMeta[] = ix.accounts.map((a) => {
    const pubkey = accounts[camel(a.name)];
    if (!pubkey) {
      if (a.optional) return { pubkey: programId, isSigner: false, isWritable: false };
      throw new Error(`${name}: missing account ${a.name}`);
    }
    return { pubkey, isSigner: Boolean(a.signer), isWritable: Boolean(a.writable) };
  });
  const data = coder.instruction.encode(name, args);
  return new TransactionInstruction({ programId, keys: [...keys, ...remaining], data });
}

const bn = (v: bigint | number) => new BN(v.toString());

export interface CoinKeys {
  mint: PublicKey;
  vault: PublicKey;
  treasury: PublicKey;
  treasuryTokenAccount: PublicKey;
  treasuryWsolAccount: PublicKey;
  bondingCurve: PublicKey;
  tokenProgram: PublicKey;
}

export function coinKeys(mint: PublicKey, tokenProgram: PublicKey = TOKEN_2022_PROGRAM_ID, programId: PublicKey = HOLDFAST_PROGRAM_ID): CoinKeys {
  const treasury = treasuryPda(mint, programId);
  return {
    mint,
    vault: vaultPda(mint, programId),
    treasury,
    treasuryTokenAccount: associatedTokenAddress(treasury, mint, tokenProgram),
    treasuryWsolAccount: associatedTokenAddress(treasury, WSOL_MINT, TOKEN_PROGRAM_ID),
    bondingCurve: bondingCurvePda(mint),
    tokenProgram,
  };
}

const commonPrograms = {
  wsolMint: WSOL_MINT,
  wsolTokenProgram: TOKEN_PROGRAM_ID,
  associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  systemProgram: SYSTEM_PROGRAM_ID,
};

export function initCoinIx(coin: CoinKeys, launcher: PublicKey, triggerBps: number): TransactionInstruction {
  return buildIx(
    "init_coin",
    {
      launcher,
      config: configPda(),
      mint: coin.mint,
      vault: coin.vault,
      treasury: coin.treasury,
      bondingCurve: coin.bondingCurve,
      treasuryTokenAccount: coin.treasuryTokenAccount,
      treasuryWsolAccount: coin.treasuryWsolAccount,
      tokenProgram: coin.tokenProgram,
      ...commonPrograms,
    },
    { trigger_bps: triggerBps },
  );
}

export function collectFeesIx(coin: CoinKeys): TransactionInstruction {
  return buildIx(
    "collect_fees",
    {
      vault: coin.vault,
      treasury: coin.treasury,
      treasuryWsolAccount: coin.treasuryWsolAccount,
      mint: coin.mint,
      treasuryTokenAccount: coin.treasuryTokenAccount,
      tokenProgram: coin.tokenProgram,
      ...commonPrograms,
    },
    {},
  );
}

/** Price accounts of the coin's venue: the bonding curve, or the pool + its two token accounts. */
export interface PriceAccounts {
  priceAccount: PublicKey;
  poolBaseAccount?: PublicKey | null;
  poolQuoteAccount?: PublicKey | null;
}

export function updateAthIx(coin: CoinKeys, keeper: PublicKey, price: PriceAccounts): TransactionInstruction {
  return buildIx("update_ath", { keeper, config: configPda(), vault: coin.vault, ...price }, {});
}

export function graduateIx(coin: CoinKeys, pool: PublicKey): TransactionInstruction {
  return buildIx("graduate", { vault: coin.vault, bondingCurve: coin.bondingCurve, pool }, {});
}

/** `venueAccounts`: pump `buy_exact_sol_in` / PumpSwap `buy_exact_quote_in` accounts with `user = treasury`. */
export function defendIx(coin: CoinKeys, caller: PublicKey, price: PriceAccounts, venueAccounts: AccountMeta[], minTokensOut: bigint = 0n): TransactionInstruction {
  return buildIx(
    "defend",
    {
      caller,
      config: configPda(),
      vault: coin.vault,
      treasury: coin.treasury,
      mint: coin.mint,
      treasuryTokenAccount: coin.treasuryTokenAccount,
      treasuryWsolAccount: coin.treasuryWsolAccount,
      tokenProgram: coin.tokenProgram,
      ...price,
      ...commonPrograms,
    },
    { min_tokens_out: bn(minTokensOut) },
    venueAccounts.map((a) => ({ ...a, isSigner: false })),
  );
}

export function openRoundIx(
  coin: CoinKeys,
  keeper: PublicKey,
  roundId: bigint,
  solPot: bigint,
  tokenPot: bigint,
  snapshotHash: Uint8Array,
  recipientCount: number,
): TransactionInstruction {
  if (snapshotHash.length !== 32) throw new Error("snapshot hash must be 32 bytes");
  return buildIx(
    "open_round",
    { keeper, config: configPda(), vault: coin.vault, round: roundPda(coin.mint, roundId), systemProgram: SYSTEM_PROGRAM_ID },
    { round_id: bn(roundId), sol_pot: bn(solPot), token_pot: bn(tokenPot), snapshot_hash: Array.from(snapshotHash), recipient_count: recipientCount },
  );
}

export interface PayoutIxEntry {
  index: number;
  wallet: PublicKey;
  sol: bigint;
  tokens: bigint;
  /** Required when tokens > 0. */
  tokenAccount?: PublicKey;
}

export function payoutIx(coin: CoinKeys, keeper: PublicKey, roundId: bigint, entries: PayoutIxEntry[]): TransactionInstruction {
  const remaining: AccountMeta[] = [];
  for (const e of entries) {
    remaining.push({ pubkey: e.wallet, isSigner: false, isWritable: true });
    if (e.tokens > 0n) {
      if (!e.tokenAccount) throw new Error(`entry ${e.index}: token payout needs a token account`);
      remaining.push({ pubkey: e.tokenAccount, isSigner: false, isWritable: true });
    }
  }
  return buildIx(
    "payout",
    {
      keeper,
      config: configPda(),
      vault: coin.vault,
      round: roundPda(coin.mint, roundId),
      treasury: coin.treasury,
      mint: coin.mint,
      treasuryTokenAccount: coin.treasuryTokenAccount,
      tokenProgram: coin.tokenProgram,
      systemProgram: SYSTEM_PROGRAM_ID,
    },
    { round_id: bn(roundId), entries: entries.map((e) => ({ index: e.index, sol: bn(e.sol), tokens: bn(e.tokens) })) },
    remaining,
  );
}

export function closeRoundIx(coin: CoinKeys, keeper: PublicKey, roundId: bigint, rentReceiver: PublicKey = keeper): TransactionInstruction {
  return buildIx(
    "close_round",
    { keeper, config: configPda(), vault: coin.vault, round: roundPda(coin.mint, roundId), rentReceiver },
    { round_id: bn(roundId) },
  );
}

export function burnHoldIx(
  coin: CoinKeys,
  keeper: PublicKey,
  holdMint: PublicKey,
  holdTokenProgram: PublicKey,
  venue: number,
  price: { holdPriceAccount: PublicKey; poolBaseAccount?: PublicKey | null; poolQuoteAccount?: PublicKey | null },
  venueAccounts: AccountMeta[],
  minHoldOut: bigint,
): TransactionInstruction {
  return buildIx(
    "burn_hold",
    {
      keeper,
      config: configPda(),
      vault: coin.vault,
      treasury: coin.treasury,
      holdMint,
      treasuryHoldAccount: associatedTokenAddress(coin.treasury, holdMint, holdTokenProgram),
      treasuryWsolAccount: coin.treasuryWsolAccount,
      holdTokenProgram,
      ...price,
      ...commonPrograms,
    },
    { venue, min_hold_out: bn(minHoldOut) },
    venueAccounts.map((a) => ({ ...a, isSigner: false })),
  );
}

/** The creator pubkey a Holdfast coin must be created with on pump.fun. */
export function pumpCreatorFor(mint: PublicKey): PublicKey {
  return treasuryPda(mint);
}

export { PUMP_PROGRAM_ID };
