import type BN from "bn.js";
import type { PublicKey } from "@solana/web3.js";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "../constants.js";
import { coderFor, EVENT_IX_TAG_LE, type PumpProgram } from "./idl.js";

/**
 * Normalized pump.fun (bonding curve) and PumpSwap events. Amounts are bigint (lamports / token
 * base units), addresses base58, timestamps unix seconds as emitted on-chain.
 */

/** pump `TradeEvent`: one bonding-curve buy or sell. Reserves are the curve state after the trade. */
export interface CurveTradeEvent {
  type: "curve_trade";
  mint: string;
  user: string;
  isBuy: boolean;
  /** SOL into (buy) / out of (sell) the curve, excluding fees. */
  solAmount: bigint;
  tokenAmount: bigint;
  timestamp: number;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  fee: bigint;
  creator: string;
  creatorFee: bigint;
  ixName: string;
  quoteMint: string;
}

/** pump `PostCompleteBuyEvent`: the pool-priced part of a curve-completing v3 buy (synthetic migration). */
export interface PostCompleteBuyEvent {
  type: "post_complete_buy";
  mint: string;
  user: string;
  bondingCurve: string;
  baseOut: bigint;
  quoteIn: bigint;
  fee: bigint;
  creatorFee: bigint;
  timestamp: number;
  poolBaseReservesAfter: bigint;
  poolQuoteReservesAfter: bigint;
}

export interface CurveCreateEvent {
  type: "create";
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  user: string;
  creator: string;
  timestamp: number;
  tokenProgram: string;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  quoteMint: string;
}

export interface CurveCompleteEvent {
  type: "complete";
  user: string;
  mint: string;
  bondingCurve: string;
  timestamp: number;
}

export interface MigrationEvent {
  type: "migration";
  user: string;
  mint: string;
  mintAmount: bigint;
  solAmount: bigint;
  poolMigrationFee: bigint;
  bondingCurve: string;
  pool: string;
  timestamp: number;
}

/**
 * PumpSwap `BuyEvent`. `poolBaseTokenReserves` / `poolQuoteTokenReserves` are the vault balances the
 * trade was priced on (before it); `virtualQuoteReserves` is signed (see PumpSwap docs).
 */
export interface AmmBuyEvent {
  type: "amm_buy";
  pool: string;
  user: string;
  timestamp: number;
  baseAmountOut: bigint;
  /** Quote into the pool excluding all fees: the trade price basis. */
  quoteAmountIn: bigint;
  quoteAmountInWithLpFee: bigint;
  /** What the user paid, all fees included. */
  userQuoteAmountIn: bigint;
  lpFee: bigint;
  protocolFee: bigint;
  coinCreatorFee: bigint;
  poolBaseTokenReserves: bigint;
  poolQuoteTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  coinCreator: string;
  userBaseTokenAccount: string;
  ixName: string;
}

export interface AmmSellEvent {
  type: "amm_sell";
  pool: string;
  user: string;
  timestamp: number;
  baseAmountIn: bigint;
  /** Quote out of the curve before fees: the trade price basis. */
  quoteAmountOut: bigint;
  quoteAmountOutWithoutLpFee: bigint;
  /** What the user received after all fees. */
  userQuoteAmountOut: bigint;
  lpFee: bigint;
  protocolFee: bigint;
  coinCreatorFee: bigint;
  poolBaseTokenReserves: bigint;
  poolQuoteTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  coinCreator: string;
  userBaseTokenAccount: string;
}

export interface AmmCreatePoolEvent {
  type: "amm_create_pool";
  pool: string;
  creator: string;
  baseMint: string;
  quoteMint: string;
  coinCreator: string;
  baseAmountIn: bigint;
  quoteAmountIn: bigint;
  timestamp: number;
}

export type PumpEvent =
  | CurveTradeEvent
  | PostCompleteBuyEvent
  | CurveCreateEvent
  | CurveCompleteEvent
  | MigrationEvent
  | AmmBuyEvent
  | AmmSellEvent
  | AmmCreatePoolEvent;

