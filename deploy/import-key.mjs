// Turns a wallet's exported private key, read from stdin, into a Solana CLI keypair file on stdout (a JSON
// array of the 32-byte seed followed by the 32-byte public key) and prints its base58 address to stderr.
// Accepts Phantom/Solflare's base58 export (64 bytes) or a JSON byte array. No dependencies, so it runs in a
// bare Node image; deploy/program.sh feeds it from a hidden prompt:
//   printf '%s' "$key" | docker run --rm -i -v "$PWD/deploy:/d:ro" node:22-bookworm-slim node /d/import-key.mjs
import { createPrivateKey, createPublicKey } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// PKCS#8 wrapper of a raw Ed25519 seed (RFC 8410).
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function base58Encode(bytes) {
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

function base58Decode(text) {
  let n = 0n;
  for (const c of text) {
    const digit = ALPHABET.indexOf(c);
    if (digit < 0) throw new Error("the key has a character that is not base58");
    n = n * 58n + BigInt(digit);
  }
  const hex = n === 0n ? "" : n.toString(16);
  const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
  let zeros = 0;
  while (text[zeros] === "1") zeros++;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const input = (await new Response(process.stdin).text()).trim();
if (!input) fail("no key given");

let bytes;
try {
  bytes = input.startsWith("[") ? Buffer.from(JSON.parse(input)) : base58Decode(input);
} catch (err) {
  fail(`not a private key: ${err.message}`);
}
if (bytes.length !== 64 && bytes.length !== 32) fail(`a private key is 64 bytes, this one is ${bytes.length}`);

const seed = bytes.subarray(0, 32);
const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
const pub = Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
if (bytes.length === 64 && !pub.equals(bytes.subarray(32))) fail("the key's two halves do not match: copy the whole private key again");

process.stdout.write(`${JSON.stringify([...seed, ...pub])}\n`);
process.stderr.write(`${base58Encode(pub)}\n`);
