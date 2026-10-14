/**
 * REST / WebSocket contract between apps/api and apps/web.
 *
 * Conventions
 * - Amounts in SOL are JS numbers (display precision). Exact lamport values, where a client may need
 *   them, are decimal strings suffixed `Lamports`.
 * - Token amounts are whole-token JS numbers (base units / 10^decimals) unless suffixed `Raw`.
 * - Prices are SOL per whole token (number). Market caps are in SOL.
 * - Timestamps are unix milliseconds (number).
 * - Wallets / mints / signatures are base58 strings.
 */

import type { TriggerBps } from "./constants.js";
import type { ReportReason } from "./moderation.js";

export type CoinSort = "newest" | "trending" | "vault_buying" | "top_payouts" | "biggest_vault";

export interface Socials {
  x?: string;
  telegram?: string;
  website?: string;
}

/** Live state of a coin's on-chain vault (CoinVault account + treasury balances). */
export interface VaultSnapshot {
  /** SOL reserved for floor defence (60% of creator fees, minus buybacks). */
  floorSol: number;
  /** SOL waiting in the holder payout bucket (30% of fees). */
  holderSol: number;
  /** SOL waiting to buy & burn $HOLD (10% of fees). */
  burnSol: number;
  /** Tokens bought back by the vault and waiting to be paid to holders. */
  holderTokens: number;
  /** All-time high price (TWAP based), SOL per token. 0 until the first ATH is confirmed. */
  athPrice: number;
  /** Current floor price = ATH × (1 − trigger). */
  floorPrice: number;
  defendCount: number;
  lastDefendAt: number | null;
  /** Total SOL the vault has spent on buybacks since launch. */
  totalDefendedSol: number;
}

export interface CoinSummary {
  mint: string;
  name: string;
  ticker: string;
  /** User-uploaded image. `null` → frontend renders the mascot fallback. */
  imageUrl: string | null;
  createdAt: number;
  triggerBps: TriggerBps;
  price: number;
  marketCapSol: number;
  athMarketCapSol: number;
  floorMarketCapSol: number;
  /** Where the price sits between floor (0) and ATH (1). Clamped to [0, 1]. */
  floorToAthProgress: number;
  /** Price ≤ floor: the vault is (or will be) buying. */
  vaultBuying: boolean;
  change24hPct: number;
  volume24hSol: number;
  holders: number;
  /** Lifetime SOL paid to holders (rounds). */
  paidOutSol: number;
  graduated: boolean;
  vault: VaultSnapshot;
}

export interface CoinDetail extends CoinSummary {
  description: string;
  socials: Socials;
  /** Wallet that launched the coin (informational only: it receives no fees). */
  launcher: string | null;
  vaultAddress: string;
  treasuryAddress: string;
  bondingCurve: string;
  ammPool: string | null;
  roundId: number;
  lastRound: RoundSummary | null;
  /**
   * Hidden by Holdfast's moderators. The coin keeps trading on pump.fun and keeps paying its holders;
   * its image, description and links are withheld (null / empty) and it is not listed.
   */
  hidden: boolean;
  hiddenReason: string | null;
}

export interface Candle {
  /** Bucket start, unix ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Volume in SOL. */
  v: number;
}

export type CandleTimeframe = "1m" | "5m" | "15m" | "1h";

export interface CandlesResponse {
  mint: string;
  tf: CandleTimeframe;
  candles: Candle[];
  /** Floor price over time (step line), for the floor overlay. */
  floorLine: { t: number; price: number }[];
  /** Vault buybacks, rendered as "V" markers on the chart. */
  defends: { t: number; price: number; solSpent: number; sig: string }[];
}

export type TradeSide = "buy" | "sell" | "vault";

export interface Trade {
  sig: string;
  wallet: string;
  side: TradeSide;
  sol: number;
  tokens: number;
  price: number;
  ts: number;
  source: "curve" | "pumpswap" | "vault";
}

export interface Holder {
  wallet: string;
  /** Current token balance (including tokens that do not earn, e.g. received by transfer). */
  tokens: number;
  /** Tokens backed by purchase lots (the ones that earn). */
  eligibleTokens: number;
  /** Σ(lot × weight) in whole tokens. */
  weightedTokens: number;
  /** weightedTokens / eligibleTokens, between 0.1 and 1.0. */
  weightMultiplier: number;
  /** Share of the next payout round, 0..1. */
  share: number;
  earnedSol: number;
  earnedTokens: number;
  oldestLotAt: number | null;
}

