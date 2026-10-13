/**
 * Everything pump.fun-specific the keeper sends, built with the official SDKs so account lists keep
 * up with pump.fun upgrades without touching the vault program (its CPIs pass these lists through).
 */
import { createRequire } from "node:module";
import BN from "bn.js";
import { Connection, PublicKey, type AccountMeta, type TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { Global, OnlinePumpSdk as OnlinePumpSdkType } from "@pump-fun/pump-sdk";
import type { OnlinePumpAmmSdk as OnlinePumpAmmSdkType } from "@pump-fun/pump-swap-sdk";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, type CoinKeys } from "@holdfast/chain";

// The SDKs' ESM builds import named exports from anchor's CommonJS build, which Node ESM rejects;
// their CommonJS builds work, so load them through require.
const require = createRequire(import.meta.url);
const { OnlinePumpSdk, PUMP_SDK, getFeeRecipient } = require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");
const { OnlinePumpAmmSdk, PUMP_AMM_SDK } = require("@pump-fun/pump-swap-sdk") as typeof import("@pump-fun/pump-swap-sdk");

export interface PumpGateway {
  /** pump `buy` / `buy_exact_sol_in` account list (identical) with `user` as buyer. */
  curveBuyAccounts(mint: PublicKey, user: PublicKey, tokenProgram: PublicKey, creator: PublicKey): Promise<AccountMeta[]>;
  /** PumpSwap `buy` / `buy_exact_quote_in` account list (identical) with `user` as buyer. */
  ammBuyAccounts(pool: PublicKey, user: PublicKey): Promise<AccountMeta[]>;
  /** Permissionless sweeps + claims that move the coin's creator fees into its treasury. */
  feeClaimInstructions(coin: CoinKeys, payer: PublicKey, graduated: boolean): Promise<TransactionInstruction[]>;
  /** Pre-creates the treasury's volume accumulator so vault buys never pay rent. */
  initAccumulatorInstruction(payer: PublicKey, user: PublicKey, venue: "curve" | "amm"): Promise<TransactionInstruction>;
}

const GLOBAL_TTL_MS = 5 * 60_000;

export class SdkPumpGateway implements PumpGateway {
  private readonly online: OnlinePumpSdkType;
  private readonly onlineAmm: OnlinePumpAmmSdkType;
  private global: { value: Global; at: number } | null = null;

  constructor(connection: Connection) {
    this.online = new OnlinePumpSdk(connection);
    this.onlineAmm = new OnlinePumpAmmSdk(connection);
  }

  private async fetchGlobal(): Promise<Global> {
    if (!this.global || Date.now() - this.global.at > GLOBAL_TTL_MS) {
      this.global = { value: await this.online.fetchGlobal(), at: Date.now() };
    }
    return this.global.value;
  }

  async curveBuyAccounts(mint: PublicKey, user: PublicKey, tokenProgram: PublicKey, creator: PublicKey): Promise<AccountMeta[]> {
    const global = await this.fetchGlobal();
    const buyback = (global.buybackFeeRecipients ?? []).filter((k) => !k.equals(PublicKey.default));
    const ix = await PUMP_SDK.getBuyInstructionRaw({
      user,
      mint,
      creator,
      amount: new BN(1),
      solAmount: new BN(1),
      feeRecipient: getFeeRecipient(global, false),
      buybackFeeRecipient: buyback[Math.floor(Math.random() * buyback.length)] ?? getFeeRecipient(global, false),
      tokenProgram,
    });
    return ix.keys;
  }

  async ammBuyAccounts(pool: PublicKey, user: PublicKey): Promise<AccountMeta[]> {
    const state = await this.onlineAmm.swapSolanaState(pool, user);
    const ixs = await PUMP_AMM_SDK.buyInstructionsNoPool(state, new BN(1), new BN(1));
    const buy = ixs.find((ix) => ix.programId.equals(PUMP_AMM_PROGRAM_ID) && ix.keys.length >= 23);
    if (!buy) throw new Error("PumpSwap SDK did not produce a buy instruction");
    return buy.keys;
  }

  async feeClaimInstructions(coin: CoinKeys, payer: PublicKey, graduated: boolean): Promise<TransactionInstruction[]> {
    const ixs: TransactionInstruction[] = [
      await PUMP_SDK.sweepCreatorFeeInstruction({ payer, mint: coin.mint, creator: coin.treasury, quoteMint: NATIVE_MINT }),
    ];
    if (graduated) {
      ixs.push(await PUMP_SDK.sweepPoolCreatorFeeInstruction({ payer, mint: coin.mint, coinCreator: coin.treasury, quoteMint: NATIVE_MINT }));
    }
    ixs.push(...(await this.online.collectCoinCreatorFeeV2Instructions(coin.treasury, NATIVE_MINT, TOKEN_PROGRAM_ID, payer)));
    return ixs;
  }

  async initAccumulatorInstruction(payer: PublicKey, user: PublicKey, venue: "curve" | "amm"): Promise<TransactionInstruction> {
    return venue === "curve" ? PUMP_SDK.initUserVolumeAccumulator({ payer, user }) : PUMP_AMM_SDK.initUserVolumeAccumulator({ payer, user });
  }
}

export function userVolumeAccumulator(user: PublicKey, venue: "curve" | "amm"): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), user.toBuffer()],
    venue === "curve" ? PUMP_PROGRAM_ID : PUMP_AMM_PROGRAM_ID,
  )[0];
}
