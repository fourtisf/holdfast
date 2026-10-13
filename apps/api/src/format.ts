/** Unit conversions and opaque cursors for API responses (see the conventions in core/api.ts). */

export const lamportsToSol = (lamports: bigint): number => Number(lamports) / 1e9;

export function rawToTokens(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/** Exact decimal string of a lamport amount in SOL (Solana Pay `amount`). */
export function lamportsToSolString(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

export function tokensToRaw(tokens: number, decimals: number): bigint {
  // Avoid float artifacts: go through a fixed decimal string.
  const [whole = "0", frac = ""] = tokens.toFixed(decimals).split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor<T>(cursor: string | null | undefined): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
