import { PublicKey } from "@solana/web3.js";
import type { HolderInput, RoundInputs } from "@holdfast/core";
import { associatedTokenAddress, decodeTokenAccount, type CoinKeys, type CoinVaultAccount } from "@holdfast/chain";
import { loadCarries, loadEligibleHolders, type Queryable } from "@holdfast/db";

import type { KeeperChain } from "../chain.js";
import type { PayoutConfig } from "../config.js";

export interface GatheredInputs {
  inputs: RoundInputs;
  /** Wallet → its token account for the mint (ATA), when it exists. */
  tokenAccounts: Map<string, PublicKey>;
}

/**
 * Everything `computeRound` needs: lots from the indexer, carries, and per-wallet chain facts
 * (SOL balance for the rent rule, token account existence for token payouts).
 */
export async function gatherRoundInputs(
  db: Queryable,
  chain: KeeperChain,
  coin: CoinKeys,
  vault: CoinVaultAccount,
  cfg: PayoutConfig,
  nowMs: number,
): Promise<GatheredInputs> {
  const mint = coin.mint.toBase58();
  const [holders, carriedIn] = await Promise.all([loadEligibleHolders(db, mint), loadCarries(db, mint)]);

  // Carry-only wallets (stopped holding) still need balance facts to be paid what they are owed.
  const lotsByWallet = new Map(holders.map((h) => [h.wallet, h.lots]));
  for (const c of carriedIn) if (!lotsByWallet.has(c.wallet)) lotsByWallet.set(c.wallet, []);
  const wallets = [...lotsByWallet.keys()].sort();

  const walletKeys = wallets.map((w) => new PublicKey(w));
  const ataKeys = walletKeys.map((w) => associatedTokenAddress(w, coin.mint, coin.tokenProgram));
  const infos = await chain.getAccounts([...walletKeys, ...ataKeys]);

  const tokenAccounts = new Map<string, PublicKey>();
  const holderInputs: HolderInput[] = wallets.map((wallet, i) => {
    const walletInfo = infos[i];
    const ataInfo = infos[wallets.length + i];
    let hasTokenAccount = false;
    if (ataInfo && ataInfo.owner.equals(coin.tokenProgram)) {
      const ta = decodeTokenAccount(ataInfo.data);
      hasTokenAccount = ta.initialized && ta.owner.toBase58() === wallet && ta.mint.equals(coin.mint);
    }
    if (hasTokenAccount) tokenAccounts.set(wallet, ataKeys[i]!);
    return {
      wallet,
      lots: (lotsByWallet.get(wallet) ?? []).map((l) => ({ amount: l.amount, acquiredAt: l.acquiredAt })),
      solBalance: BigInt(walletInfo?.lamports ?? 0),
      hasTokenAccount,
    };
  });

  return {
    inputs: {
      mint,
      roundId: vault.roundId + 1n,
      snapshotAt: nowMs,
      potSol: vault.holderSol,
      potTokens: vault.holderTokens,
      params: {
        minSolLamports: cfg.minSolLamports,
        minTokensRaw: cfg.minTokensRaw,
        rentExemptMinLamports: cfg.rentExemptMinLamports,
        carryExpiryMs: cfg.carryExpiryMs,
        maxRecipients: cfg.maxRecipients,
      },
      holders: holderInputs,
      carriedIn,
    },
    tokenAccounts,
  };
}
