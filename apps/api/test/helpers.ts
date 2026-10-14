import { launchPlanFromEnv } from "@holdfast/chain";
import { launchCostSettings } from "../src/launch/settings.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { Global } from "@pump-fun/pump-sdk";
import type { GlobalConfig, Pool, SwapSolanaState } from "@pump-fun/pump-swap-sdk";
import { canonicalPoolPda, treasuryPda } from "@holdfast/chain";
import { createPgliteDb, migrate, type CoinRow, type Db } from "@holdfast/db";
import { buildApp, DbLaunchService, MemoryEventSource, type ApiConfig, type HoldfastApi, type TradeChain, type VenueState } from "../src/index.js";
import { pumpSdk } from "../src/trade/sdk.js";

export const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

export function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    databaseUrl: "pglite",
    port: 0,
    host: "127.0.0.1",
    rpcUrl: "http://127.0.0.1:1",
    corsOrigin: "http://localhost:3000",
    metadataDir: mkdtempSync(join(tmpdir(), "holdfast-meta-")),
    publicMetadataBaseUrl: "http://localhost:4000/metadata",
    rateLimitPerMinute: 0,
    statsIntervalMs: 0,
    wsHeartbeatMs: 30_000,
    launchTtlMs: 30 * 60_000,
    launchPlan: launchPlanFromEnv({}, { publicMetadataBaseUrl: "http://localhost:4000/metadata" }),
    depositMasterSecret: null,
    trade: { computeUnitPriceMicroLamports: 50_000, computeUnitLimitCurve: 250_000, computeUnitLimitAmm: 300_000 },
    logLevel: "silent",
    production: false,
    ...overrides,
  };
}

export async function freshDb(): Promise<Db> {
  const db = await createPgliteDb();
  await migrate(db);
  return db;
}

