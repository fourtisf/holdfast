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
  /** SOL reserved for floor defence (40% of creator fees, minus buybacks). */
  floorSol: number;
  /** SOL waiting in the holder payout bucket (25% of fees). */
  holderSol: number;
  /** The creator's unclaimed share (15% of fees); only the coin's creator wallet can claim it. */
  creatorSol: number;
  /** What the creator has claimed so far. */
  creatorClaimedSol: number;
  /** The Moatpad treasury's share (10% of fees) not yet swept, and what was swept so far. */
  platformSol: number;
  platformSweptSol: number;
  /** SOL waiting to buy & burn $MOAT (10% of fees). */
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
  /** Share of the pump.fun bonding curve sold, 0..1 (1 once graduated to PumpSwap). */
  bondingCurveProgress: number;
  vault: VaultSnapshot;
}

export interface CoinDetail extends CoinSummary {
  description: string;
  socials: Socials;
  /**
   * The coin's creator: the wallet recorded on-chain at launch that claims the creator share (15% of
   * fees). The wallet that sent the launch deposit, unless the launch form named another one.
   */
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
  /** Position within the transaction: one transaction can hold several trades (sig + ixIndex is unique). */
  ixIndex: number;
  /** Slot of the transaction, to order live trades that arrive out of order (absent in wallet history). */
  slot?: number;
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
  /** `open_round` transaction: its RoundOpened event carries the committed root (verification). */
  openSig: string | null;
  closeSig: string | null;
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
  /** SOL price in USD from the API's price feed (null while unknown). */
  solUsd: number | null;
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
  /** SOL spent on buys / received from sells (indexed trades of this wallet). */
  boughtSol: number;
  soldSol: number;
  /** Value + sells + payouts (tokens at today's price) − buys. */
  pnlSol: number;
  pnlPct: number | null;
}

export interface Profile {
  wallet: string;
  totalEarnedSol: number;
  /** Earned tokens valued at current prices. */
  totalEarnedTokensValueSol: number;
  totalValueSol: number;
  totalPnlSol: number;
  /** Coins this wallet launched. */
  launchedCoins: number;
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
  /**
   * Wallet that may claim the coin's creator share (15% of its fees). Defaults to the wallet the
   * deposit comes from; set it when depositing from an exchange or another wallet.
   */
  creatorWallet?: string;
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
  /** True while the operator keeps launches closed (LAUNCHES_PAUSED): POST /launch is refused. */
  launchesPaused?: boolean;
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

/**
 * Launch signed by the creator's own wallet (POST /launch/wallet): the server returns the whole
 * launch as one v0 transaction, co-signed by the mint and the launcher, with the wallet as fee payer.
 * The wallet signs and sends it; GET /launch/wallet/:mint reports when the coin is live.
 */
export interface WalletLaunchRequest extends LaunchRequest {
  wallet: string;
}

export interface WalletLaunchPrepared {
  mint: string;
  /** Base64 v0 transaction; only the fee payer's (the wallet's) signature is missing. */
  transaction: string;
  lastValidBlockHeight: number;
  /** The most the wallet spends: fees, rent, and the dev buy with its slippage. */
  maxCostLamports: string;
  expiresAt: number;
}

export interface WalletLaunchStatus {
  mint: string;
  status: "pending" | "live" | "expired";
}

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
  /** Compute-unit price for the transaction (micro-lamports); the API's default when absent. */
  priorityMicroLamports?: number;
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

// ---- portfolio, leaderboards, creators, comments ----------------------------------------------

/** GET /me/trades */
export interface WalletTrade extends Trade {
  mint: string;
  ticker: string;
  name: string;
}

export type LeaderboardKind = "earners" | "diamond_hands" | "creators" | "coins";

export interface LeaderboardEarner {
  wallet: string;
  earnedSol: number;
  coins: number;
  payouts: number;
}

export interface LeaderboardDiamondHand {
  wallet: string;
  mint: string;
  ticker: string;
  heldSince: number;
  tokens: number;
}

export interface LeaderboardCreator {
  wallet: string;
  coins: number;
  paidToHoldersSol: number;
  totalFeesSol: number;
  firstLaunchAt: number | null;
}

/** GET /leaderboard?kind= */
export type Leaderboard =
  | { kind: "earners"; items: LeaderboardEarner[] }
  | { kind: "diamond_hands"; items: LeaderboardDiamondHand[] }
  | { kind: "creators"; items: LeaderboardCreator[] }
  | { kind: "coins"; items: CoinSummary[] };

/** GET /creators/:wallet */
export interface CreatorProfile {
  wallet: string;
  coinCount: number;
  paidToHoldersSol: number;
  totalFeesSol: number;
  firstLaunchAt: number | null;
  /** Coins of this creator currently trading above their floor. */
  coinsAboveFloor: number;
  coins: CoinSummary[];
}

export interface Comment {
  id: number;
  mint: string;
  wallet: string;
  body: string;
  replyTo: number | null;
  createdAt: number;
  /** The author holds the coin right now (eligible tokens > 0), and their weight multiplier. */
  holder: boolean;
  weightMultiplier: number | null;
  /** Is this the wallet that launched the coin. */
  isCreator: boolean;
  hidden: boolean;
}

/**
 * POST /coins/:mint/comments. `signature` (base58) is the wallet's ed25519 signature over
 * `commentMessage({ mint, body, replyTo, signedAt })` from @holdfast/core.
 */
export interface PostCommentRequest {
  wallet: string;
  body: string;
  replyTo?: number | null;
  signedAt: number;
  signature: string;
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
  /** Comment reports: the reported text. */
  commentBody: string | null;
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
  /** Live messages for `mint` may have been missed (the server's change feed reconnected): refetch. */
  | { channel: "resync"; mint: string }
  | { channel: "error"; message: string };

/** POST /creator/claim/build: an unsigned transaction for the creator to claim its share. */
export interface CreatorClaimBuildRequest {
  mint: string;
  /** Must be the coin's creator (`CoinDetail.launcher`). */
  wallet: string;
  priorityMicroLamports?: number;
}

export interface CreatorClaimBuildResponse {
  /** Base64 v0 transaction, fee payer = the creator; sign and send it. */
  transaction: string;
  lastValidBlockHeight: number;
  /** What the claim pays out, as last mirrored from the vault. */
  claimableSol: number;
}
