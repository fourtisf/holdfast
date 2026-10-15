// Explains a failed `solana program deploy`: the CLI only says "Account allocation failed: Transaction simulation
// failed". This checks the RPC, the deployer and the program address, then simulates the first transaction of a
// deploy (create the buffer account + InitializeBuffer) and prints the error and the program logs. It sends
// nothing. deploy/program.sh runs it inside the services image, where @solana/web3.js is installed:
//   node diagnose-deploy.mjs <rpc> <deployer.json> <program.so> <program id>
import { readFileSync, statSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

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
const { blockhash } = await conn.getLatestBlockhash();
const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions }).compileToLegacyMessage();
const sim = await conn.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: true });
if (!sim.value.err) {
  line("buffer creation", "simulates fine");
  console.log("\nThe deploy's first transaction is valid, so the failure came from the RPC (rate limit, or a blockhash one node");
  console.log("had not seen yet). Run the deploy again; with a dedicated RPC (Helius, set in .env) it is reliable.");
} else {
  line("buffer creation", `FAILS: ${JSON.stringify(sim.value.err)}`);
  for (const log of sim.value.logs ?? []) console.log(`  ${log}`);
}