export interface DecodedPumpEvent {
  event: PumpEvent;
  program: PumpProgram;
  /** `cpi` = anchor emit_cpi inner instruction, `log` = `Program data:` log line. */
  source: "cpi" | "log";
  /** Position among the decoded pump events of the transaction. */
  index: number;
  /** Top-level instruction the event belongs to (cpi events only). */
  outerIndex: number | null;
}

// ---- field conversion ------------------------------------------------------------------------

type Raw = Record<string, unknown>;

const big = (v: unknown): bigint => {
  if (v === undefined || v === null) return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  return BigInt((v as BN).toString());
};
const key = (v: unknown): string => (v ? (v as PublicKey).toBase58() : "11111111111111111111111111111111");
const int = (v: unknown): number => Number(big(v));
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function normalize(program: PumpProgram, name: string, d: Raw): PumpEvent | null {
  if (program === "pump") {
    switch (name) {
      case "TradeEvent":
        return {
          type: "curve_trade",
          mint: key(d.mint),
          user: key(d.user),
          isBuy: Boolean(d.is_buy),
          solAmount: big(d.sol_amount),
          tokenAmount: big(d.token_amount),
          timestamp: int(d.timestamp),
          virtualSolReserves: big(d.virtual_sol_reserves),
          virtualTokenReserves: big(d.virtual_token_reserves),
          realSolReserves: big(d.real_sol_reserves),
          realTokenReserves: big(d.real_token_reserves),
          fee: big(d.fee),
          creator: key(d.creator),
          creatorFee: big(d.creator_fee),
          ixName: str(d.ix_name),
          quoteMint: key(d.quote_mint),
        };
      case "PostCompleteBuyEvent":
        return {
          type: "post_complete_buy",
          mint: key(d.mint),
          user: key(d.user),
          bondingCurve: key(d.bonding_curve),
          baseOut: big(d.base_out),
          quoteIn: big(d.quote_in),
          fee: big(d.fee),
          creatorFee: big(d.creator_fee),
          timestamp: int(d.timestamp),
          poolBaseReservesAfter: big(d.pool_base_reserves_after),
          poolQuoteReservesAfter: big(d.pool_quote_reserves_after),
        };
      case "CreateEvent":
        return {
          type: "create",
          name: str(d.name),
          symbol: str(d.symbol),
          uri: str(d.uri),
          mint: key(d.mint),
          bondingCurve: key(d.bonding_curve),
          user: key(d.user),
          creator: key(d.creator),
          timestamp: int(d.timestamp),
          tokenProgram: key(d.token_program),
          virtualTokenReserves: big(d.virtual_token_reserves),
          virtualSolReserves: big(d.virtual_sol_reserves),
          realTokenReserves: big(d.real_token_reserves),
          tokenTotalSupply: big(d.token_total_supply),
          quoteMint: key(d.quote_mint),
        };
      case "CompleteEvent":
        return { type: "complete", user: key(d.user), mint: key(d.mint), bondingCurve: key(d.bonding_curve), timestamp: int(d.timestamp) };
      case "CompletePumpAmmMigrationEvent":
        return {
          type: "migration",
          user: key(d.user),
          mint: key(d.mint),
          mintAmount: big(d.mint_amount),
          solAmount: big(d.sol_amount),
          poolMigrationFee: big(d.pool_migration_fee),
          bondingCurve: key(d.bonding_curve),
          pool: key(d.pool),
          timestamp: int(d.timestamp),
        };
      default:
        return null;
    }
  }
  switch (name) {
    case "BuyEvent":
      return {
        type: "amm_buy",
        pool: key(d.pool),
        user: key(d.user),
        timestamp: int(d.timestamp),
        baseAmountOut: big(d.base_amount_out),
        quoteAmountIn: big(d.quote_amount_in),
        quoteAmountInWithLpFee: big(d.quote_amount_in_with_lp_fee),
        userQuoteAmountIn: big(d.user_quote_amount_in),
        lpFee: big(d.lp_fee),
        protocolFee: big(d.protocol_fee),
        coinCreatorFee: big(d.coin_creator_fee),
        poolBaseTokenReserves: big(d.pool_base_token_reserves),
        poolQuoteTokenReserves: big(d.pool_quote_token_reserves),
        virtualQuoteReserves: big(d.virtual_quote_reserves),
        coinCreator: key(d.coin_creator),
        userBaseTokenAccount: key(d.user_base_token_account),
        ixName: str(d.ix_name),
      };
    case "SellEvent":
      return {
        type: "amm_sell",
        pool: key(d.pool),
        user: key(d.user),
        timestamp: int(d.timestamp),
        baseAmountIn: big(d.base_amount_in),
        quoteAmountOut: big(d.quote_amount_out),
        quoteAmountOutWithoutLpFee: big(d.quote_amount_out_without_lp_fee),
        userQuoteAmountOut: big(d.user_quote_amount_out),
        lpFee: big(d.lp_fee),
        protocolFee: big(d.protocol_fee),
        coinCreatorFee: big(d.coin_creator_fee),
        poolBaseTokenReserves: big(d.pool_base_token_reserves),
        poolQuoteTokenReserves: big(d.pool_quote_token_reserves),
        virtualQuoteReserves: big(d.virtual_quote_reserves),
        coinCreator: key(d.coin_creator),
        userBaseTokenAccount: key(d.user_base_token_account),
      };
    case "CreatePoolEvent":
      return {
        type: "amm_create_pool",
        pool: key(d.pool),
        creator: key(d.creator),
        baseMint: key(d.base_mint),
        quoteMint: key(d.quote_mint),
        coinCreator: key(d.coin_creator),
        baseAmountIn: big(d.base_amount_in),
        quoteAmountIn: big(d.quote_amount_in),
        timestamp: int(d.timestamp),
      };
    default:
      return null;
  }
}

