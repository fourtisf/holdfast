import { AddressLookupTableAccount, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { bondingCurvePda, configPda, DEFAULT_PRIORITY, HOLDFAST_PROGRAM_ID, pumpCreatorFor, treasuryPda, vaultPda } from "@holdfast/chain";

import { launchLookupAddresses, missingAddresses } from "../src/lookup.js";
import { pump } from "../src/pump.js";
import { buildAtomicLaunchTx, PACKET_DATA_SIZE } from "../src/tx.js";
import { fakeGlobal } from "./fakeChain.js";

const global = fakeGlobal();
const launcher = Keypair.generate().publicKey;

async function table(): Promise<AddressLookupTableAccount> {
  const addresses = await launchLookupAddresses(global, launcher);
  return new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses } });
}

async function size(uriBytes: number, withDevBuy: boolean): Promise<number> {
  const mint = Keypair.generate().publicKey;
  const tx = await buildAtomicLaunchTx(
    {
      deposit: Keypair.generate().publicKey,
      launcher,
      mint,
      name: "n".repeat(32),
      symbol: "s".repeat(13),
      uri: "u".repeat(uriBytes),
      triggerBps: 2500,
      creator: Keypair.generate().publicKey,
      reimburseLamports: 6_000_000n,
      devBuy: withDevBuy ? { tokens: 10n ** 12n, maxSolCost: 10n ** 9n, bondingCurve: { ...pump.newBondingCurve(global), creator: pumpCreatorFor(mint) }, buybackFeeRecipient: global.buybackFeeRecipients[3]! } : null,
      leftover: withDevBuy ? null : { to: Keypair.generate().publicKey, lamports: 123n },
      recent: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 },
      priority: DEFAULT_PRIORITY,
    },
    await table(),
  );
  return tx.serialize().length;
}

describe("atomic launch transaction", () => {
  it("fits one packet with the longest name and ticker: any URI without a dev buy, an IPFS URI with one", async () => {
    expect(await size(200, false)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    expect(await size(80, true)).toBeLessThanOrEqual(PACKET_DATA_SIZE); // https://ipfs.io/ipfs/<CIDv1>
    expect(await size(102, true)).toBeLessThanOrEqual(PACKET_DATA_SIZE); // https://moatpad.fun/api/metadata/<sha256>.json
    // a 200-byte URI plus a dev buy does not: the worker launches those with the split flow
    expect(await size(200, true)).toBeGreaterThan(PACKET_DATA_SIZE);
  });

  it("the lookup table holds the shared accounts, never per-launch ones or signers", async () => {
    const addresses = (await launchLookupAddresses(global, launcher)).map((k) => k.toBase58());
    expect(new Set(addresses).size).toBe(addresses.length);
    for (const k of [pump.GLOBAL_PDA, configPda(), HOLDFAST_PROGRAM_ID, ...global.buybackFeeRecipients]) expect(addresses).toContain(k.toBase58());
    const mint = Keypair.generate().publicKey;
    for (const k of [launcher, mint, vaultPda(mint), treasuryPda(mint), bondingCurvePda(mint)]) expect(addresses).not.toContain(k.toBase58());
    expect(missingAddresses([pump.GLOBAL_PDA, launcher], [pump.GLOBAL_PDA]).map((k: PublicKey) => k.toBase58())).toEqual([launcher.toBase58()]);
  });
});
