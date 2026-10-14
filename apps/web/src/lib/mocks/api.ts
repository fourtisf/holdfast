import {
  LAUNCH_FEE_LAMPORTS,
  marketCapSol,
  type LaunchRequest,
  type LaunchQuote,
  LaunchResponse,
  type LaunchStatus,
  type LaunchStatusKind,
  type RoundSnapshot,
  type TradeQuote,
  type TradeQuoteRequest,
} from "@holdfast/core";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ApiError, type HoldfastApi } from "../api";
import { base58Encode, mockAddress, mockSignature, randomAddress, randomId } from "./ids";
import * as market from "./market";

const SPEC_FEE_SOL = Number(LAUNCH_FEE_LAMPORTS) / 1e9;

/** Mirrors the launcher's cost model (packages/chain/src/launch): atomic launch + IPFS metadata, default rent and fees. */
function mockLaunchQuote(devBuySol = 0): LaunchQuote {
  const launchFeeSol = SPEC_FEE_SOL;
  const devBuyExtraSol = devBuySol > 0 ? 0.00691344 + Math.ceil(devBuySol * 0.05 * 1e9) / 1e9 : 0;
  const requiredSol = Math.round((launchFeeSol + devBuySol + devBuyExtraSol) * 1e9) / 1e9;
  return { launchFeeSol, devBuySol, devBuyExtraSol, requiredSol, requiredLamports: lamports(requiredSol), specFeeSol: SPEC_FEE_SOL, exceedsSpecFee: false };
}
const DEPOSIT_WINDOW_MS = 15 * 60_000;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

function latency<T>(value: T, min = 120, max = 380): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), min + Math.random() * (max - min)));
}

function notFound(what: string): never {
  throw new ApiError(`${what} not found`, 404);
}

function quote(req: TradeQuoteRequest): TradeQuote {
  const coin = market.coinSummary(req.mint) ?? notFound("Coin");
  if (!(req.amount > 0)) throw new ApiError("Amount must be greater than zero", 400);
  const feeRate = 0.0125;
  const depth = 30 + marketCapSol(coin.price) * 0.25;
  if (req.side === "buy") {
    const impact = req.amount / (depth + req.amount);
    const expectedOut = ((req.amount * (1 - feeRate)) / coin.price) * (1 - impact);
    return {
      side: "buy",
      expectedOut,
      minOut: expectedOut * (1 - req.slippageBps / 10_000),
      priceImpactPct: impact * 100,
      feeSol: req.amount * feeRate,
      venue: coin.graduated ? "pumpswap" : "curve",
    };
  }
  const gross = req.amount * coin.price;
  const impact = gross / (depth + gross);
  const expectedOut = gross * (1 - impact) * (1 - feeRate);
  return {
    side: "sell",
    expectedOut,
    minOut: expectedOut * (1 - req.slippageBps / 10_000),
    priceImpactPct: impact * 100,
    feeSol: gross * feeRate,
    venue: coin.graduated ? "pumpswap" : "curve",
  };
}

function unsignedTransaction(wallet: string): string {
  const payer = new PublicKey(wallet);
  const blockhash = base58Encode(crypto.getRandomValues(new Uint8Array(32)));
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 0 })],
  }).compileToV0Message();
  const bytes = new VersionedTransaction(message).serialize();
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ---- launch flow: awaiting_deposit → deposit_received → creating → live over ~10s ------------

interface MockLaunch {
  req: LaunchRequest;
  res: LaunchResponse;
  createdAt: number;
  mint: string;
  sender: string;
}

const launches = new Map<string, MockLaunch>();

function lamports(sol: number): string {
  return String(Math.round(sol * 1e9));
}

function launchState(id: string): LaunchStatus {
  const launch = launches.get(id) ?? notFound("Launch");
  const now = Date.now();
  const elapsed = now - launch.createdAt;
  const ticker = launch.req.ticker.toUpperCase();
  let status: LaunchStatusKind;
  let error: string | null = null;
  let refundSig: string | null = null;
  // Demo hooks: ticker SLOW never receives a deposit, FAIL fails after the deposit and refunds.
  if (ticker === "SLOW") {
    status = now >= launch.res.expiresAt ? "expired" : "awaiting_deposit";
  } else if (elapsed < 3500) status = "awaiting_deposit";
  else if (elapsed < 6500) status = "deposit_received";
  else if (ticker === "FAIL") {
    status = elapsed < 9000 ? "refunding" : "refunded";
    error = "pump.fun create failed: blockhash expired";
    refundSig = elapsed < 9000 ? null : mockSignature(`refund:${id}`);
  } else if (elapsed < 10_000) status = "creating";
  else status = "live";

  if (status === "live") {
    market.launchCoin({ mint: launch.mint, req: launch.req, createdAt: launch.createdAt + 10_000, launcher: launch.sender });
  }
  const received = status === "awaiting_deposit" || status === "expired" ? "0" : lamports(launch.res.requiredSol + 0.0042);
  return {
    launchId: id,
    status,
    depositAddress: launch.res.depositAddress,
    requiredLamports: launch.res.requiredLamports,
    receivedLamports: received,
    sender: status === "awaiting_deposit" || status === "expired" ? null : launch.sender,
    mint: status === "live" ? launch.mint : null,
    refundSig,
    error,
    updatedAt: now,
  };
}

