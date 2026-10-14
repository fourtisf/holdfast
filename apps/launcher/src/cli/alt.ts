/**
 * Address lookup table for atomic launches.
 *
 *   pnpm --filter @holdfast/launcher alt create   # new table (authority + payer: LAUNCHER_KEYPAIR), filled
 *   pnpm --filter @holdfast/launcher alt sync     # add what LAUNCHER_LOOKUP_TABLE is missing
 *   pnpm --filter @holdfast/launcher alt show     # contents and missing addresses
 *
 * Needs SOLANA_RPC_URL and LAUNCHER_KEYPAIR. Put the created address in LAUNCHER_LOOKUP_TABLE (for the
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
const connection = new Connection(rpc, "confirmed");
const chain = new Web3LaunchChain(connection);

const { global } = await readPumpGlobals(chain);
const wanted = await launchLookupAddresses(global, authority.publicKey);

async function extend(table: PublicKey, addresses: PublicKey[]): Promise<void> {
  for (let i = 0; i < addresses.length; i += 20) {
    const chunk = addresses.slice(i, i + 20);
    const ix = AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: authority.publicKey, payer: authority.publicKey, addresses: chunk });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [authority]);
    console.log(`extended with ${chunk.length} addresses: ${sig}`);
  }
}

if (command === "create") {
  const slot = await connection.getSlot("finalized");
  const [ix, table] = AddressLookupTableProgram.createLookupTable({ authority: authority.publicKey, payer: authority.publicKey, recentSlot: slot });
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [authority]);
  console.log(`created lookup table ${table.toBase58()}: ${sig}`);
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