export interface DefendEvent {
  sig: string;
  solSpent: number;
  tokensBought: number;
  price: number;
  ts: number;
}

export interface RoundSummary {
  roundId: number;
  ts: number;
  solPot: number;
  tokenPot: number;
  recipients: number;
  /** Merkle root committed on-chain in `open_round`, hex. */
  snapshotHash: string;
  status: "computed" | "opened" | "paying" | "closed" | "failed";
}

export interface RoundSnapshotEntry {
  index: number;
  wallet: string;
  /** Σ(lot.amount × weight_ppm) as a decimal string (exact integer). */
  weightedAmount: string;
  solLamports: string;
  tokensRaw: string;
  /** Carried dust included in this payout. */
  carriedSolLamports: string;
  carriedTokensRaw: string;
  sig: string | null;
}

/**
 * Full public snapshot for independent verification (see docs/payouts.md). `inputs` is everything the
 * payout worker used; re-running `computeRound(inputs)` from @holdfast/core must reproduce `entries`,
 * `carriedOut` and the merkle root `snapshotHash` committed on-chain.
 */
export interface RoundSnapshot extends RoundSummary {
  version: 1;
  mint: string;
  snapshotAt: number;
  inputs: RoundInputsJson;
  totalWeight: string;
  entries: RoundSnapshotEntry[];
  /** Amounts carried to the next round (below minimum / wallet cannot receive yet). */
  carriedOut: { wallet: string; solLamports: string; tokensRaw: string; since: number }[];
}

/** JSON form of `RoundInputs` (bigints as decimal strings). */
export interface RoundInputsJson {
  mint: string;
  roundId: number;
  snapshotAt: number;
  potSolLamports: string;
  potTokensRaw: string;
  params: {
    minSolLamports: string;
    minTokensRaw: string;
    rentExemptMinLamports: string;
    carryExpiryMs: number;
    maxRecipients: number;
  };
  holders: {
    wallet: string;
    lots: { amountRaw: string; acquiredAt: number }[];
    solBalanceLamports: string;
    hasTokenAccount: boolean;
  }[];
  carriedIn: { wallet: string; solLamports: string; tokensRaw: string; since: number }[];
}

export interface Stats {
  coins: number;
  /** Σ floor vault SOL across all coins. */
  totalVaultSol: number;
  /** Lifetime SOL paid to holders. */
  totalPaidSol: number;
  /** Buybacks in the last 24h. */
  defends24h: number;
  volume24hSol: number;
  schedule: Schedule;
}

export interface Schedule {
  roundIntervalSec: number;
  /** Next payout round start, unix ms (server clock). */
  nextRoundAt: number;
  serverTime: number;
}

export interface PositionLot {
  amount: number;
  acquiredAt: number;
  weight: number;
}

export interface Position {
  mint: string;
  name: string;
  ticker: string;
  imageUrl: string | null;
  tokens: number;
  eligibleTokens: number;
  weightedTokens: number;
  weightMultiplier: number;
  share: number;
  valueSol: number;
  earnedSol: number;
  earnedTokens: number;
  /** Estimated SOL in the next round at the current pot and weights. */
  nextPayoutEstimateSol: number;
  lots: PositionLot[];
}

export interface Profile {
  wallet: string;
  totalEarnedSol: number;
  /** Earned tokens valued at current prices. */
  totalEarnedTokensValueSol: number;
  positions: Position[];
  recentPayouts: { mint: string; ticker: string; roundId: number; sol: number; tokens: number; ts: number; sig: string | null }[];
}

export interface LaunchRequest {
  name: string;
  ticker: string;
  description?: string;
  /** URL returned by POST /uploads/image. */
  imageUrl?: string;
  socials?: Socials;
  triggerBps: TriggerBps;
  /** Optional dev buy in SOL (tokens are sent to the depositor and do NOT earn payouts). */
  devBuySol?: number;
}

/** GET /launch/quote: what a launch costs before anything is submitted (same model the launcher uses). */
export interface LaunchQuote {
  /** Rent + fees consumed by the launch itself (pump.fun accounts + Holdfast vault accounts + tx fees). */
  launchFeeSol: number;
  devBuySol: number;
  /** Extra accounts/fees of the dev buy plus refundable slippage float. */
  devBuyExtraSol: number;
  /** Minimum deposit; anything unused is refunded. */
  requiredSol: number;
  requiredLamports: string;
  /** SPEC §2 target (0.015 SOL) and whether the real cost is above it. */
  specFeeSol: number;
  exceedsSpecFee: boolean;
}

