/**
 * Address lookup table for atomic launches.
 *
 *   pnpm --filter @holdfast/launcher alt create   # new table (authority + payer: LAUNCHER_KEYPAIR), filled
 *   pnpm --filter @holdfast/launcher alt sync     # add what LAUNCHER_LOOKUP_TABLE is missing
 *   pnpm --filter @holdfast/launcher alt show     # contents and missing addresses
 *
 * Needs SOLANA_RPC_URL and LAUNCHER_KEYPAIR (the table's authority). ALT_PAYER_KEYPAIR, when set, pays the table's
 * rent and fees instead, so the launcher can run with no SOL of its own (launches reimburse it in the same
 * transaction). Put the created address in LAUNCHER_LOOKUP_TABLE (for the
 * launcher and the API, so quotes use the atomic cost). A new table is usable one slot after its last
 * extension.
 */
import { AddressLookupTableProgram, Connection, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

import { loadKeypair } from "../config.js";
import { launchLookupAddresses, missingAddresses } from "../lookup.js";
import { readPumpGlobals } from "../pump.js";
import { Web3LaunchChain } from "../web3Chain.js";

const command = process.argv[2] ?? "show";
const rpc = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
if (!process.env.LAUNCHER_KEYPAIR) throw new Error("LAUNCHER_KEYPAIR is required");
const authority = loadKeypair(process.env.LAUNCHER_KEYPAIR);
const payer = process.env.ALT_PAYER_KEYPAIR ? loadKeypair(process.env.ALT_PAYER_KEYPAIR) : authority;
// The payer goes first: it is the fee payer. A signer listed twice is fine.
const signers = payer === authority ? [authority] : [payer, authority];
const connection = new Connection(rpc, "confirmed");
const chain = new Web3LaunchChain(connection);

const { global } = await readPumpGlobals(chain);
const wanted = await launchLookupAddresses(global, authority.publicKey);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** RPC providers balance requests over nodes, and a node a slot behind does not see a table created a moment ago. */
async function waitForTable(table: PublicKey): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const info = await connection.getAccountInfo(table, "confirmed");
    if (info?.owner.equals(AddressLookupTableProgram.programId)) return;
    await sleep(1_000);
  }
  throw new Error(`lookup table ${table.toBase58()} did not show up on the RPC within 60 s; run alt sync to finish it`);
}

async function extend(table: PublicKey, addresses: PublicKey[]): Promise<void> {
  await waitForTable(table);
  for (let i = 0; i < addresses.length; i += 20) {
    const chunk = addresses.slice(i, i + 20);
    const ix = AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: authority.publicKey, payer: payer.publicKey, addresses: chunk });
    for (let attempt = 1; ; attempt++) {
      try {
        const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), signers);
        console.log(`extended with ${chunk.length} addresses: ${sig}`);
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        console.log(`extend attempt ${attempt} failed (${(err as Error).message.split("\n")[0]}), retrying`);
        await sleep(2_000 * attempt);
      }
    }
  }
}

if (command === "create") {
  const slot = await connection.getSlot("finalized");
  const [ix, table] = AddressLookupTableProgram.createLookupTable({ authority: authority.publicKey, payer: payer.publicKey, recentSlot: slot });
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), signers);
  console.log(`created lookup table ${table.toBase58()}: ${sig}`);
  // Printed before filling it, so an interrupted run can be finished with `alt sync`.
  console.log(`LAUNCHER_LOOKUP_TABLE=${table.toBase58()}`);
  await extend(table, wanted);
  console.log(`\nLAUNCHER_LOOKUP_TABLE=${table.toBase58()}`);
} else {
  const address = process.env.LAUNCHER_LOOKUP_TABLE;
  if (!address) throw new Error("LAUNCHER_LOOKUP_TABLE is required");
  const table = new PublicKey(address);
  const account = await chain.getLookupTable(table);
  if (!account) throw new Error(`lookup table ${address} not found`);
  const missing = missingAddresses(wanted, account.state.addresses);
  if (command === "sync") {
    if (missing.length === 0) console.log("lookup table is complete");
    else await extend(table, missing);
  } else {
    console.log(`lookup table ${address}: ${account.state.addresses.length} addresses, authority ${account.state.authority?.toBase58() ?? "frozen"}`);
    for (const a of account.state.addresses) console.log(`  ${a.toBase58()}`);
    console.log(missing.length === 0 ? "nothing missing" : `missing (run alt sync):\n${missing.map((m) => `  ${m.toBase58()}`).join("\n")}`);
  }
}
