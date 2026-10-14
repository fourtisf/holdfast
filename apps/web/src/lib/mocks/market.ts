/**
 * In-browser simulated Holdfast market used when NEXT_PUBLIC_USE_MOCKS=1.
 *
 * Every coin gets a deterministic 1-minute price path (seeded by its name), and the vault mechanism is
 * replayed over it: creator fees split 60/30/10, ATH from a 15-minute TWAP, floor = ATH × (1 − trigger),
 * buybacks of 10% of the floor vault when the price touches the floor (with a cooldown), and payout
 * rounds every 2 minutes. Summary numbers are derived from the same path, so cards, chart and vault
 * panels agree with each other.
 */
import {
  DEFEND_STEP_BPS,
  ROUND_INTERVAL_SECONDS,
  SPLIT_BURN_BPS,
  SPLIT_FLOOR_BPS,
  SPLIT_HOLDER_BPS,
  TRIGGER_OPTIONS_BPS,
  candleBucket,
  floorToAthProgress,
  marketCapSol,
  nextRoundAt,
  positionPnl,
  weightMultiplier,
  type Comment,
  type CreatorProfile,
  type Leaderboard,
  type LeaderboardKind,
  type PostCommentRequest,
  type WalletTrade,
  type Candle,
  type CandleTimeframe,
  type CandlesResponse,
  type CoinDetail,
  type CoinSort,
  type CoinSummary,
  type DefendEvent,
  type Holder,
  type LaunchRequest,
  type Position,
  type Profile,
  type RoundSummary,
  type Socials,
  type Stats,
  type Trade,
  type TriggerBps,
  type VaultSnapshot,
} from "@holdfast/core";
import { hashString, seededRandom } from "../hash";
import { MOCK_WALLET, mockAddress, mockSignature, randomSignature } from "./ids";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ROUND_MS = ROUND_INTERVAL_SECONDS * 1000;
const LAUNCH_PRICE = 2.8e-8; // pump.fun start: ~28 SOL market cap
const GRADUATION_MC_SOL = 410;
/** Share of volume that becomes creator fees routed to the vault (mock figure). */
const CREATOR_FEE_RATE = 0.0095; // pump.fun creator fee at low market caps
const DEFEND_COOLDOWN_MIN = 15;
const TWAP_WINDOW_MIN = 15;
const BOOT = Math.floor(Date.now() / MINUTE) * MINUTE;

type EndState = "ath" | "mid" | "floor" | "below";

interface CoinSeed {
  name: string;
  ticker: string;
  description: string;
  imageUrl?: string;
  ageMin: number;
  peak: number;
  end: EndState;
  activity: number;
  trigger: TriggerBps;
  socials?: Socials;
}

const SEEDS: CoinSeed[] = [
  {
    name: "Kelp Lord",
    ticker: "KELP",
    description: "Rooted to the seabed. The vault keeps buying every dip below the floor.",
    ageMin: 3 * 1440 + 400,
    peak: 38,
    end: "below",
    activity: 1.2,
    trigger: 2500,
    socials: { x: "https://x.com/kelplord", telegram: "https://t.me/kelplord", website: "https://kelplord.fun" },
  },
  {
    name: "Floor Is Lava",
    ticker: "LAVA",
    description: "Touch the floor and the vault scoops you up.",
    imageUrl: "/mock/lava.svg",
    ageMin: 1440 + 200,
    peak: 22,
    end: "mid",
    activity: 1.6,
    trigger: 1500,
    socials: { x: "https://x.com/floorislava" },
  },
  {
    name: "Anchor Pup",
    ticker: "ANCHR",
    description: "A very good boy that never lets go.",
    ageMin: 2 * 1440,
    peak: 14,
    end: "floor",
    activity: 0.9,
    trigger: 2500,
    socials: { telegram: "https://t.me/anchorpup" },
  },
  {
    name: "Diamond Fins",
    ticker: "FINS",
    description: "Fins too heavy to sell.",
    imageUrl: "/mock/diamond.svg",
    ageMin: 260,
    peak: 9,
    end: "ath",
    activity: 2.4,
    trigger: 3500,
    socials: { x: "https://x.com/diamondfins", website: "https://diamondfins.xyz" },
  },
  {
    name: "HODL Crab",
    ticker: "CRAB",
    description: "Walks sideways, holds forever.",
    ageMin: 4 * 1440 - 100,
    peak: 55,
    end: "mid",
    activity: 0.8,
    trigger: 2500,
  },
  {
    name: "Rooted Frog",
    ticker: "FROG",
    description: "Ribbit. Weight 1.0× gang.",
    imageUrl: "/mock/frog.svg",
    ageMin: 900,
    peak: 17,
    end: "below",
    activity: 1.1,
    trigger: 1500,
    socials: { x: "https://x.com/rootedfrog" },
  },
  {
    name: "Tidepool Cat",
    ticker: "TIDE",
    description: "Sits in the tidepool. Gets paid every 2 minutes.",
    ageMin: 95,
    peak: 4.2,
    end: "ath",
    activity: 2.8,
    trigger: 2500,
  },
  { name: "Octo Grip", ticker: "GRIP", description: "Eight arms, zero sells.", ageMin: 2 * 1440 + 800, peak: 31, end: "floor", activity: 0.7, trigger: 3500 },
  {
    name: "Lighthouse",
    ticker: "LIGHT",
    description: "Guiding bags home since launch.",
    imageUrl: "/mock/lighthouse.svg",
    ageMin: 3 * 1440,
    peak: 26,
    end: "mid",
    activity: 0.6,
    trigger: 2500,
    socials: { website: "https://lighthouse.fun" },
  },
  { name: "Iron Hands", ticker: "IRON", description: "Forged on the bonding curve.", ageMin: 600, peak: 12, end: "mid", activity: 1.3, trigger: 2500 },
];

const EXTRA_NAMES: [string, string][] = [
  ["Barnacle Bob", "BARN"],
  ["Never Selling", "NVRSELL"],
  ["Sea Snail", "SNAIL"],
  ["Moon Mussel", "MUSL"],
  ["Rock Bottom", "ROCK"],
  ["Seaweed Wizard", "WIZ"],
  ["Deep Root", "ROOT"],
  ["Salty Otter", "OTTR"],
  ["Limpet", "LIMP"],
  ["Coral Gang", "CORAL"],
  ["Clamped", "CLAMP"],
  ["Urchin", "URCH"],
  ["Gripfish", "GRIPF"],
  ["Stay Wet", "WET"],
  ["Tentacle Tom", "TOM"],
  ["Bedrock", "BED"],
  ["Floor Guard", "GUARD"],
  ["Sea Cucumber", "CUKE"],
  ["Moat Hamster", "HAMSTR"],
  ["Mollusk Mafia", "MAFIA"],
  ["Anemone", "ANEM"],
  ["Kraken Jr", "KRAKJR"],
  ["Tidal Lock", "TIDAL"],
  ["Pebble", "PEBL"],
  ["Chonky Seal", "SEAL"],
  ["Starfish Steve", "STAR"],
];