export interface LaunchResponse {
  launchId: string;
  depositAddress: string;
  /** Exact minimum to send: launch fee + dev buy. Anything above is refunded. */
  requiredLamports: string;
  requiredSol: number;
  /** solana: URI for the QR code. */
  solanaPayUrl: string;
  expiresAt: number;
}

export type LaunchStatusKind =
  | "awaiting_deposit"
  | "deposit_received"
  | "creating"
  | "live"
  | "refunding"
  | "refunded"
  | "expired"
  | "failed";

export interface LaunchStatus {
  launchId: string;
  status: LaunchStatusKind;
  depositAddress: string;
  requiredLamports: string;
  receivedLamports: string;
  sender: string | null;
  mint: string | null;
  refundSig: string | null;
  error: string | null;
  updatedAt: number;
}

/**
 * Buy/sell follows the pump.fun flow: the server builds an unsigned transaction with the official
 * pump.fun SDKs (bonding curve or PumpSwap after graduation), the browser signs it with the
 * connected wallet adapter (Phantom, Solflare, ...) and submits it.
 */
export interface TradeQuoteRequest {
  mint: string;
  wallet: string;
  side: "buy" | "sell";
  /** buy: SOL to spend. sell: whole tokens to sell. */
  amount: number;
  slippageBps: number;
}

export interface TradeQuote {
  side: "buy" | "sell";
  /** buy: tokens out (whole). sell: SOL out. */
  expectedOut: number;
  minOut: number;
  priceImpactPct: number;
  feeSol: number;
  venue: "curve" | "pumpswap";
}

export interface TradeBuildResponse {
  quote: TradeQuote;
  /** base64 serialized unsigned VersionedTransaction (fee payer = wallet). */
  transaction: string;
  lastValidBlockHeight: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// ---- moderation / admin ------------------------------------------------------------------------

/** POST /coins/:mint/report */
export interface ReportRequest {
  reason: ReportReason;
  details?: string;
}

export interface ReportResponse {
  /** False when this reporter had already reported the coin. */
  recorded: boolean;
}

export interface AdminReport {
  id: number;
  targetType: "coin" | "comment";
  targetId: string;
  mint: string;
  reason: ReportReason;
  details: string;
  createdAt: number;
  resolvedAt: number | null;
  resolution: string | null;
}

export interface AdminCoin {
  mint: string;
  name: string;
  ticker: string;
  hidden: boolean;
  hiddenReason: string | null;
  hiddenAt: number | null;
  needsReview: boolean;
  openReports: number;
  createdAt: number;
}

export interface AdminLaunch extends LaunchStatus {
  name: string;
  ticker: string;
  attempts: number;
  createdAt: number;
  devBuyLamports: string;
}

export interface AdminOverview {
  launches: Record<string, number>;
  openReports: number;
  coinsNeedingReview: number;
  hiddenCoins: number;
}

export interface AdminLogEntry {
  id: number;
  action: string;
  target: string;
  actor: string;
  reason: string;
  createdAt: number;
}

/** POST /admin/coins/:mint/hide */
export interface HideCoinRequest {
  reason: string;
  /** Also refuse the coin's image in future uploads. */
  blockImage?: boolean;
}

// ---- WebSocket ---------------------------------------------------------------------------------

export type WsClientMessage =
  | { type: "subscribe"; channel: "trades"; mint: string }
  | { type: "subscribe"; channel: "deposit-status"; launchId: string }
  | { type: "subscribe"; channel: "stats" }
  | { type: "unsubscribe"; channel: "trades"; mint: string }
  | { type: "unsubscribe"; channel: "deposit-status"; launchId: string }
  | { type: "unsubscribe"; channel: "stats" }
  | { type: "ping" };

export type WsServerMessage =
  | { channel: "trades"; mint: string; data: Trade }
  | { channel: "vault"; mint: string; data: VaultSnapshot }
  | { channel: "round"; mint: string; data: RoundSummary }
  | { channel: "deposit-status"; launchId: string; data: LaunchStatus }
  | { channel: "stats"; data: Stats }
  | { channel: "pong"; serverTime: number }
  | { channel: "error"; message: string };
