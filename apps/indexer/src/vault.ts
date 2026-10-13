import { PublicKey, type Connection } from "@solana/web3.js";
import { decodeCoinVault, vaultPda, type CoinVaultAccount } from "@holdfast/chain";
import type { VaultSnapshotInput } from "@holdfast/db";

export function vaultSnapshotFromAccount(mint: string, v: CoinVaultAccount, slot: number): VaultSnapshotInput {
  return {
    mint,
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
  };
}

/** Reads the CoinVault PDA and decodes it with the Holdfast client (`decodeCoinVault`). */
export function rpcVaultFetcher(
  connection: Connection,
  decode: (data: Buffer) => CoinVaultAccount = decodeCoinVault,
  programId?: PublicKey,
): (mint: string) => Promise<VaultSnapshotInput | null> {
  return async (mint) => {
    const res = await connection.getAccountInfoAndContext(vaultPda(new PublicKey(mint), programId), "confirmed");
    if (!res.value) return null;
    return vaultSnapshotFromAccount(mint, decode(res.value.data), res.context.slot);
  };
}
