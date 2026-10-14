/**
 * Launch cost model: rent for every account the flow creates (sizes from sizes.ts) + signature
 * fees + the priority-fee budget of each transaction. `computeLaunchCost(rent)` is pure; feed it the
 * cluster's rent (`rentFromChain`) or `DEFAULT_RENT` (the mainnet/devnet parameters).
 *
 * Two kinds of lamports are needed on the deposit address:
 * - consumed: rent of accounts that stay alive (they belong to the coin, its vault, or the sender),
 *   transaction fees and priority fees;
 * - float: lamports that must sit on the deposit while the flow runs and come back in the final
 *   refund (the deposit's own rent-exempt reserve, the temporary dev-buy token account and pump
 *   volume accumulator, the dev-buy slippage allowance).
 */
import { LAUNCH_FEE_LAMPORTS } from "@holdfast/core";

import {
  COIN_VAULT_SIZE,
  PUMP_BONDING_CURVE_SIZE,
  PUMP_MAX_NAME_BYTES,
  PUMP_MAX_SYMBOL_BYTES,
  PUMP_MAX_URI_BYTES,
  PUMP_USER_VOLUME_ACCUMULATOR_SIZE,
  SPL_TOKEN_ACCOUNT_SIZE,
  SYSTEM_ACCOUNT_SIZE,
  TOKEN_2022_ATA_SIZE,
  pumpMintSize,
} from "./sizes.js";

export const LAMPORTS_PER_SIGNATURE = 5_000n;

/** Compute-unit limits per transaction (tune on devnet; the priority fee is charged on the limit). */
export interface ComputeUnits {
  create: number;
  init: number;
  devBuy: number;
  refund: number;
}

export const DEFAULT_COMPUTE_UNITS: ComputeUnits = { create: 250_000, init: 250_000, devBuy: 300_000, refund: 2_000 };

export interface PriorityConfig {
  /** Compute-unit price in micro-lamports (0 = no priority fee instruction). */
  microLamports: bigint;
  units: ComputeUnits;
}

export const DEFAULT_PRIORITY: PriorityConfig = { microLamports: 50_000n, units: DEFAULT_COMPUTE_UNITS };

/** Required signatures per transaction (A: deposit + mint, B: deposit + launcher, C/refund: deposit). */
export const TX_SIGNATURES = { create: 2, init: 2, devBuy: 1, refund: 1 } as const;
export type TxKind = keyof typeof TX_SIGNATURES;

export function priorityFee(microLamports: bigint, units: number): bigint {
  if (microLamports <= 0n) return 0n;
  return (microLamports * BigInt(units) + 999_999n) / 1_000_000n;
}

/** Fee the fee payer is charged for transaction `kind`: signatures + compute-unit price × limit. */
export function txFee(kind: TxKind, priority: PriorityConfig): bigint {
  return LAMPORTS_PER_SIGNATURE * BigInt(TX_SIGNATURES[kind]) + priorityFee(priority.microLamports, priority.units[kind]);
}

/** Rent-exempt minimum for an account with `dataLen` bytes of data. */
export type RentFn = (dataLen: number) => bigint;

/** Solana's rent parameters (3480 lamports per byte-year, 2-year exemption, 128 bytes of overhead). */
export const DEFAULT_RENT: RentFn = (dataLen) => (128n + BigInt(dataLen)) * 6_960n;

/** Exact linear rent function from the cluster (two RPC answers), checked against a third. */
export async function rentFromChain(getMinimumBalance: (dataLen: number) => Promise<bigint>): Promise<RentFn> {
  const [r0, r1, r1000] = await Promise.all([getMinimumBalance(0), getMinimumBalance(1), getMinimumBalance(1000)]);
  const perByte = r1 - r0;
  const fn: RentFn = (len) => r0 + perByte * BigInt(len);
  if (fn(1000) !== r1000) throw new Error(`cluster rent is not linear: rent(1000) = ${r1000}, expected ${fn(1000)}`);
  return fn;
}

export interface CostItem {
  key: string;
  label: string;
  lamports: bigint;
  /** Account data size the rent was computed for. */
  bytes?: number;
}

export interface LaunchCostOptions {
  /** Metadata lengths in UTF-8 bytes; default to pump.fun's maximums (worst case). */
  nameBytes?: number;
  symbolBytes?: number;
  uriBytes?: number;
  priority?: PriorityConfig;
  devBuyLamports?: bigint;
  /** Close the deposit's pump volume accumulator at the end of tx C (its rent is then float, not cost). */
  closeDepositAccumulator?: boolean;
  devBuySlippageBps?: number;
}

export interface DevBuyCost {
  lamports: bigint;
  items: CostItem[];
  consumed: bigint;
  float: CostItem[];
  floatTotal: bigint;
}

export interface LaunchCost {
  /** Consumed by every launch. */
  items: CostItem[];
  consumed: bigint;
  /** Held on the deposit during the flow and refunded. */
  float: CostItem[];
  floatTotal: bigint;
  /** max(LAUNCH_FEE_LAMPORTS, consumed + float): what the deposit must hold for the launch itself. */
  launchFee: bigint;
  devBuy: DevBuyCost;
  /** Minimum deposit: launchFee + dev buy + dev-buy costs + dev-buy float. */
  requiredLamports: bigint;
  /** The real cost is above the 0.015 SOL of the spec (SPEC.md §2): a product decision. */
  exceedsSpecFee: boolean;
}

const sum = (items: readonly CostItem[]) => items.reduce((s, i) => s + i.lamports, 0n);