const BLURBS = [
  "Fees go to the vault, not the dev. Hold and get paid.",
  "Community coin. Floor follows the ATH.",
  "The longer you hold, the more you earn.",
  "No dev bags. No withdraw. Just the floor.",
  "Bought-back tokens go to holders, not the burn.",
  "Stuck to the rock like a true holdfast.",
];

function seedsFor(): CoinSeed[] {
  const rand = seededRandom(hashString("holdfast-mock-market"));
  const ends: EndState[] = ["mid", "mid", "floor", "below", "ath", "mid"];
  const extra = EXTRA_NAMES.map(([name, ticker], i): CoinSeed => {
    const ageMin = Math.round(30 + rand() ** 1.6 * 4 * 1440);
    return {
      name,
      ticker,
      description: BLURBS[i % BLURBS.length]!,
      ageMin,
      peak: 1.6 + rand() ** 1.8 * 40,
      end: ends[Math.floor(rand() * ends.length)]!,
      activity: 0.05 + rand() ** 1.5 * 1.6,
      trigger: TRIGGER_OPTIONS_BPS[Math.floor(rand() * 3)]!,
      socials: rand() > 0.5 ? { x: `https://x.com/${ticker.toLowerCase()}coin` } : undefined,
    };
  });
  return [...SEEDS, ...extra];
}

// ---- simulation ------------------------------------------------------------------------------

interface VaultState {
  floorSol: number;
  holderSol: number;
  burnSol: number;
  holderTokens: number;
  athPrice: number;
  floorPrice: number;
  defendCount: number;
  lastDefendAt: number | null;
  totalDefendedSol: number;
}

export interface MockHolderRecord {
  wallet: string;
  lots: { amount: number; acquiredAt: number }[];
  transferred: number;
  devBuy: number;
}

interface MockCoin {
  mint: string;
  name: string;
  ticker: string;
  description: string;
  imageUrl: string | null;
  socials: Socials;
  triggerBps: TriggerBps;
  createdAt: number;
  launcher: string | null;
  activity: number;
  minutes: Candle[];
  /** Minutes produced by the historical simulation (trades for them are synthesised on demand). */
  genMinutes: number;
  floorLine: { t: number; price: number }[];
  defends: DefendEvent[];
  vault: VaultState;
  paidOutSol: number;
  paidOutTokens: number;
  graduated: boolean;
  roundId: number;
  lastRound: RoundSummary | null;
  /** Rounds settled up to this time. */
  accruedTo: number;
  liveTrades: Trade[];
  holderCount: number;
  holders: MockHolderRecord[] | null;
  rand: () => number;
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Log-price path through keyframes with Brownian-bridge noise between them. */
function buildPath(n: number, keyframes: [number, number][], rand: () => number): number[] {
  const out = new Array<number>(n).fill(0);
  for (let k = 0; k < keyframes.length - 1; k++) {
    const [a, la] = keyframes[k]!;
    const [b, lb] = keyframes[k + 1]!;
    const len = b - a;
    if (len <= 0) continue;
    const sigma = 0.32 / Math.sqrt(len);
    const walk = [0];
    for (let j = 1; j <= len; j++) walk.push(walk[j - 1]! + gaussian(rand) * sigma);
    const end = walk[len]!;
    for (let j = 0; j <= len; j++) {
      const f = j / len;
      out[a + j] = la + (lb - la) * f + (walk[j]! - f * end);
    }
  }
  return out;
}

function twapAth(closes: number[]): { ath: number[]; peakIndex: number } {
  const ath: number[] = [];
  let sum = 0;
  let best = 0;
  let peakIndex = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]!;
    if (i >= TWAP_WINDOW_MIN) sum -= closes[i - TWAP_WINDOW_MIN]!;
    const twap = sum / Math.min(i + 1, TWAP_WINDOW_MIN);
    if (twap > best) {
      best = twap;
      peakIndex = i;
    }
    ath.push(best);
  }
  return { ath, peakIndex };
}

function emptyVault(): VaultState {
  return { floorSol: 0, holderSol: 0, burnSol: 0, holderTokens: 0, athPrice: 0, floorPrice: 0, defendCount: 0, lastDefendAt: null, totalDefendedSol: 0 };
}

function splitFee(coin: MockCoin, fee: number) {
  coin.vault.floorSol += (fee * SPLIT_FLOOR_BPS) / 10_000;
  coin.vault.holderSol += (fee * SPLIT_HOLDER_BPS) / 10_000;
  coin.vault.burnSol += (fee * SPLIT_BURN_BPS) / 10_000;
}

function payRound(coin: MockCoin, at: number) {
  const solPot = coin.vault.holderSol;
  const tokenPot = coin.vault.holderTokens;
  coin.paidOutSol += solPot;
  coin.paidOutTokens += tokenPot;
  coin.vault.holderSol = 0;
  coin.vault.holderTokens = 0;
  coin.roundId += 1;
  if (coin.roundId % 5 === 0) coin.vault.burnSol = 0; // burn_hold runs every few rounds
  coin.lastRound = {
    roundId: coin.roundId,
    ts: at,
    solPot,
    tokenPot,
    recipients: Math.min(coin.holderCount, Math.max(1, Math.round(coin.holderCount * 0.8))),
    snapshotHash: hashString(`${coin.mint}:round:${coin.roundId}`).toString(16).padStart(8, "0").repeat(8),
    status: "closed",
    openSig: mockSignature(`${coin.mint}:open:${coin.roundId}`),
    closeSig: mockSignature(`${coin.mint}:close:${coin.roundId}`),
  };
}

function tryDefend(coin: MockCoin, ts: number, price: number): DefendEvent | null {
  const v = coin.vault;
  if (!(v.floorPrice > 0) || price > v.floorPrice || v.floorSol < 0.02) return null;
  if (v.lastDefendAt !== null && ts - v.lastDefendAt < DEFEND_COOLDOWN_MIN * MINUTE) return null;
  const solSpent = (v.floorSol * DEFEND_STEP_BPS) / 10_000;
  const fill = Math.min(price, v.floorPrice) * (1 + coin.rand() * 0.01);
  const event: DefendEvent = { sig: mockSignature(`${coin.mint}:defend:${ts}`), solSpent, tokensBought: solSpent / fill, price: fill, ts };
  v.floorSol -= solSpent;
  v.holderTokens += event.tokensBought;
  v.totalDefendedSol += solSpent;
  v.defendCount += 1;
  v.lastDefendAt = ts;
  coin.defends.push(event);
  return event;
}