// ---- decoding ------------------------------------------------------------------------------------

const PROGRAMS: Record<string, PumpProgram> = {
  [PUMP_PROGRAM_ID.toBase58()]: "pump",
  [PUMP_AMM_PROGRAM_ID.toBase58()]: "pump_amm",
};

export function pumpProgramOf(programId: string): PumpProgram | null {
  return PROGRAMS[programId] ?? null;
}

/** Decode `discriminator ‖ borsh` bytes of a pump / PumpSwap event. Unknown or irrelevant events → null. */
export function decodePumpEventBytes(program: PumpProgram, bytes: Uint8Array): PumpEvent | null {
  if (bytes.length < 8) return null;
  let decoded: { name: string; data: Raw } | null;
  try {
    decoded = coderFor(program).events.decode(Buffer.from(bytes).toString("base64")) as { name: string; data: Raw } | null;
  } catch {
    return null;
  }
  return decoded ? normalize(program, decoded.name, decoded.data) : null;
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}

/** An instruction invoked inside the transaction, in execution order. */
export interface InvokedInstruction {
  programId: string;
  data: Uint8Array;
  /** Index of the top-level instruction it belongs to. */
  outerIndex: number;
}

export interface PumpEventSource {
  logMessages?: readonly string[] | null;
  /** Inner (CPI) instructions in execution order; top-level ones may be included too. */
  instructions?: readonly InvokedInstruction[];
}

const INVOKE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT = /^Program (\w+) (success|failed)/;
const DATA = "Program data: ";

/** `Program data:` payloads attributed to the program executing at that point of the log. */
export function programDataLogs(logs: readonly string[]): { programId: string; data: string }[] {
  const stack: string[] = [];
  const out: { programId: string; data: string }[] = [];
  for (const line of logs) {
    const invoke = INVOKE.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (EXIT.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith(DATA) && stack.length > 0) out.push({ programId: stack[stack.length - 1]!, data: line.slice(DATA.length).trim() });
  }
  return out;
}

/**
 * All pump / PumpSwap events of a transaction, from emit_cpi self-invocations and from
 * `Program data:` logs. An event present in both forms is reported once (cpi wins).
 */
