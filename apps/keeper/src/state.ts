import type { PublicKey } from "@solana/web3.js";
import {
  bondingCurveSpot,
  canonicalPoolPda,
  decodeBondingCurve,
  decodeCoinVault,
  decodePool,
  decodeTokenAccount,
  poolSpot,
  type BondingCurveState,
  type CoinKeys,
  type CoinVaultAccount,
  type PoolState,
  type PriceAccounts,
} from "@holdfast/chain";

import type { KeeperChain } from "./chain.js";

export interface PoolView extends PoolState {
  address: PublicKey;
  baseAmount: bigint;
  quoteAmount: bigint;
}

/** On-chain view of one coin, read in one batch. */
export interface CoinChainState {
  coin: CoinKeys;
  vault: CoinVaultAccount;
  curve: BondingCurveState;
  /** Canonical pool, when it exists (always after graduation, sometimes right before). */
  pool: PoolView | null;
  /** Spot price on the coin's current venue (fixed point, same as on-chain). */
  spot: bigint;
  priceAccounts: PriceAccounts;
}

export async function loadPool(chain: KeeperChain, mint: PublicKey): Promise<PoolView | null> {
  const address = canonicalPoolPda(mint);
  const [info] = await chain.getAccounts([address]);
  if (!info) return null;
  const pool = decodePool(info.data);
  const [base, quote] = await chain.getAccounts([pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount]);
  if (!base || !quote) return null;
  return { ...pool, address, baseAmount: decodeTokenAccount(base.data).amount, quoteAmount: decodeTokenAccount(quote.data).amount };
}

export async function loadCoinState(chain: KeeperChain, coin: CoinKeys): Promise<CoinChainState | null> {
  const [vaultInfo, curveInfo] = await chain.getAccounts([coin.vault, coin.bondingCurve]);
  if (!vaultInfo || !curveInfo) return null;
  const vault = decodeCoinVault(vaultInfo.data);
  const curve = decodeBondingCurve(curveInfo.data);
  const pool = vault.venue === "amm" || curve.complete ? await loadPool(chain, coin.mint) : null;

  if (vault.venue === "amm") {
    if (!pool) throw new Error(`vault ${coin.vault.toBase58()} is on PumpSwap but its pool is missing`);
    return {
      coin,
      vault,
      curve,
      pool,
      spot: poolSpot(pool, pool.baseAmount, pool.quoteAmount),
      priceAccounts: { priceAccount: pool.address, poolBaseAccount: pool.poolBaseTokenAccount, poolQuoteAccount: pool.poolQuoteTokenAccount },
    };
  }
  return { coin, vault, curve, pool, spot: bondingCurveSpot(curve), priceAccounts: { priceAccount: coin.bondingCurve } };
}
