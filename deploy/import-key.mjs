// Turns a wallet's exported private key, read from stdin, into a Solana CLI keypair file on stdout (a JSON
// array of the 32-byte seed followed by the 32-byte public key) and prints its base58 address to stderr.
// Accepts Phantom/Solflare's base58 export (64 bytes) or a JSON byte array, and cleans up what pasting adds
// (terminal paste markers, quotes, line breaks, spaces). With the wallet's address as the first argument it
// refuses a key that belongs to another wallet. No dependencies, so it runs in a bare Node image;
// deploy/program.sh feeds it from a hidden prompt:
//   printf '%s' "$key" | docker run --rm -i -v "$PWD/deploy:/d:ro" node:22-bookworm-slim node /d/import-key.mjs <address>
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
  for (const c of text) n = n * 58n + BigInt(ALPHABET.indexOf(c));
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

/** What a terminal paste can wrap around the key: bracketed-paste markers, other escapes, control characters, quotes. */
export function cleanPaste(raw) {
  return raw
    .replace(/\x1b\[20[01]~/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

/** Returns the 32- or 64-byte key, or throws with what the pasted text looks like instead. */
export function parseKey(raw) {
  const text = cleanPaste(raw);
  if (!text) throw new Error("no key was pasted");
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(text)) {
    throw new Error("this is an Ethereum/EVM private key. In Phantom, choose Solana when you show the private key");
  }
  const words = text.split(/\s+/);
  if (words.length >= 12 && words.every((w) => /^[a-z]+$/.test(w))) {
    throw new Error(
      "this is a recovery phrase (12 or 24 words), not a private key. Never put it on a server: in Phantom use\n" +
        "Settings > Manage Accounts > your account > Show Private Key > Solana instead",
    );
  }
  if (text.startsWith("[")) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr) || !arr.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) throw new Error("the byte array is not a private key");
    return Buffer.from(arr);
  }
  const compact = text.replace(/\s+/g, "");
  const bad = [...compact].filter((c) => !ALPHABET.includes(c));
  if (bad.length > 0) {
    const kinds = [...new Set(bad.map((c) => (/[0OIl]/.test(c) ? "0, O, I or l" : "symbols or punctuation")))].join(" and ");
    throw new Error(`this is not a Solana private key: it contains ${kinds}, which a Solana key never has. Copy it again with Phantom's copy button`);
  }
  return base58Decode(compact);
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const expected = (process.argv[2] ?? "").trim();
  let bytes;
  try {
    bytes = parseKey(await new Response(process.stdin).text());
  } catch (err) {
    fail(err.message);
  }
  if (bytes.length !== 64 && bytes.length !== 32) fail(`a Solana private key is 64 bytes, this one is ${bytes.length}: copy the whole key with Phantom's copy button`);

  const seed = bytes.subarray(0, 32);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
  if (bytes.length === 64 && !pub.equals(bytes.subarray(32))) fail("the key's two halves do not match: copy the whole key again with Phantom's copy button");
  const address = base58Encode(pub);
  if (expected && address !== expected) fail(`this private key belongs to ${address}, not to ${expected}: pick that account in Phantom, or check the address`);

  process.stdout.write(`${JSON.stringify([...seed, ...pub])}\n`);
  process.stderr.write(`${address}\n`);
}
