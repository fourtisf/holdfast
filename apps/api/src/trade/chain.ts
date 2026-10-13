import type { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { PublicKey as PK } from "@solana/web3.js";
import type BN from "bn.js";
import type { BondingCurve, FeeConfig, Global } from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, type SwapSolanaState } from "@pump-fun/pump-swap-sdk";
import { canonicalPoolPda } from "@holdfast/chain";
import type { CoinRow } from "@holdfast/db";
import { HttpError } from "../errors.js";
import { pumpSdk } from "./sdk.js";

/** Everything needed to quote and build a bonding-curve trade offline. */
export interface CurveVenue {
  venue: "curve";
  mint: PublicKey;
  global: Global;
  feeConfig: FeeConfig | null;
  bondingCurve: BondingCurve;
  bondingCurveAccountInfo: AccountInfo<Buffer>;
  /** The wallet's token account for the coin (null → the buy creates it). */
  associatedUserAccountInfo: AccountInfo<Buffer> | null;
  mintSupply: BN;
  tokenProgram: PublicKey;
  quoteTokenProgram: PublicKey;
}

export interface AmmVenue {
  venue: "pumpswap";
  swap: SwapSolanaState;
}

export type VenueState = CurveVenue | AmmVenue;

/** Chain access for /trade/*, behind an interface so tests run without RPC. */
export interface TradeChain {
  loadVenue(coin: CoinRow, wallet: PublicKey): Promise<VenueState>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
}

/** Live implementation over the official SDKs (OnlinePumpSdk / OnlinePumpAmmSdk). */
export class RpcTradeChain implements TradeChain {
  private readonly pump: InstanceType<typeof pumpSdk.OnlinePumpSdk>;
  private readonly amm: OnlinePumpAmmSdk;

  constructor(private readonly connection: Connection) {
    this.pump = new pumpSdk.OnlinePumpSdk(connection);
    this.amm = new OnlinePumpAmmSdk(connection);
  }

  async loadVenue(coin: CoinRow, wallet: PublicKey): Promise<VenueState> {
    return rpcErrors(() => this.fetchVenue(coin, wallet));
  }

  private async fetchVenue(coin: CoinRow, wallet: PublicKey): Promise<VenueState> {
    const mint = new PK(coin.mint);
    const tokenProgram = new PK(coin.tokenProgram);
    if (!coin.graduated) {
      const [global, feeConfig, state] = await Promise.all([
        this.pump.fetchGlobal(),
        this.pump.fetchFeeConfig().catch(() => null),
        this.pump.fetchBuyState(mint, wallet, tokenProgram),
      ]);
      if (!state.bondingCurve.complete) {
        return {
          venue: "curve",
          mint,
          global,
          feeConfig,
          bondingCurve: state.bondingCurve,
          bondingCurveAccountInfo: state.bondingCurveAccountInfo,
          associatedUserAccountInfo: state.associatedUserAccountInfo,
          mintSupply: state.bondingCurve.tokenTotalSupply,
          tokenProgram,
          quoteTokenProgram: state.quoteTokenProgram,
        };
      }
    }
    const pool = coin.ammPool ? new PK(coin.ammPool) : canonicalPoolPda(mint);
    try {
      return { venue: "pumpswap", swap: await this.amm.swapSolanaState(pool, wallet) };
    } catch (err) {
      if (/Pool account not found/.test((err as Error).message)) throw new HttpError(409, "Bonding curve complete: the coin is migrating to PumpSwap, retry shortly");
      throw err;
    }
  }

  async latestBlockhash() {
    return rpcErrors(() => this.connection.getLatestBlockhash("confirmed"));
  }
}

/** RPC / network failures become 502s (and missing accounts 404s) instead of opaque 500s. */
async function rpcErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const message = (err as Error).message ?? String(err);
    if (/account not found/i.test(message)) throw new HttpError(404, message);
    throw new HttpError(502, `Solana RPC unavailable: ${message}`);
  }
}
