/**
 * Browser-side round verification helpers: find the root a round committed on-chain from the
 * `open_round` transaction's logs, without Anchor. Only "Program data:" lines emitted while the
 * Holdfast program itself is executing count, so another program in the same transaction cannot
 * forge the event.
 */
import { base58, base64 } from "@scure/base";
import { toHex } from "./merkle.js";

export const HOLDFAST_PROGRAM_ADDRESS = "8pVgMgwxbhPuKLwsP7z9sa6ADs7L3KWYAbhBGnrtgSmN";

/** Anchor event discriminator of `RoundOpened` (sha256("event:RoundOpened")[..8]). */
const ROUND_OPENED_DISCRIMINATOR = [99, 173, 228, 72, 142, 57, 109, 178];

export interface RoundOpenedLog {
  mint: string;
  roundId: number;
  solPotLamports: bigint;
  tokenPotRaw: bigint;
  /** Committed merkle root, hex. */
  snapshotHash: string;
  recipientCount: number;
  ts: number;
}

function u64(b: Uint8Array, at: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[at + i]!);
  return v;
}

/** Layout: disc(8) mint(32) round_id u64, sol_pot u64, token_pot u64, snapshot_hash [u8;32], recipient_count u32, ts i64. */
export function decodeRoundOpened(data: Uint8Array): RoundOpenedLog | null {
  if (data.length < 8 + 32 + 24 + 32 + 4 + 8) return null;
  for (let i = 0; i < 8; i++) if (data[i] !== ROUND_OPENED_DISCRIMINATOR[i]) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mint: base58.encode(data.subarray(8, 40)),
    roundId: Number(u64(data, 40)),
    solPotLamports: u64(data, 48),
    tokenPotRaw: u64(data, 56),
    snapshotHash: toHex(data.subarray(64, 96)),
    recipientCount: view.getUint32(96, true),
    ts: Number(view.getBigInt64(100, true)),
  };
}

/** RoundOpened events emitted by `programId` in a transaction's log messages. */
export function roundOpenedFromLogs(logs: readonly string[], programId = HOLDFAST_PROGRAM_ADDRESS): RoundOpenedLog[] {
  const stack: string[] = [];
  const out: RoundOpenedLog[] = [];
  for (const line of logs) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (/^Program \w+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith("Program data: ") && stack[stack.length - 1] === programId) {
      try {
        const ev = decodeRoundOpened(base64.decode(line.slice("Program data: ".length).trim()));
        if (ev) out.push(ev);
      } catch {
        // not base64: ignore
      }
    }
  }
  return out;
}
