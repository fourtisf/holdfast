import { describe, expect, it } from "vitest";
import { buildMerkleTree, fromHex, hashLeaf, hashPair, toHex, verifyMerkleProof } from "../src/merkle.js";

const MINT = "So11111111111111111111111111111111111111112";
const WALLETS = [
  "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
];

const leaf = (index: number) =>
  hashLeaf({ mint: MINT, roundId: 7n, index, wallet: WALLETS[index]!, sol: BigInt(1_000 + index), tokens: BigInt(index * 10) });

describe("payout merkle tree", () => {
  it("empty tree has a zero root", () => {
    expect(toHex(buildMerkleTree([]).root)).toBe("0".repeat(64));
  });

  it("single leaf root is the leaf", () => {
    const l = leaf(0);
    expect(buildMerkleTree([l]).root).toEqual(l);
  });

  it("every proof verifies for trees of size 1..9", () => {
    for (let n = 1; n <= WALLETS.length; n++) {
      const leaves = Array.from({ length: n }, (_, i) => leaf(i));
      const tree = buildMerkleTree(leaves);
      leaves.forEach((l, i) => expect(verifyMerkleProof(l, tree.proofs[i]!, tree.root)).toBe(true));
    }
  });

  it("rejects a tampered leaf", () => {
    const leaves = Array.from({ length: 5 }, (_, i) => leaf(i));
    const tree = buildMerkleTree(leaves);
    const forged = hashLeaf({ mint: MINT, roundId: 7n, index: 2, wallet: WALLETS[2]!, sol: 9_999_999n, tokens: 20n });
    expect(verifyMerkleProof(forged, tree.proofs[2]!, tree.root)).toBe(false);
  });

  it("pair hashing is order independent and domain separated from leaves", () => {
    const a = leaf(0);
    const b = leaf(1);
    expect(hashPair(a, b)).toEqual(hashPair(b, a));
    expect(hashPair(a, b)).not.toEqual(a);
  });

  it("leaf encoding is stable (regression vector)", () => {
    // If this changes, previously committed on-chain roots can no longer be verified.
    expect(toHex(leaf(0))).toMatchInlineSnapshot(`"c2d828f2f2ff2bf9bbae500d47ec2a5a351ca9b6f945aa79c75c45284d95b349"`);
  });

  it("hex round trips", () => {
    const bytes = leaf(3);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });
});