function raiseAth(coin: MockCoin, ath: number, ts: number) {
  if (ath <= coin.vault.athPrice) return;
  coin.vault.athPrice = ath;
  const floor = ath * (1 - coin.triggerBps / 10_000);
  const last = coin.floorLine[coin.floorLine.length - 1];
  if (!last || floor > last.price * 1.0025) coin.floorLine.push({ t: ts, price: floor });
  coin.vault.floorPrice = floor;
}

function simulate(seed: CoinSeed, index: number): MockCoin {
  const rand = seededRandom(hashString(`coin:${seed.ticker}:${index}`));
  const n = Math.max(20, Math.round(seed.ageMin));
  const createdAt = BOOT - n * MINUTE;
  const mint = mockAddress(`mint:${seed.ticker}:${index}`);
  const l0 = Math.log(LAUNCH_PRICE);
  const lPeak = l0 + Math.log(seed.peak);

  const ip = seed.end === "ath" ? n - 1 : Math.round(n * (0.25 + rand() * 0.45));
  const i1 = Math.max(1, Math.round(ip * (0.3 + rand() * 0.3)));
  const firstLeg = l0 + (lPeak - l0) * (0.35 + rand() * 0.4);
  const keyframes: [number, number][] = [
    [0, l0],
    [i1, firstLeg],
    [ip, lPeak],
  ];
  if (ip < n - 1) keyframes.push([n - 1, lPeak + Math.log(0.6 + rand() * 0.3)]);
  const logs = buildPath(n, keyframes, rand);

  // Aim the end of the path at the requested position relative to the TWAP floor.
  const closesRaw = logs.map((l) => Math.exp(l));
  const { ath, peakIndex } = twapAth(closesRaw);
  const athEnd = ath[n - 1]!;
  const floorEnd = athEnd * (1 - seed.trigger / 10_000);
  const target =
    seed.end === "ath"
      ? null
      : seed.end === "mid"
        ? floorEnd + (athEnd - floorEnd) * (0.3 + rand() * 0.45)
        : seed.end === "floor"
          ? floorEnd * (1.02 + rand() * 0.05)
          : floorEnd * (0.93 + rand() * 0.05);
  if (target !== null && peakIndex < n - 1) {
    const delta = Math.log(target) - logs[n - 1]!;
    for (let i = peakIndex + 1; i < n; i++) logs[i] = logs[i]! + (delta * (i - peakIndex)) / (n - 1 - peakIndex);
  }

  const coin: MockCoin = {
    mint,
    name: seed.name,
    ticker: seed.ticker,
    description: seed.description,
    imageUrl: seed.imageUrl ?? null,
    socials: seed.socials ?? {},
    triggerBps: seed.trigger,
    createdAt,
    launcher: rand() > 0.3 ? mockAddress(`launcher:${seed.ticker}`) : null,
    activity: seed.activity,
    minutes: [],
    genMinutes: n,
    floorLine: [],
    defends: [],
    vault: emptyVault(),
    paidOutSol: 0,
    paidOutTokens: 0,
    graduated: false,
    roundId: 0,
    lastRound: null,
    accruedTo: createdAt,
    liveTrades: [],
    holderCount: 0,
    holders: null,
    rand,
  };

  let sum = 0;
  let prevClose = LAUNCH_PRICE;
  let nextRound = nextRoundAt(createdAt);
  for (let i = 0; i < n; i++) {
    const t = createdAt + i * MINUTE;
    const c = Math.exp(logs[i]! + gaussian(rand) * 0.004);
    const o = prevClose;
    const wick = () => Math.abs(gaussian(rand)) * 0.006;
    const h = Math.max(o, c) * (1 + wick());
    const l = Math.min(o, c) * (1 - wick());
    const ageDays = (i * MINUTE) / DAY;
    const intensity = seed.activity * (0.25 + Math.exp(-ageDays / 1.6)) * (0.3 + rand());
    const v = intensity * (1 + 30 * Math.abs(Math.log(c / o)));
    coin.minutes.push({ t, o, h, l, c, v });
    prevClose = c;

    sum += c;
    if (i >= TWAP_WINDOW_MIN) sum -= coin.minutes[i - TWAP_WINDOW_MIN]!.c;
    raiseAth(coin, sum / Math.min(i + 1, TWAP_WINDOW_MIN), t + MINUTE);
    splitFee(coin, v * CREATOR_FEE_RATE);
    tryDefend(coin, t + Math.floor(rand() * 50_000), l);
    if (marketCapSol(h) >= GRADUATION_MC_SOL) coin.graduated = true;
    while (nextRound <= t + MINUTE) {
      payRound(coin, nextRound);
      nextRound += ROUND_MS;
    }
  }
  coin.accruedTo = BOOT;
  coin.holderCount = Math.round(18 + seed.activity * 260 * Math.min(1, n / 1440) + rand() * 40);
  return coin;
}

// ---- store -----------------------------------------------------------------------------------

const coins = new Map<string, MockCoin>();
let initialised = false;

function ensureMarket() {
  if (initialised) return;
  initialised = true;
  seedsFor().forEach((seed, i) => {
    const coin = simulate(seed, i);
    coins.set(coin.mint, coin);
  });
  restoreLaunchedCoins();
}

/** Background accrual between live trades: fees trickle in and rounds pay out on the server schedule. */
function settle(coin: MockCoin, now: number) {
  let cursor = coin.accruedTo;
  if (now <= cursor) return;
  const ratePerMs = (coin.activity * 0.35 * CREATOR_FEE_RATE) / MINUTE;
  let boundary = nextRoundAt(cursor);
  let guard = 0;
  while (boundary <= now && guard++ < 2000) {
    splitFee(coin, ratePerMs * (boundary - cursor));
    payRound(coin, boundary);
    cursor = boundary;
    boundary += ROUND_MS;
  }
  splitFee(coin, ratePerMs * (now - cursor));
  coin.accruedTo = now;
}

function getCoin(mint: string): MockCoin | null {
  ensureMarket();
  const coin = coins.get(mint) ?? null;
  if (coin) settle(coin, Date.now());
  return coin;
}

