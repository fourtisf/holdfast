// Explains a failed `solana program deploy`: the CLI only says "Account allocation failed: Transaction simulation
// failed". This checks the RPC, the deployer and the program address, then simulates the first transaction of a
// deploy (create the buffer account + InitializeBuffer) three ways: plain, signed like a real send (preflight), and
// the way `--with-compute-unit-price` builds it (compute-unit limit set to exactly what a simulation consumed). It
// prints each error with the program logs, and sends nothing. deploy/program.sh runs it inside the services image,
// where @solana/web3.js is installed:
//   node diagnose-deploy.mjs <rpc> <deployer.json> <program.so> <program id>
import { readFileSync, statSync } from "node:fs";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

const LOADER_V3 = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const BUFFER_METADATA = 37;

const [rpc, deployerPath, soPath, programId] = process.argv.slice(2);
const conn = new Connection(rpc, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(deployerPath, "utf8"))));
const program = new PublicKey(programId);
const len = statSync(soPath).size;
const sol = (l) => `${(l / 1e9).toFixed(4)} SOL`;
const line = (k, v) => console.log(`${k.padEnd(18)} ${v}`);

line("rpc", rpc.replace(/(api-key=)[^&]+/, "$1…"));
try {
  const version = await conn.getVersion();
  line("cluster version", version["solana-core"]);
} catch (err) {
  line("cluster version", `unreachable: ${err.message}`);
  process.exit(1);
}
const balance = await conn.getBalance(payer.publicKey);
line("deployer", `${payer.publicKey.toBase58()}  ${sol(balance)}`);

const programAccount = await conn.getAccountInfo(program);
if (!programAccount) line("program address", `${programId}  free (good)`);
else line("program address", `${programId}  ALREADY EXISTS: ${sol(programAccount.lamports)}, owner ${programAccount.owner.toBase58()}, executable ${programAccount.executable}`);

const space = BUFFER_METADATA + len;
const lamports = await conn.getMinimumBalanceForRentExemption(space);
line("buffer", `${space} bytes, rent ${sol(lamports)}`);
if (balance < lamports + 10_000_000) line("PROBLEM", `the deployer needs at least ${sol(lamports + 10_000_000)} for the buffer`);

const buffer = Keypair.generate();
const instructions = [
  SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: buffer.publicKey, lamports, space, programId: LOADER_V3 }),
  // InitializeBuffer (instruction 0): [buffer (writable), authority]
  new TransactionInstruction({
    programId: LOADER_V3,
    keys: [
      { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0, 0, 0, 0]),
  }),
];
const MAX_UNITS = 1_400_000;
const priced = (limit) => [...instructions, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: limit })];
const build = (ixs, blockhash) => new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToLegacyMessage());
function report(name, sim) {
  if (!sim.value.err) return line(name, `ok (${sim.value.unitsConsumed ?? "?"} compute units)`), true;
  line(name, `FAILS: ${JSON.stringify(sim.value.err)}`);
  for (const log of sim.value.logs ?? []) console.log(`  ${log}`);
  return false;
}

// 1. Plain: is the transaction itself valid?
const plain = report("plain", await conn.simulateTransaction(build(instructions, PublicKey.default.toBase58()), { sigVerify: false, replaceRecentBlockhash: true }));
// 2. Signed with a fresh blockhash, as sendTransaction's preflight checks it.
const fresh = (await conn.getLatestBlockhash("confirmed")).blockhash;
const signed = build(instructions, fresh);
signed.sign([payer, buffer]);
const preflight = report("signed (preflight)", await conn.simulateTransaction(signed, { sigVerify: true, replaceRecentBlockhash: false, commitment: "confirmed" }));
// 3. As `--with-compute-unit-price` builds it: simulate at the max limit, then set the limit to exactly what it used.
const probe = await conn.simulateTransaction(build(priced(MAX_UNITS), PublicKey.default.toBase58()), { sigVerify: false, replaceRecentBlockhash: true });
let priority = report("priced, max limit", probe);
if (priority) {
  const exact = build(priced(probe.value.unitsConsumed), fresh);
  exact.sign([payer, buffer]);
  priority = report("priced, exact limit", await conn.simulateTransaction(exact, { sigVerify: true, replaceRecentBlockhash: false, commitment: "confirmed" }));
}

console.log();
if (!plain) console.log("The deploy transaction itself is rejected: see the error and logs above.");
else if (!preflight) console.log("Valid, but rejected when signed with a fresh blockhash: the RPC is the problem. Use a dedicated RPC (Helius) in .env.");
else if (!priority) console.log("Only the priority-fee form fails (its exact compute-unit limit is too tight on this cluster): deploy with PRIORITY=0.");
else console.log("Every form is valid, so the failure came from the RPC (rate limit, or a node behind). Run the deploy again; a dedicated RPC (Helius) is reliable.");