export function computeLaunchCost(rent: RentFn, opts: LaunchCostOptions = {}): LaunchCost {
  const priority = opts.priority ?? DEFAULT_PRIORITY;
  const nameBytes = opts.nameBytes ?? PUMP_MAX_NAME_BYTES;
  const symbolBytes = opts.symbolBytes ?? PUMP_MAX_SYMBOL_BYTES;
  const uriBytes = opts.uriBytes ?? PUMP_MAX_URI_BYTES;
  const devBuyLamports = opts.devBuyLamports ?? 0n;
  const closeAccumulator = opts.closeDepositAccumulator ?? true;
  const slippageBps = opts.devBuySlippageBps ?? 500;

  const account = (key: string, label: string, bytes: number): CostItem => ({ key, label, bytes, lamports: rent(bytes) });
  const mintBytes = pumpMintSize(nameBytes, symbolBytes, uriBytes);

  const items: CostItem[] = [
    account("pump_mint", "pump.fun Token-2022 mint (MetadataPointer + TokenMetadata)", mintBytes),
    account("pump_bonding_curve", "pump.fun BondingCurve", PUMP_BONDING_CURVE_SIZE),
    account("pump_curve_token_account", "pump.fun curve token account (Token-2022 ATA)", TOKEN_2022_ATA_SIZE),
    account("holdfast_vault", "Holdfast CoinVault", COIN_VAULT_SIZE),
    account("treasury_rent", "Holdfast treasury PDA rent-exempt reserve", SYSTEM_ACCOUNT_SIZE),
    // The treasury's token / WSOL accounts and pump volume accumulators are not part of a launch: the
    // vault program's `prepare_treasury` creates them later, paid from the coin's own floor bucket.
    { key: "fee_create", label: "tx A fee (2 signatures + priority)", lamports: txFee("create", priority) },
    { key: "fee_init", label: "tx B fee (2 signatures + priority)", lamports: txFee("init", priority) },
    { key: "fee_refund", label: "refund tx fee (1 signature + priority)", lamports: txFee("refund", priority) },
  ];
  const float: CostItem[] = [account("deposit_rent", "deposit address rent-exempt reserve (refunded)", SYSTEM_ACCOUNT_SIZE)];

  const devItems: CostItem[] = [];
  const devFloat: CostItem[] = [];
  if (devBuyLamports > 0n) {
    devItems.push(account("sender_token_account", "sender token account (Token-2022 ATA, owned by the sender)", TOKEN_2022_ATA_SIZE));
    devItems.push({ key: "fee_dev_buy", label: "tx C fee (1 signature + priority)", lamports: txFee("devBuy", priority) });
    devFloat.push(account("deposit_token_account", "deposit token account (closed in tx C)", TOKEN_2022_ATA_SIZE));
    const uva = account("deposit_volume_accumulator", "pump.fun UserVolumeAccumulator of the deposit", PUMP_USER_VOLUME_ACCUMULATOR_SIZE);
    if (closeAccumulator) devFloat.push({ ...uva, label: `${uva.label} (closed in tx C)` });
    else devItems.push(uva);
    const slippage = (devBuyLamports * BigInt(slippageBps) + 9_999n) / 10_000n;
    if (slippage > 0n) devFloat.push({ key: "dev_buy_slippage", label: `dev buy slippage allowance (${slippageBps} bps, refunded if unused)`, lamports: slippage });
  }

  const consumed = sum(items);
  const floatTotal = sum(float);
  const launchFee = consumed + floatTotal > LAUNCH_FEE_LAMPORTS ? consumed + floatTotal : LAUNCH_FEE_LAMPORTS;
  const devBuy: DevBuyCost = { lamports: devBuyLamports, items: devItems, consumed: sum(devItems), float: devFloat, floatTotal: sum(devFloat) };
  return {
    items,
    consumed,
    float,
    floatTotal,
    launchFee,
    devBuy,
    requiredLamports: launchFee + devBuyLamports + devBuy.consumed + devBuy.floatTotal,
    exceedsSpecFee: consumed > LAUNCH_FEE_LAMPORTS,
  };
}

/** Holdfast-side rent the launcher pays in `init_coin` and is reimbursed for by the deposit in the same tx. */
export interface InitRentInput {
  treasuryLamports: bigint;
}

export function initReimbursement(rent: RentFn, s: InitRentInput): { lamports: bigint; items: CostItem[] } {
  const items: CostItem[] = [{ key: "holdfast_vault", label: "CoinVault", bytes: COIN_VAULT_SIZE, lamports: rent(COIN_VAULT_SIZE) }];
  const reserve = rent(SYSTEM_ACCOUNT_SIZE);
  if (s.treasuryLamports < reserve) items.push({ key: "treasury_rent", label: "treasury rent-exempt top-up", lamports: reserve - s.treasuryLamports });
  return { lamports: sum(items), items };
}

/**
 * Rent `prepare_treasury` takes from a coin's floor bucket once the coin earns fees: the treasury's
 * token account, WSOL account and pump.fun volume accumulator (and later PumpSwap's).
 */
export function treasuryPrepareCost(rent: RentFn): bigint {
  return rent(TOKEN_2022_ATA_SIZE) + rent(SPL_TOKEN_ACCOUNT_SIZE) + rent(PUMP_USER_VOLUME_ACCUMULATOR_SIZE);
}

export const formatSol = (lamports: bigint): string => {
  const neg = lamports < 0n;
  const v = neg ? -lamports : lamports;
  return `${neg ? "-" : ""}${v / 1_000_000_000n}.${(v % 1_000_000_000n).toString().padStart(9, "0")}`;
};