function allCoins(): MockCoin[] {
  ensureMarket();
  const now = Date.now();
  const list = [...coins.values()];
  for (const c of list) settle(c, now);
  return list;
}

function lastPrice(coin: MockCoin): number {
  return coin.minutes[coin.minutes.length - 1]?.c ?? LAUNCH_PRICE;
}

function priceAt(coin: MockCoin, ts: number): number {
  const idx = Math.floor((ts - coin.createdAt) / MINUTE);
  if (idx <= 0) return coin.minutes[0]?.o ?? LAUNCH_PRICE;
  return coin.minutes[Math.min(idx, coin.minutes.length - 1)]?.c ?? LAUNCH_PRICE;
}

function vaultSnapshot(coin: MockCoin): VaultSnapshot {
  const v = coin.vault;
  return {
    floorSol: v.floorSol,
    holderSol: v.holderSol,
    burnSol: v.burnSol,
    holderTokens: v.holderTokens,
    athPrice: v.athPrice,
    floorPrice: v.floorPrice,
    defendCount: v.defendCount,
    lastDefendAt: v.lastDefendAt,
    totalDefendedSol: v.totalDefendedSol,
  };
}

function summary(coin: MockCoin): CoinSummary {
  const now = Date.now();
  const price = lastPrice(coin);
  const dayAgo = Math.max(coin.createdAt, now - DAY);
  const ref = priceAt(coin, dayAgo);
  let volume = 0;
  for (let i = coin.minutes.length - 1; i >= 0 && coin.minutes[i]!.t >= now - DAY; i--) volume += coin.minutes[i]!.v;
  const { athPrice, floorPrice } = coin.vault;
  return {
    mint: coin.mint,
    name: coin.name,
    ticker: coin.ticker,
    imageUrl: coin.imageUrl,
    createdAt: coin.createdAt,
    triggerBps: coin.triggerBps,
    price,
    marketCapSol: marketCapSol(price),
    athMarketCapSol: marketCapSol(athPrice),
    floorMarketCapSol: marketCapSol(floorPrice),
    floorToAthProgress: floorToAthProgress(price, floorPrice, athPrice),
    vaultBuying: floorPrice > 0 && price <= floorPrice,
    change24hPct: (price / ref - 1) * 100,
    volume24hSol: volume,
    holders: coin.holderCount,
    paidOutSol: coin.paidOutSol,
    graduated: coin.graduated,
    bondingCurveProgress: curveProgress(coin.graduated, price),
    vault: vaultSnapshot(coin),
  };
}

/**
 * pump.fun constant product: virtual reserves start at 30 SOL × 1,073M tokens and 793.1M of them
 * are sold on the curve, so the spot price pins down how much of the curve is gone.
 */
function curveProgress(graduated: boolean, price: number): number {
  if (graduated) return 1;
  if (!(price > 0)) return 0;
  const virtualTokens = Math.sqrt((30 * 1_073_000_000) / price);
  const realLeft = virtualTokens - (1_073_000_000 - 793_100_000);
  return Math.min(1, Math.max(0, 1 - realLeft / 793_100_000));
}

function detail(coin: MockCoin): CoinDetail {
  return {
    ...summary(coin),
    description: coin.description,
    socials: coin.socials,
    launcher: coin.launcher,
    vaultAddress: mockAddress(`vault:${coin.mint}`),
    treasuryAddress: mockAddress(`treasury:${coin.mint}`),
    bondingCurve: mockAddress(`curve:${coin.mint}`),
    ammPool: coin.graduated ? mockAddress(`pool:${coin.mint}`) : null,
    roundId: coin.roundId,
    lastRound: coin.lastRound,
    hidden: false,
    hiddenReason: null,
  };
}

// ---- queries ---------------------------------------------------------------------------------

export function listCoins(sort: CoinSort = "newest", q = ""): CoinSummary[] {
  const needle = q.trim().toLowerCase();
  const items = allCoins()
    .filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.ticker.toLowerCase().includes(needle) || c.mint.toLowerCase() === needle)
    .map(summary);
  const by: Record<CoinSort, (a: CoinSummary, b: CoinSummary) => number> = {
    newest: (a, b) => b.createdAt - a.createdAt,
    trending: (a, b) => b.volume24hSol * (1 + Math.max(0, b.change24hPct) / 100) - a.volume24hSol * (1 + Math.max(0, a.change24hPct) / 100),
    vault_buying: (a, b) => Number(b.vaultBuying) - Number(a.vaultBuying) || b.vault.floorSol - a.vault.floorSol,
    top_payouts: (a, b) => b.paidOutSol - a.paidOutSol,
    biggest_vault: (a, b) => b.vault.floorSol - a.vault.floorSol,
  };
  const sorted = items.sort(by[sort]);
  return sort === "vault_buying" ? sorted.filter((c) => c.vaultBuying) : sorted;
}

export function coinDetail(mint: string): CoinDetail | null {
  const coin = getCoin(mint);
  return coin ? detail(coin) : null;
}

export function coinSummary(mint: string): CoinSummary | null {
  const coin = getCoin(mint);
  return coin ? summary(coin) : null;
}

export function candles(mint: string, tf: CandleTimeframe, limit = 320): CandlesResponse | null {
  const coin = getCoin(mint);
  if (!coin) return null;
  const out: Candle[] = [];
  for (const m of coin.minutes) {
    const t = candleBucket(m.t, tf);
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, m.h);
      last.l = Math.min(last.l, m.l);
      last.c = m.c;
      last.v += m.v;
    } else {
      out.push({ ...m, t });
    }
  }
  const window = out.slice(-limit);
  const from = window[0]?.t ?? coin.createdAt;
  const before = coin.floorLine.filter((p) => p.t < from);
  const floorLine = [...before.slice(-1), ...coin.floorLine.filter((p) => p.t >= from)];
  const defends = coin.defends.filter((d) => d.ts >= from).map((d) => ({ t: d.ts, price: d.price, solSpent: d.solSpent, sig: d.sig }));
  return { mint, tf, candles: window, floorLine, defends };
}

const WALLET_POOL = Array.from({ length: 160 }, (_, i) => mockAddress(`trader:${i}`));