export function parsePumpEvents(source: PumpEventSource): DecodedPumpEvent[] {
  const out: DecodedPumpEvent[] = [];
  const seen = new Set<string>();
  for (const ix of source.instructions ?? []) {
    const program = pumpProgramOf(ix.programId);
    if (!program || !startsWith(ix.data, EVENT_IX_TAG_LE)) continue;
    const bytes = ix.data.subarray(EVENT_IX_TAG_LE.length);
    const id = `${program}:${Buffer.from(bytes).toString("base64")}`;
    if (seen.has(id)) continue;
    const event = decodePumpEventBytes(program, bytes);
    if (!event) continue;
    seen.add(id);
    out.push({ event, program, source: "cpi", index: out.length, outerIndex: ix.outerIndex });
  }
  for (const log of programDataLogs(source.logMessages ?? [])) {
    const program = pumpProgramOf(log.programId);
    if (!program) continue;
    const id = `${program}:${log.data}`;
    if (seen.has(id)) continue;
    let bytes: Uint8Array;
    try {
      bytes = Buffer.from(log.data, "base64");
    } catch {
      continue;
    }
    const event = decodePumpEventBytes(program, bytes);
    if (!event) continue;
    seen.add(id);
    out.push({ event, program, source: "log", index: out.length, outerIndex: null });
  }
  return out;
}

// ---- creator changes (pump.fun admin actions that can divert creator fees) ------------------------

export interface CreatorChangeEvent {
  program: PumpProgram;
  name: string;
  mint: string;
  /** The creator the event sets, when it carries one. */
  newCreator: string | null;
}

/** Events through which pump.fun's admins (or migrations) re-point a coin's creator / creator fees. */
const CREATOR_CHANGE_EVENTS: Record<PumpProgram, Record<string, { mint: string; creator: string | null }>> = {
  pump: {
    SetCreatorEvent: { mint: "mint", creator: "creator" },
    AdminCtoEvent: { mint: "mint", creator: "new_creator" },
    MigrateBondingCurveCreatorEvent: { mint: "mint", creator: "new_creator" },
    SetMetaplexCreatorEvent: { mint: "mint", creator: "creator" },
  },
  pump_amm: {
    AdminCtoPoolEvent: { mint: "base_mint", creator: "new_coin_creator" },
    MigratePoolCoinCreatorEvent: { mint: "base_mint", creator: "new_coin_creator" },
    SetBondingCurveCoinCreatorEvent: { mint: "base_mint", creator: "coin_creator" },
    SetMetaplexCoinCreatorEvent: { mint: "base_mint", creator: "coin_creator" },
  },
};

function decodeRaw(program: PumpProgram, bytes: Uint8Array): { name: string; data: Raw } | null {
  try {
    return coderFor(program).events.decode(Buffer.from(bytes).toString("base64")) as { name: string; data: Raw } | null;
  } catch {
    return null;
  }
}

/** Creator-change events in a transaction (cpi and log forms, deduplicated). */
export function creatorChangeEvents(source: PumpEventSource): CreatorChangeEvent[] {
  const out: CreatorChangeEvent[] = [];
  const seen = new Set<string>();
  const consider = (program: PumpProgram, bytes: Uint8Array) => {
    const id = `${program}:${Buffer.from(bytes).toString("base64")}`;
    if (seen.has(id)) return;
    seen.add(id);
    const decoded = decodeRaw(program, bytes);
    const fields = decoded ? CREATOR_CHANGE_EVENTS[program][decoded.name] : undefined;
    if (!decoded || !fields) return;
    out.push({ program, name: decoded.name, mint: key(decoded.data[fields.mint]), newCreator: fields.creator && decoded.data[fields.creator] ? key(decoded.data[fields.creator]) : null });
  };
  for (const ix of source.instructions ?? []) {
    const program = pumpProgramOf(ix.programId);
    if (program && startsWith(ix.data, EVENT_IX_TAG_LE)) consider(program, ix.data.subarray(EVENT_IX_TAG_LE.length));
  }
  for (const log of programDataLogs(source.logMessages ?? [])) {
    const program = pumpProgramOf(log.programId);
    if (!program) continue;
    try {
      consider(program, Buffer.from(log.data, "base64"));
    } catch {
      // not base64
    }
  }
  return out;
}
