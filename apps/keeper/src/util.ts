import { PublicKey } from "@solana/web3.js";
import { coinKeys, type CoinKeys, type CoinVaultAccount } from "@holdfast/chain";
import { listCoins, upsertVaultState, type Db } from "@holdfast/db";

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function loadCoinKeys(db: Db): Promise<CoinKeys[]> {
  const coins = await listCoins(db);
  return coins.map((c) => coinKeys(new PublicKey(c.mint), new PublicKey(c.tokenProgram)));
}

export async function mirrorVault(db: Db, coin: CoinKeys, v: CoinVaultAccount, slot = 0): Promise<void> {
  await upsertVaultState(db, {
    mint: coin.mint.toBase58(),
    floorSol: v.floorSol,
    holderSol: v.holderSol,
    burnSol: v.burnSol,
    holderTokens: v.holderTokens,
    ath: v.athPrice,
    floor: v.floorPrice,
    defendCount: v.defendCount,
    lastDefendTs: v.lastDefendTs > 0 ? v.lastDefendTs * 1000 : null,
    roundId: v.roundId,
    totalFees: v.totalFees,
    totalDefended: v.totalDefendedSol,
    totalPaidSol: v.totalPaidSol,
    totalPaidTokens: v.totalPaidTokens,
    totalBurnedSol: v.totalBurnSol,
    slot,
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