function syntheticTrades(coin: MockCoin, minuteIndex: number): Trade[] {
  const m = coin.minutes[minuteIndex];
  if (!m) return [];
  const rand = seededRandom(hashString(`${coin.mint}:trades:${minuteIndex}`));
  const count = Math.min(6, Math.round(m.v / 0.35 + rand() * 0.8));
  const up = m.c >= m.o;
  const trades: Trade[] = [];
  for (let k = 0; k < count; k++) {
    const f = (k + 1) / (count + 1);
    const price = m.o + (m.c - m.o) * f;
    const sol = Math.max(0.01, (m.v / Math.max(1, count)) * (0.3 + rand() * 1.4));
    const side = rand() < (up ? 0.68 : 0.34) ? "buy" : "sell";
    trades.push({
      sig: mockSignature(`${coin.mint}:${minuteIndex}:${k}`),
      wallet: WALLET_POOL[Math.floor(rand() * WALLET_POOL.length)]!,
      side,
      sol,
      tokens: sol / price,
      price,
      ts: m.t + Math.floor(f * 59_000),
      source: coin.graduated ? "pumpswap" : "curve",
    });
  }
  for (const d of coin.defends) {
    if (d.ts >= m.t && d.ts < m.t + MINUTE) {
      trades.push({
        sig: d.sig,
        wallet: mockAddress(`vault:${coin.mint}`),
        side: "vault",
        sol: d.solSpent,
        tokens: d.tokensBought,
        price: d.price,
        ts: d.ts,
        source: "vault",
      });
    }
  }
  return trades.sort((a, b) => b.ts - a.ts);
}

export function tradesPage(mint: string, limit = 40, before?: string | null): { items: Trade[]; nextCursor: string | null } | null {
  const coin = getCoin(mint);
  if (!coin) return null;
  const items: Trade[] = [];
  // Cursor space counts down: [0, genMinutes) are simulated minutes, [genMinutes, +live) live trades in order.
  let cursor = before ? Number(before) : coin.genMinutes + coin.liveTrades.length;
  while (items.length < limit && cursor > 0) {
    cursor -= 1;
    if (cursor >= coin.genMinutes) {
      const live = coin.liveTrades[cursor - coin.genMinutes];
      if (live) items.push(live);
    } else {
      items.push(...syntheticTrades(coin, cursor));
    }
  }
  return { items, nextCursor: cursor > 0 ? String(cursor) : null };
}

export function defendsList(mint: string, limit = 50): DefendEvent[] | null {
  const coin = getCoin(mint);
  if (!coin) return null;
  return [...coin.defends].reverse().slice(0, limit);
}

export function roundsList(mint: string, limit = 20): RoundSummary[] | null {
  const coin = getCoin(mint);
  if (!coin) return null;
  const out: RoundSummary[] = [];
  if (coin.lastRound) out.push(coin.lastRound);
  for (let i = 1; i < limit && coin.roundId - i > 0; i++) {
    const r = seededRandom(hashString(`${coin.mint}:round:${coin.roundId - i}`));
    out.push({
      roundId: coin.roundId - i,
      ts: (coin.lastRound?.ts ?? Date.now()) - i * ROUND_MS,
      solPot: coin.activity * 2 * 0.35 * CREATOR_FEE_RATE * 0.3 * (0.6 + r()),
      tokenPot: r() > 0.8 ? 1000 + r() * 50_000 : 0,
      recipients: Math.max(1, Math.round(coin.holderCount * (0.7 + r() * 0.2))),
      snapshotHash: mockSignature(`${coin.mint}:${i}`).slice(0, 32),
      status: "closed",
      openSig: mockSignature(`${coin.mint}:open:${coin.roundId - i}`),
      closeSig: mockSignature(`${coin.mint}:close:${coin.roundId - i}`),
    });
  }
  return out;
}

// ---- holders & positions ---------------------------------------------------------------------

const DEMO_HOLDINGS: Record<string, { amount: number; ageMs: number }[]> = {
  KELP: [
    { amount: 4_200_000, ageMs: 2.8 * DAY },
    { amount: 1_150_000, ageMs: 1.2 * DAY },
    { amount: 640_000, ageMs: 3 * HOUR },
  ],
  LAVA: [{ amount: 2_600_000, ageMs: 20 * HOUR }],
  ANCHR: [
    { amount: 9_800_000, ageMs: 1.9 * DAY },
    { amount: 2_000_000, ageMs: 30 * MINUTE },
  ],
  CRAB: [{ amount: 5_400_000, ageMs: 3.9 * DAY }],
  FROG: [
    { amount: 3_100_000, ageMs: 12 * HOUR },
    { amount: 900_000, ageMs: 2 * HOUR },
  ],
  TIDE: [{ amount: 7_500_000, ageMs: 40 * MINUTE }],
};

function holdersFor(coin: MockCoin): MockHolderRecord[] {
  if (coin.holders) return coin.holders;
  const rand = seededRandom(hashString(`${coin.mint}:holders`));
  const now = BOOT;
  const age = Math.max(MINUTE, now - coin.createdAt);
  const count = Math.min(48, Math.max(8, Math.round(coin.holderCount * 0.4)));
  const used = new Set<string>();
  const records: MockHolderRecord[] = [];
  for (let i = 0; i < count; i++) {
    let wallet = WALLET_POOL[Math.floor(rand() * WALLET_POOL.length)]!;
    while (used.has(wallet)) wallet = WALLET_POOL[Math.floor(rand() * WALLET_POOL.length)]!;
    used.add(wallet);
    const total = 30_000_000 * rand() ** 2.4 + 120_000;
    const nLots = 1 + Math.floor(rand() * 3);
    const lots = Array.from({ length: nLots }, () => ({
      amount: total / nLots,
      acquiredAt: now - Math.floor(age * rand() ** 1.3),
    })).sort((a, b) => a.acquiredAt - b.acquiredAt);
    records.push({ wallet, lots, transferred: rand() > 0.85 ? total * rand() * 0.6 : 0, devBuy: 0 });
  }
  if (coin.launcher) {
    records.push({ wallet: coin.launcher, lots: [], transferred: 0, devBuy: 12_000_000 + rand() * 20_000_000 });
  }
  const demo = DEMO_HOLDINGS[coin.ticker];
  if (demo) {
    records.push({
      wallet: MOCK_WALLET,
      lots: demo.map((l) => ({ amount: l.amount, acquiredAt: Math.max(coin.createdAt, now - l.ageMs) })),
      transferred: 0,
      devBuy: 0,
    });
  }
  coin.holders = records;
  return records;
}

