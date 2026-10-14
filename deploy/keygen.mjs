// Prints a new Solana keypair to stdout in the Solana CLI's format (a JSON array of the 32-byte seed
// followed by the 32-byte public key) and its base58 address to stderr. No dependencies, so it runs
// in a bare Node image:
//   docker run --rm -v "$PWD/deploy:/d:ro" node:22-bookworm-slim node /d/keygen.mjs > keys/keeper.json
import { generateKeyPairSync } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
process.stdout.write(`${JSON.stringify([...seed, ...pub])}\n`);
process.stderr.write(`${base58(pub)}\n`);
