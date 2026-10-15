// Prints a Solana CLI keypair file, read from stdin, as the base58 private key wallets import (Phantom: Add
// account > Import Private Key). deploy/program.sh runs it in the same bare Node image as import-key.mjs:
//   docker run --rm -i -v "$PWD/deploy:/d:ro" node:22-bookworm-slim node /d/export-key.mjs < keys/keeper.json
import { base58Encode } from "./import-key.mjs";

const bytes = JSON.parse(await new Response(process.stdin).text());
if (!Array.isArray(bytes) || bytes.length !== 64) {
  process.stderr.write("not a Solana keypair file\n");
  process.exit(1);
}
process.stdout.write(`${base58Encode(Buffer.from(bytes))}\n`);