function holderRows(coin: MockCoin): Holder[] {
  const now = Date.now();
  const rows = holdersFor(coin).map((r) => {
    const eligibleTokens = r.lots.reduce((s, l) => s + l.amount, 0);
    const weightedTokens = r.lots.reduce((s, l) => s + l.amount * weightMultiplier(l.acquiredAt, now), 0);
    return { r, eligibleTokens, weightedTokens };
  });
  const totalWeight = rows.reduce((s, x) => s + x.weightedTokens, 0) || 1;
  return rows
    .map(({ r, eligibleTokens, weightedTokens }) => {
      const share = weightedTokens / totalWeight;
      const tenure = r.lots[0] ? Math.min(1, (now - r.lots[0].acquiredAt) / Math.max(MINUTE, now - coin.createdAt)) : 0;
      return {
        wallet: r.wallet,
        tokens: eligibleTokens + r.transferred + r.devBuy,
        eligibleTokens,
        weightedTokens,
        weightMultiplier: eligibleTokens > 0 ? weightedTokens / eligibleTokens : 0,
        share,
        earnedSol: coin.paidOutSol * share * tenure,
        earnedTokens: coin.paidOutTokens * share * tenure,
        oldestLotAt: r.lots[0]?.acquiredAt ?? null,
      } satisfies Holder;
    })
    .sort((a, b) => b.weightedTokens - a.weightedTokens || b.tokens - a.tokens);
}

/** Raw holder records (lots), for building verifiable mock round snapshots. */
export function holderRecords(mint: string): MockHolderRecord[] | null {
  const coin = getCoin(mint);
  return coin ? holdersFor(coin) : null;
}

export function holdersList(mint: string, limit = 50): Holder[] | null {
  const coin = getCoin(mint);
  if (!coin) return null;
  return holderRows(coin).slice(0, limit);
}

function positionFor(coin: MockCoin, wallet: string): Position | null {
  const holder = holderRows(coin).find((h) => h.wallet === wallet);
  const record = holdersFor(coin).find((r) => r.wallet === wallet);
  if (!holder || !record) return null;
  const now = Date.now();
  const price = lastPrice(coin);
  return {
    mint: coin.mint,
    name: coin.name,
    ticker: coin.ticker,
    imageUrl: coin.imageUrl,
    tokens: holder.tokens,
    eligibleTokens: holder.eligibleTokens,
    weightedTokens: holder.weightedTokens,
    weightMultiplier: holder.weightMultiplier,
    share: holder.share,
    valueSol: holder.tokens * price,
    earnedSol: holder.earnedSol,
    earnedTokens: holder.earnedTokens,
    nextPayoutEstimateSol: coin.vault.holderSol * holder.share,
    lots: record.lots.map((l) => ({ amount: l.amount, acquiredAt: l.acquiredAt, weight: weightMultiplier(l.acquiredAt, now) })),
    ...pnlOf(coin, record, holder, price),
  };
}

/** Lots were bought at the path's price at the time; transfers in and the dev buy cost nothing here. */
function pnlOf(coin: MockCoin, record: MockHolderRecord, holder: Holder, price: number) {
  const boughtSol = record.lots.reduce((s, l) => s + l.amount * priceAt(coin, l.acquiredAt), 0);
  const soldSol = 0;
  const { pnlSol, pnlPct } = positionPnl({ boughtSol, soldSol, valueSol: holder.tokens * price, earnedSol: holder.earnedSol, earnedTokensValueSol: holder.earnedTokens * price });
  return { boughtSol, soldSol, pnlSol, pnlPct };
}

export function position(wallet: string, mint: string): Position | null {
  const coin = getCoin(mint);
  return coin ? positionFor(coin, wallet) : null;
}

export function profile(wallet: string): Profile {
  const positions: Position[] = [];
  for (const coin of allCoins()) {
    const p = positionFor(coin, wallet);
    if (p) positions.push(p);
  }
  positions.sort((a, b) => b.valueSol - a.valueSol);
  const totalEarnedSol = positions.reduce((s, p) => s + p.earnedSol, 0);
  const totalEarnedTokensValueSol = positions.reduce((s, p) => s + p.earnedTokens * lastPrice(coins.get(p.mint)!), 0);
  const recentPayouts: Profile["recentPayouts"] = [];
  const now = Date.now();
  const lastRoundAt = nextRoundAt(now) - ROUND_MS;
  for (const p of positions) {
    const coin = coins.get(p.mint)!;
    const rand = seededRandom(hashString(`${wallet}:${p.mint}:payouts`));
    for (let i = 0; i < 8; i++) {
      const pot = coin.activity * 2 * 0.35 * CREATOR_FEE_RATE * 0.3 * (0.5 + rand());
      const tokens = rand() > 0.75 ? p.share * (2_000 + rand() * 80_000) : 0;
      recentPayouts.push({
        mint: p.mint,
        ticker: p.ticker,
        roundId: coin.roundId - i,
        sol: pot * p.share,
        tokens,
        ts: lastRoundAt - i * ROUND_MS + Math.floor(rand() * 20_000),
        sig: mockSignature(`${wallet}:${p.mint}:${i}`),
      });
    }
  }
  recentPayouts.sort((a, b) => b.ts - a.ts);
  return {
    wallet,
    totalEarnedSol,
    totalEarnedTokensValueSol,
    totalValueSol: positions.reduce((s, p) => s + p.valueSol, 0),
    totalPnlSol: positions.reduce((s, p) => s + p.pnlSol, 0),
    launchedCoins: allCoins().filter((c) => c.launcher === wallet).length,
    positions,
    recentPayouts: recentPayouts.slice(0, 30),
  };
}

export function stats(): Stats {
  const list = allCoins();
  const now = Date.now();
  let defends24h = 0;
  for (const c of list) for (const d of c.defends) if (d.ts >= now - DAY) defends24h++;
  const summaries = list.map(summary);
  return {
    coins: list.length,
    totalVaultSol: list.reduce((s, c) => s + c.vault.floorSol, 0),
    totalPaidSol: list.reduce((s, c) => s + c.paidOutSol, 0),
    defends24h,
    volume24hSol: summaries.reduce((s, c) => s + c.volume24hSol, 0),
    schedule: { roundIntervalSec: ROUND_INTERVAL_SECONDS, nextRoundAt: nextRoundAt(now), serverTime: now },
    solUsd: Math.round((152 + 3 * Math.sin(now / (6 * HOUR))) * 100) / 100,
  };
}

// ---- live simulation (driven by the mock socket) ---------------------------------------------

export interface LiveTick {
  trades: Trade[];
  vault: VaultSnapshot;
}