export function mockLaunchStatus(id: string): LaunchStatus {
  return launchState(id);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new ApiError("Could not read file", 400));
    reader.readAsDataURL(file);
  });
}

export const mockApi: HoldfastApi = {
  stats: () => latency(market.stats()),
  schedule: () => latency(market.stats().schedule, 40, 160),
  coins: async (q = {}) => {
    const all = market.listCoins(q.sort, q.q);
    const start = q.cursor ? Number(q.cursor) : 0;
    const limit = q.limit ?? 24;
    const items = all.slice(start, start + limit);
    return latency({ items, nextCursor: start + limit < all.length ? String(start + limit) : null });
  },
  coin: async (mint) => latency(market.coinDetail(mint) ?? notFound("Coin")),
  candles: async (mint, tf) => latency(market.candles(mint, tf) ?? notFound("Coin")),
  trades: async (mint, opts = {}) => latency(market.tradesPage(mint, opts.limit ?? 40, opts.before) ?? notFound("Coin")),
  holders: async (mint, opts = {}) => latency(market.holdersList(mint, opts.limit ?? 50) ?? notFound("Coin")),
  defends: async (mint, opts = {}) => latency(market.defendsList(mint, opts.limit ?? 50) ?? notFound("Coin")),
  rounds: async (mint, opts = {}) => latency(market.roundsList(mint, opts.limit ?? 20) ?? notFound("Coin")),
  round: async (mint, roundId) => {
    const summary = (market.roundsList(mint, 50) ?? notFound("Coin")).find((r) => r.roundId === roundId) ?? notFound("Round");
    const snapshot: RoundSnapshot = {
      ...summary,
      version: 1,
      mint,
      snapshotAt: summary.ts,
      inputs: {
        mint,
        roundId,
        snapshotAt: summary.ts,
        potSolLamports: lamports(summary.solPot),
        potTokensRaw: String(Math.round(summary.tokenPot * 1e6)),
        params: { minSolLamports: "10000", minTokensRaw: "1000000", rentExemptMinLamports: "890880", carryExpiryMs: 86_400_000, maxRecipients: 500 },
        holders: [],
        carriedIn: [],
      },
      totalWeight: "0",
      entries: [],
      carriedOut: [],
    };
    return latency(snapshot);
  },
  profile: async (wallet) => latency(market.profile(wallet)),
  position: async (wallet, mint) => latency(market.position(wallet, mint), 80, 200),
  quote: async (req) => latency(quote(req), 90, 220),
  buildTrade: async (req) => {
    const q = quote(req);
    return latency({ quote: q, transaction: unsignedTransaction(req.wallet), lastValidBlockHeight: 280_000_000 + Math.floor(Math.random() * 1000) }, 200, 450);
  },
  uploadImage: async (file) => {
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) throw new ApiError("Unsupported image type (png, jpg, gif or webp)", 415);
    if (file.size > MAX_UPLOAD_BYTES) throw new ApiError("Image is larger than 5 MB", 413);
    return latency({ imageUrl: await readAsDataUrl(file) }, 400, 900);
  },
  launchQuote: async (q = {}) => latency(mockLaunchQuote(q.devBuySol ?? 0), 60, 160),
  launch: async (req) => {
    if (!req.name.trim() || !req.ticker.trim()) throw new ApiError("Name and ticker are required", 400);
    const launchId = randomId();
    const { requiredSol } = mockLaunchQuote(req.devBuySol ?? 0);
    const depositAddress = randomAddress();
    const res: LaunchResponse = {
      launchId,
      depositAddress,
      requiredLamports: lamports(requiredSol),
      requiredSol,
      solanaPayUrl: `solana:${depositAddress}?amount=${requiredSol}&label=Holdfast&message=${encodeURIComponent(`Launch $${req.ticker.toUpperCase()}`)}`,
      expiresAt: Date.now() + DEPOSIT_WINDOW_MS,
    };
    launches.set(launchId, { req, res, createdAt: Date.now(), mint: mockAddress(`launch:${launchId}`), sender: randomAddress() });
    return latency(res, 300, 600);
  },
  launchStatus: async (id) => latency(launchState(id), 60, 160),
};
