/**
 * The launcher's address lookup table for atomic launches. It holds every account an atomic launch
 * uses that is the same for all launches (programs, pump.fun globals and fee accounts, the Holdfast
 * config, ...), so the single transaction fits the 1232-byte packet limit. The set is derived by
 * building the launch instructions for two unrelated launches and keeping the keys they share, so it
 * follows pump.fun SDK changes automatically (`launcher alt sync` extends the table).
 */
import { Keypair, PublicKey } from "@solana/web3.js";

import { pump, type Global } from "./pump.js";
import { atomicLaunchInstructions } from "./tx.js";
import { DEFAULT_PRIORITY, pumpCreatorFor } from "@holdfast/chain";

async function sampleKeys(global: Global, launcher: PublicKey, buybackFeeRecipient: PublicKey): Promise<{ all: Set<string>; signers: Set<string> }> {
  const mint = Keypair.generate().publicKey;
  const deposit = Keypair.generate().publicKey;
  const sender = Keypair.generate().publicKey;
  const common = { deposit, launcher, mint, name: "sample", symbol: "SMPL", uri: "https://ipfs.io/ipfs/sample", triggerBps: 2500, creator: sender, reimburseLamports: 1n, priority: DEFAULT_PRIORITY };
  const withDevBuy = await atomicLaunchInstructions({
    ...common,
    devBuy: { tokens: 1_000n, maxSolCost: 1_000n, bondingCurve: { ...pump.newBondingCurve(global), creator: pumpCreatorFor(mint) }, buybackFeeRecipient },
    leftover: null,
  });
  const withoutDevBuy = await atomicLaunchInstructions({ ...common, devBuy: null, leftover: { to: sender, lamports: 1n } });
  const ixs = [...withDevBuy, ...withoutDevBuy];
  const all = new Set<string>();
  const signers = new Set<string>([deposit.toBase58(), mint.toBase58(), launcher.toBase58()]);
  for (const ix of ixs) {
    all.add(ix.programId.toBase58());
    for (const k of ix.keys) all.add(k.pubkey.toBase58());
  }
  return { all, signers };
}

/** Addresses the lookup table must contain (sorted, deduplicated). */
export async function launchLookupAddresses(global: Global, launcher: PublicKey): Promise<PublicKey[]> {
  const recipients = global.buybackFeeRecipients.filter((k) => !k.equals(PublicKey.default));
  const pick = recipients[0] ?? PublicKey.default;
  const [a, b] = await Promise.all([sampleKeys(global, launcher, pick), sampleKeys(global, launcher, pick)]);
  const shared = [...a.all].filter((k) => b.all.has(k) && !a.signers.has(k));
  // The dev buy picks one of these at random: all of them belong in the table.
  for (const r of recipients) shared.push(r.toBase58());
  return [...new Set(shared)].sort().map((k) => new PublicKey(k));
}

/** Addresses still missing from a table (what `extend` must add). */
export function missingAddresses(wanted: readonly PublicKey[], present: readonly PublicKey[]): PublicKey[] {
  const have = new Set(present.map((k) => k.toBase58()));
  return wanted.filter((k) => !have.has(k.toBase58()));
}