/** Simulate one market trade (and a vault buyback when the floor is touched). */
export function simulateTrade(mint: string): LiveTick | null {
  const coin = getCoin(mint);
  if (!coin) return null;
  const now = Date.now();
  const price = lastPrice(coin);
  const floor = coin.vault.floorPrice;
  const rand = coin.rand;
  const nearFloor = floor > 0 && price < floor * 1.03;
  const buyBias = nearFloor ? 0.46 : 0.53;
  const side: "buy" | "sell" = rand() < buyBias ? "buy" : "sell";
  const sol = Math.max(0.01, coin.activity * (0.08 + rand() ** 2 * 1.4));
  const impact = (sol / (30 + marketCapSol(price) * 0.25)) * (side === "buy" ? 1 : -1);
  const next = price * (1 + impact + gaussian(rand) * 0.002);
  const trades: Trade[] = [];
  const trade: Trade = {
    sig: randomSignature(),
    wallet: WALLET_POOL[Math.floor(rand() * WALLET_POOL.length)]!,
    side,
    sol,
    tokens: sol / ((price + next) / 2),
    price: next,
    ts: now,
    source: coin.graduated ? "pumpswap" : "curve",
  };
  pushPrice(coin, next, sol, now);
  coin.liveTrades.push(trade);
  trades.push(trade);
  splitFee(coin, sol * CREATOR_FEE_RATE);

  const defend = tryDefend(coin, now + 1, next);
  if (defend) {
    const bounced = next * (1 + 0.02 + rand() * 0.03);
    const vaultTrade: Trade = {
      sig: defend.sig,
      wallet: mockAddress(`vault:${coin.mint}`),
      side: "vault",
      sol: defend.solSpent,
      tokens: defend.tokensBought,
      price: bounced,
      ts: now + 1,
      source: "vault",
    };
    pushPrice(coin, bounced, defend.solSpent, now + 1);
    coin.liveTrades.push(vaultTrade);
    trades.push(vaultTrade);
  }
  updateAthFromRecent(coin, now);
  return { trades, vault: vaultSnapshot(coin) };
}

function pushPrice(coin: MockCoin, price: number, sol: number, ts: number) {
  const t = Math.floor(ts / MINUTE) * MINUTE;
  const last = coin.minutes[coin.minutes.length - 1];
  if (last && last.t === t) {
    last.h = Math.max(last.h, price);
    last.l = Math.min(last.l, price);
    last.c = price;
    last.v += sol;
  } else {
    const o = last?.c ?? price;
    coin.minutes.push({ t, o, h: Math.max(o, price), l: Math.min(o, price), c: price, v: sol });
  }
  if (marketCapSol(price) >= GRADUATION_MC_SOL) coin.graduated = true;
}

function updateAthFromRecent(coin: MockCoin, now: number) {
  const recent = coin.minutes.slice(-TWAP_WINDOW_MIN);
  const twap = recent.reduce((s, m) => s + m.c, 0) / Math.max(1, recent.length);
  raiseAth(coin, twap, now);
}

/** Current round number for a coin after settling elapsed rounds (used to emit `round` messages). */
export function roundState(mint: string): { roundId: number; lastRound: RoundSummary | null; vault: VaultSnapshot } | null {
  const coin = getCoin(mint);
  if (!coin) return null;
  return { roundId: coin.roundId, lastRound: coin.lastRound, vault: vaultSnapshot(coin) };
}

// ---- launches --------------------------------------------------------------------------------

const LAUNCHED_KEY = "holdfast:mock-launched-coins";

interface LaunchedMeta {
  mint: string;
  req: LaunchRequest;
  createdAt: number;
  launcher: string | null;
}

function registerLaunchedCoin(meta: LaunchedMeta): MockCoin {
  const existing = coins.get(meta.mint);
  if (existing) return existing;
  const { req } = meta;
  const devTokens = req.devBuySol ? req.devBuySol / LAUNCH_PRICE / (1 + req.devBuySol / 30) : 0;
  const start = LAUNCH_PRICE * (1 + (req.devBuySol ?? 0) / 30) ** 2;
  const t = Math.floor(meta.createdAt / MINUTE) * MINUTE;
  const coin: MockCoin = {
    mint: meta.mint,
    name: req.name,
    ticker: req.ticker.toUpperCase(),
    description: req.description ?? "",
    imageUrl: req.imageUrl ?? null,
    socials: req.socials ?? {},
    triggerBps: req.triggerBps,
    createdAt: meta.createdAt,
    launcher: meta.launcher,
    activity: 0.6,
    minutes: [{ t, o: LAUNCH_PRICE, h: start, l: LAUNCH_PRICE, c: start, v: req.devBuySol ?? 0 }],
    genMinutes: 0,
    floorLine: [],
    defends: [],
    vault: emptyVault(),
    paidOutSol: 0,
    paidOutTokens: 0,
    graduated: false,
    roundId: 0,
    lastRound: null,
    accruedTo: meta.createdAt,
    liveTrades: [],
    holderCount: devTokens > 0 ? 1 : 0,
    holders: devTokens > 0 && meta.launcher ? [{ wallet: meta.launcher, lots: [], transferred: 0, devBuy: devTokens }] : [],
    rand: seededRandom(hashString(meta.mint)),
  };
  raiseAth(coin, start, meta.createdAt);
  if (devTokens > 0) {
    coin.liveTrades.push({
      sig: mockSignature(`${meta.mint}:devbuy`),
      wallet: meta.launcher ?? mockAddress(`depositor:${meta.mint}`),
      side: "buy",
      sol: req.devBuySol ?? 0,
      tokens: devTokens,
      price: start,
      ts: meta.createdAt,
      source: "curve",
    });
  }
  coins.set(coin.mint, coin);
  return coin;
}

function restoreLaunchedCoins() {
  try {
    const raw = sessionStorage.getItem(LAUNCHED_KEY);
    if (!raw) return;
    for (const meta of JSON.parse(raw) as LaunchedMeta[]) registerLaunchedCoin(meta);
  } catch {
    // storage unavailable
  }
}

