import { hashString, seededRandom } from "../hash";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}

function randomBytes(rand: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 256);
  // Keep the leading byte non-zero so addresses have the usual 43–44 chars.
  out[0] = (out[0]! % 255) + 1;
  return out;
}

/** Deterministic, valid-looking base58 public key for a seed string. */
export function mockAddress(seed: string): string {
  return base58Encode(randomBytes(seededRandom(hashString(`addr:${seed}`)), 32));
}

export function mockSignature(seed: string): string {
  return base58Encode(randomBytes(seededRandom(hashString(`sig:${seed}`)), 64));
}

export function randomSignature(): string {
  return base58Encode(randomBytes(Math.random, 64));
}

export function randomAddress(): string {
  return base58Encode(randomBytes(Math.random, 32));
}

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** The wallet the mock wallet adapter connects as; it holds positions in several mock coins. */
export const MOCK_WALLET = mockAddress("holdfast-demo-wallet");
