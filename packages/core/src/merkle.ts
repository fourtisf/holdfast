import { sha256 } from "@noble/hashes/sha256";
import { base58 } from "@scure/base";

/**
 * Payout snapshot merkle tree. The root is committed on-chain by `open_round` (CoinVault round
 * `snapshot_hash`), so a published snapshot can be checked against the chain, and a later version
 * of the program can verify claims against it.
 *
 * leaf  = sha256(0x00 ‖ "holdfast:payout:v1" ‖ mint[32] ‖ round_id u64le ‖ index u32le ‖ wallet[32] ‖ sol u64le ‖ tokens u64le)
 * node  = sha256(0x01 ‖ min(a, b) ‖ max(a, b))     (sorted pair → proofs need no left/right bits)
 * An odd node at the end of a level is promoted unchanged. The empty tree's root is 32 zero bytes.
 */

const LEAF_DOMAIN = new TextEncoder().encode("holdfast:payout:v1");

export interface PayoutLeaf {
  mint: string;
  roundId: bigint;
  index: number;
  wallet: string;
  sol: bigint;
  tokens: bigint;
}

function u64le(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error(`u64 out of range: ${value}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function u32le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`u32 out of range: ${value}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

export function pubkeyBytes(address: string): Uint8Array {
  const bytes = base58.decode(address);
  if (bytes.length !== 32) throw new Error(`not a 32-byte address: ${address}`);
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function hashLeaf(leaf: PayoutLeaf): Uint8Array {
  return sha256(
    concat([
      Uint8Array.of(0),
      LEAF_DOMAIN,
      pubkeyBytes(leaf.mint),
      u64le(leaf.roundId),
      u32le(leaf.index),
      pubkeyBytes(leaf.wallet),
      u64le(leaf.sol),
      u64le(leaf.tokens),
    ]),
  );
}

export function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(concat([Uint8Array.of(1), lo, hi]));
}

export interface MerkleTree {
  root: Uint8Array;
  /** proofs[i] = sibling hashes from leaf i up to the root. */
  proofs: Uint8Array[][];
}

export function buildMerkleTree(leafHashes: readonly Uint8Array[]): MerkleTree {
  if (leafHashes.length === 0) return { root: new Uint8Array(32), proofs: [] };
  const proofs: Uint8Array[][] = leafHashes.map(() => []);
  // positions[i] = index of leaf i's ancestor in the current level
  let positions = leafHashes.map((_, i) => i);
  let level = [...leafHashes];
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      next.push(right ? hashPair(left, right) : left);
    }
    positions = positions.map((pos, leaf) => {
      const sibling = pos ^ 1;
      if (sibling < level.length) proofs[leaf]!.push(level[sibling]!);
      return pos >> 1;
    });
    level = next;
  }
  return { root: level[0]!, proofs };
}

export function verifyMerkleProof(leafHash: Uint8Array, proof: readonly Uint8Array[], root: Uint8Array): boolean {
  let node = leafHash;
  for (const sibling of proof) node = hashPair(node, sibling);
  return compareBytes(node, root) === 0 && node.length === root.length;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/i.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