export function launchCoin(meta: LaunchedMeta): string {
  ensureMarket();
  if (coins.has(meta.mint)) return meta.mint;
  registerLaunchedCoin(meta);
  try {
    const raw = sessionStorage.getItem(LAUNCHED_KEY);
    const list = raw ? (JSON.parse(raw) as LaunchedMeta[]) : [];
    list.push(meta);
    sessionStorage.setItem(LAUNCHED_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable or image too large to persist; the coin still lives in memory
  }
  return meta.mint;
}

export { LAUNCH_PRICE };

// ---- portfolio, leaderboards, creators, comments ------------------------------------------------

/** A wallet's buys, one per purchase lot, newest first. */
export function walletTrades(wallet: string): WalletTrade[] {
  const out: WalletTrade[] = [];
  for (const coin of allCoins()) {
    const record = holdersFor(coin).find((r) => r.wallet === wallet);
    if (!record) continue;
    record.lots.forEach((l, i) => {
      const price = priceAt(coin, l.acquiredAt);
      out.push({ sig: mockSignature(`${wallet}:${coin.mint}:buy:${i}`), wallet, side: "buy", sol: l.amount * price, tokens: l.amount, price, ts: l.acquiredAt, source: coin.graduated ? "pumpswap" : "curve", mint: coin.mint, ticker: coin.ticker, name: coin.name });
    });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

export function leaderboard(kind: LeaderboardKind, limit = 50): Leaderboard {
  const list = allCoins();
  switch (kind) {
    case "earners": {
      const by = new Map<string, { earnedSol: number; coins: number; payouts: number }>();
      for (const coin of list)
        for (const h of holderRows(coin)) {
          if (h.earnedSol <= 0) continue;
          const e = by.get(h.wallet) ?? { earnedSol: 0, coins: 0, payouts: 0 };
          e.earnedSol += h.earnedSol;
          e.coins += 1;
          e.payouts += Math.max(1, Math.round(coin.roundId * 0.6));
          by.set(h.wallet, e);
        }
      const items = [...by.entries()].map(([wallet, e]) => ({ wallet, ...e })).sort((a, b) => b.earnedSol - a.earnedSol);
      return { kind, items: items.slice(0, limit) };
    }
    case "diamond_hands": {
      const best = new Map<string, { wallet: string; mint: string; ticker: string; heldSince: number; tokens: number }>();
      for (const coin of list)
        for (const r of holdersFor(coin)) {
          const first = r.lots[0];
          if (!first) continue;
          const cur = best.get(r.wallet);
          if (!cur || first.acquiredAt < cur.heldSince) best.set(r.wallet, { wallet: r.wallet, mint: coin.mint, ticker: coin.ticker, heldSince: first.acquiredAt, tokens: r.lots.reduce((s, l) => s + l.amount, 0) });
        }
      return { kind, items: [...best.values()].sort((a, b) => a.heldSince - b.heldSince).slice(0, limit) };
    }
    case "creators": {
      const by = new Map<string, MockCoin[]>();
      for (const coin of list) if (coin.launcher) by.set(coin.launcher, [...(by.get(coin.launcher) ?? []), coin]);
      const items = [...by.entries()].map(([wallet, cs]) => ({
        wallet,
        coins: cs.length,
        paidToHoldersSol: cs.reduce((s, c) => s + c.paidOutSol, 0),
        totalFeesSol: cs.reduce((s, c) => s + (c.paidOutSol + c.vault.holderSol) / (SPLIT_HOLDER_BPS / 10_000), 0),
        firstLaunchAt: Math.min(...cs.map((c) => c.createdAt)),
      }));
      return { kind, items: items.sort((a, b) => b.paidToHoldersSol - a.paidToHoldersSol).slice(0, limit) };
    }
    case "coins":
      return { kind, items: listCoins("top_payouts").slice(0, limit) };
  }
}

export function creator(wallet: string): CreatorProfile {
  const mine = allCoins().filter((c) => c.launcher === wallet);
  const summaries = mine.map(summary).sort((a, b) => b.createdAt - a.createdAt);
  return {
    wallet,
    coinCount: mine.length,
    paidToHoldersSol: mine.reduce((s, c) => s + c.paidOutSol, 0),
    totalFeesSol: mine.reduce((s, c) => s + (c.paidOutSol + c.vault.holderSol) / (SPLIT_HOLDER_BPS / 10_000), 0),
    firstLaunchAt: mine.length ? Math.min(...mine.map((c) => c.createdAt)) : null,
    coinsAboveFloor: summaries.filter((c) => c.vault.floorPrice > 0 && c.price > c.vault.floorPrice).length,
    coins: summaries,
  };
}

const COMMENT_LINES = [
  "floor held again, vault bought the dip 🛡",
  "my multiplier just hit 1.00×, not selling",
  "payouts every 2 min is wild",
  "who else is holding since day one?",
  "chart looks like a staircase lol",
  "dev has no allocation, love it",
  "just got 0.004 SOL from the last round",
  "ATH ratchet means the floor only goes up",
];

const comments = new Map<string, Comment[]>();
let commentSeq = 1;

function commentsFor(coin: MockCoin): Comment[] {
  let list = comments.get(coin.mint);
  if (list) return list;
  const rand = seededRandom(hashString(`${coin.mint}:comments`));
  const rows = holderRows(coin);
  const n = 3 + Math.floor(rand() * 6);
  list = [];
  for (let i = 0; i < n; i++) {
    const h = rows[Math.floor(rand() * Math.min(rows.length, 20))];
    const wallet = h?.wallet ?? WALLET_POOL[i]!;
    list.push({
      id: commentSeq++,
      mint: coin.mint,
      wallet,
      body: COMMENT_LINES[Math.floor(rand() * COMMENT_LINES.length)]!,
      replyTo: null,
      createdAt: BOOT - Math.floor(rand() * Math.min(DAY, BOOT - coin.createdAt)),
      holder: Boolean(h && h.eligibleTokens > 0),
      weightMultiplier: h && h.eligibleTokens > 0 ? h.weightMultiplier : null,
      isCreator: wallet === coin.launcher,
      hidden: false,
    });
  }
  list.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  comments.set(coin.mint, list);
  return list;
}

export function commentsPage(mint: string, limit = 50, before?: string | null): { items: Comment[]; nextCursor: string | null } | null {
  const coin = getCoin(mint);
  if (!coin) return null;
  const all = commentsFor(coin);
  const start = before ? all.findIndex((c) => c.id < Number(before)) : 0;
  if (start < 0) return { items: [], nextCursor: null };
  const items = all.slice(start, start + limit);
  return { items, nextCursor: start + limit < all.length ? String(items[items.length - 1]!.id) : null };
}

export function postComment(mint: string, req: PostCommentRequest): Comment | null {
  const coin = getCoin(mint);
  if (!coin) return null;
  const h = holderRows(coin).find((x) => x.wallet === req.wallet);
  const c: Comment = {
    id: commentSeq++,
    mint,
    wallet: req.wallet,
    body: req.body.trim(),
    replyTo: req.replyTo ?? null,
    createdAt: Date.now(),
    holder: Boolean(h && h.eligibleTokens > 0),
    weightMultiplier: h && h.eligibleTokens > 0 ? h.weightMultiplier : null,
    isCreator: req.wallet === coin.launcher,
    hidden: false,
  };
  commentsFor(coin).unshift(c);
  return c;
}