export async function resetDb(db: Db): Promise<void> {
  const res = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'");
  await db.exec(`TRUNCATE ${res.rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

export class FakeTradeChain implements TradeChain {
  venue: ((coin: CoinRow, wallet: PublicKey) => VenueState) | null = null;
  async loadVenue(coin: CoinRow, wallet: PublicKey): Promise<VenueState> {
    if (!this.venue) throw Object.assign(new Error("RPC unavailable"), { statusCode: 502 });
    return this.venue(coin, wallet);
  }
  async latestBlockhash() {
    return { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 123_456 };
  }
}

export interface TestApi extends HoldfastApi {
  events: MemoryEventSource;
  chain: FakeTradeChain;
  config: ApiConfig;
}

let depositCounter = 0;
export async function makeApi(db: Db, overrides: Partial<ApiConfig> = {}, now = () => NOW): Promise<TestApi> {
  const config = testConfig(overrides);
  const events = new MemoryEventSource();
  const chain = new FakeTradeChain();
  const launches = new DbLaunchService(db, async () => Keypair.fromSeed(Buffer.alloc(32, ++depositCounter)).publicKey.toBase58(), { ttlMs: config.launchTtlMs, cost: launchCostSettings(config), now });
  const api = await buildApp({ db, config, tradeChain: chain, launches, events, now });
  await api.app.ready();
  return { ...api, events, chain, config };
}

// ---- pump.fun SDK fixtures (offline) -------------------------------------------------------------

const keys = (n: number) => Array.from({ length: n }, () => Keypair.generate().publicKey);

export function fakeGlobal(): Global {
  return {
    initialized: true,
    authority: Keypair.generate().publicKey,
    feeRecipient: Keypair.generate().publicKey,
    initialVirtualTokenReserves: new BN("1073000000000000"),
    initialVirtualSolReserves: new BN("30000000000"),
    initialRealTokenReserves: new BN("793100000000000"),
    tokenTotalSupply: new BN("1000000000000000"),
    feeBasisPoints: new BN(95),
    withdrawAuthority: Keypair.generate().publicKey,
    enableMigrate: true,
    poolMigrationFee: new BN(15_000_001),
    creatorFeeBasisPoints: new BN(30),
    feeRecipients: keys(7),
    setCreatorAuthority: Keypair.generate().publicKey,
    adminSetCreatorAuthority: Keypair.generate().publicKey,
    createV2Enabled: true,
    whitelistPda: Keypair.generate().publicKey,
    reservedFeeRecipient: Keypair.generate().publicKey,
    mayhemModeEnabled: false,
    reservedFeeRecipients: keys(7),
    isCashbackEnabled: false,
    buybackFeeRecipients: keys(8),
    buybackBasisPoints: new BN(0),
    initialVirtualQuoteReserves: new BN("30000000000"),
    whitelistedQuoteMints: [],
    creatorFeeConfigurable: false,
    maxConfigurableCreatorFeeBps: new BN(0),
    holderRewardClaimAuthority: PublicKey.default,
    isHolderRewardEnabled: false,
    maxCurveDepth: 0,
  };
}

/** A live bonding curve after `solIn` lamports of buys, creator = the Holdfast treasury. */
export function curveVenue(mint: string, opts: { solIn?: bigint; hasTokenAccount?: boolean } = {}): VenueState {
  const global = fakeGlobal();
  const bc = pumpSdk.newBondingCurve(global);
  const solIn = new BN((opts.solIn ?? 5_000_000_000n).toString());
  const tokensOut = bc.virtualTokenReserves.mul(solIn).div(bc.virtualQuoteReserves.add(solIn));
  const bondingCurve = {
    ...bc,
    virtualQuoteReserves: bc.virtualQuoteReserves.add(solIn),
    virtualTokenReserves: bc.virtualTokenReserves.sub(tokensOut),
    realQuoteReserves: solIn,
    realTokenReserves: bc.realTokenReserves.sub(tokensOut),
    creator: treasuryPda(new PublicKey(mint)),
  };
  const info = { data: Buffer.alloc(166), executable: false, lamports: 1_000_000, owner: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P") };
  return {
    venue: "curve",
    mint: new PublicKey(mint),
    global,
    feeConfig: null,
    bondingCurve,
    bondingCurveAccountInfo: info,
    associatedUserAccountInfo: opts.hasTokenAccount ? { ...info, owner: TOKEN_2022_PROGRAM_ID } : null,
    mintSupply: global.tokenTotalSupply,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
  };
}

export function ammVenue(mint: string, user: PublicKey, opts: { virtualQuote?: bigint; hasTokenAccount?: boolean } = {}): VenueState {
  const baseMint = new PublicKey(mint);
  const poolKey = canonicalPoolPda(baseMint);
  const globalConfig: GlobalConfig = {
    admin: Keypair.generate().publicKey,
    lpFeeBasisPoints: new BN(20),
    protocolFeeBasisPoints: new BN(5),
    disableFlags: 0,
    protocolFeeRecipients: keys(8),
    coinCreatorFeeBasisPoints: new BN(5),
    adminSetCoinCreatorAuthority: Keypair.generate().publicKey,
    whitelistPda: Keypair.generate().publicKey,
    reservedFeeRecipient: Keypair.generate().publicKey,
    mayhemModeEnabled: false,
    reservedFeeRecipients: keys(8),
    isCashbackEnabled: false,
    buybackFeeRecipients: keys(8),
    buybackBasisPoints: new BN(0),
    boostAuthority: Keypair.generate().publicKey,
    boostEnabled: false,
    creatorFeeConfigurable: false,
    maxConfigurableCreatorFeeBps: new BN(0),
  };
  const pool: Pool = {
    poolBump: 255,
    index: 0,
    creator: Keypair.generate().publicKey,
    baseMint,
    quoteMint: NATIVE_MINT,
    lpMint: Keypair.generate().publicKey,
    poolBaseTokenAccount: Keypair.generate().publicKey,
    poolQuoteTokenAccount: Keypair.generate().publicKey,
    lpSupply: new BN(1_000_000_000),
    coinCreator: treasuryPda(baseMint),
    isMayhemMode: false,
    isCashbackCoin: false,
    virtualQuoteReserves: new BN((opts.virtualQuote ?? 0n).toString()),
    creatorFeeBps: new BN(0),
    canEditCreatorFee: false,
    isHolderReward: false,
    protocolFees: new BN(0),
    creatorFees: new BN(0),
  };
  const accountInfo = (owner: PublicKey, size: number) => ({ data: Buffer.alloc(size), executable: false, lamports: 2_039_280, owner });
  const swap: SwapSolanaState = {
    globalConfig,
    feeConfig: null,
    poolKey,
    poolAccountInfo: accountInfo(new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"), 300),
    pool,
    poolBaseAmount: new BN("200000000000000"),
    poolQuoteAmount: new BN("85000000000"),
    baseTokenProgram: TOKEN_2022_PROGRAM_ID,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    baseMint,
    baseMintAccount: {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1_000_000_000_000_000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    user,
    userBaseTokenAccount: Keypair.generate().publicKey,
    userQuoteTokenAccount: Keypair.generate().publicKey,
    userBaseAccountInfo: opts.hasTokenAccount ? accountInfo(TOKEN_2022_PROGRAM_ID, 170) : null,
    userQuoteAccountInfo: null,
  };
  return { venue: "pumpswap", swap };
}
