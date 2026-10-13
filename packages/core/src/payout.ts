import { buildMerkleTree, hashLeaf, toHex } from "./merkle.js";
import { weightedAmount } from "./weight.js";
import type { RoundInputsJson, RoundSnapshot } from "./api.js";

/**
 * Payout round computation (spec §5 "Payout round"). Pure and deterministic: the payout worker runs
 * it, publishes inputs + outputs, and anyone can re-run it to check the merkle root on-chain.
 *
 *   distributable = pot − Σ(outstanding carries)            (carries are already inside the pot)
 *   share_i       = floor(distributable × W_i / ΣW),  W_i = Σ lot.amount × weight_ppm(age)
 *   owed_i        = share_i + carry_i
 *   paid now if   owed ≥ minimum, and for SOL: wallet_balance + owed ≥ rent-exempt minimum
 *   otherwise     owed is carried to the next round (dust is never lost)
 *
 * Carries older than `carryExpiryMs` (wallet no longer earning and never reached the minimum) are
 * released back into the distributable pot. Rounding remainders stay in the on-chain bucket.
 */

export interface RoundParams {
  /** Smallest SOL transfer worth a recipient slot. */
  minSolLamports: bigint;
  minTokensRaw: bigint;
  /** A first transfer to an empty wallet must leave it rent-exempt. */
  rentExemptMinLamports: bigint;
  /** 0 = carries never expire. */
  carryExpiryMs: number;
  /** On-chain bitmap capacity per round. Lowest-owed recipients are carried when exceeded. */
  maxRecipients: number;
}

export interface HolderInput {
  wallet: string;
  lots: { amount: bigint; acquiredAt: number }[];
  /** Wallet lamports at snapshot time (rent rule). */
  solBalance: bigint;
  /** Wallet has a token account for the mint (needed to receive token payouts). */
  hasTokenAccount: boolean;
}

export interface CarryInput {
  wallet: string;
  sol: bigint;
  tokens: bigint;
  /** When the oldest part of this carry was first owed (ms). */
  since: number;
}

export interface RoundInputs {
  mint: string;
  roundId: bigint;
  snapshotAt: number;
  /** holder_sol / holder_tokens available on-chain at snapshot time. */
  potSol: bigint;
  potTokens: bigint;
  params: RoundParams;
  holders: HolderInput[];
  carriedIn: CarryInput[];
}

export interface RoundEntry {
  index: number;
  wallet: string;
  weightedAmount: bigint;
  sol: bigint;
  tokens: bigint;
  carriedSol: bigint;
  carriedTokens: bigint;
}

export interface RoundResult {
  totalWeight: bigint;
  distributableSol: bigint;
  distributableTokens: bigint;
  /** Σ entry.sol / Σ entry.tokens — the pot passed to `open_round`. */
  solPot: bigint;
  tokenPot: bigint;
  entries: RoundEntry[];
  carriedOut: CarryInput[];
  /** Expired carries released back to the pot this round. */
  released: CarryInput[];
  merkleRoot: Uint8Array;
}

const byWallet = <T extends { wallet: string }>(a: T, b: T) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0);

export function computeRound(inputs: RoundInputs): RoundResult {
  const { params, snapshotAt } = inputs;
  if (params.maxRecipients <= 0) throw new Error("maxRecipients must be positive");

  const holderWallets = new Set<string>();
  for (const h of inputs.holders) {
    if (holderWallets.has(h.wallet)) throw new Error(`duplicate holder ${h.wallet}`);
    holderWallets.add(h.wallet);
  }

  // 1. Carries: expire stale ones (only for wallets that no longer earn), keep the rest.
  const carries = new Map<string, CarryInput>();
  const released: CarryInput[] = [];
  for (const c of [...inputs.carriedIn].sort(byWallet)) {
    if (carries.has(c.wallet)) throw new Error(`duplicate carry ${c.wallet}`);
    const expired = params.carryExpiryMs > 0 && snapshotAt - c.since >= params.carryExpiryMs && !holderWallets.has(c.wallet);
    if (expired) released.push(c);
    else carries.set(c.wallet, c);
  }
  let carriedSol = 0n;
  let carriedTokens = 0n;
  for (const c of carries.values()) {
    carriedSol += c.sol;
    carriedTokens += c.tokens;
  }
  if (carriedSol > inputs.potSol || carriedTokens > inputs.potTokens) {
    throw new Error("outstanding carries exceed the on-chain pot");
  }
  const distributableSol = inputs.potSol - carriedSol;
  const distributableTokens = inputs.potTokens - carriedTokens;

  // 2. Weights.
  const weights = new Map<string, bigint>();
  let totalWeight = 0n;
  for (const h of inputs.holders) {
    const w = weightedAmount(h.lots, snapshotAt);
    if (w > 0n) {
      weights.set(h.wallet, w);
      totalWeight += w;
    }
  }

  // 3. Owed = share + carry.
  interface Owed {
    wallet: string;
    weight: bigint;
    sol: bigint;
    tokens: bigint;
    carrySol: bigint;
    carryTokens: bigint;
    since: number;
    holder: HolderInput | undefined;
  }
  const holderByWallet = new Map(inputs.holders.map((h) => [h.wallet, h]));
  const owed = new Map<string, Owed>();
  const touch = (wallet: string): Owed => {
    let o = owed.get(wallet);
    if (!o) {
      o = { wallet, weight: 0n, sol: 0n, tokens: 0n, carrySol: 0n, carryTokens: 0n, since: snapshotAt, holder: holderByWallet.get(wallet) };
      owed.set(wallet, o);
    }
    return o;
  };
  if (totalWeight > 0n) {
    for (const [wallet, w] of weights) {
      const o = touch(wallet);
      o.weight = w;
      o.sol += (distributableSol * w) / totalWeight;
      o.tokens += (distributableTokens * w) / totalWeight;
    }
  }
  for (const c of carries.values()) {
    const o = touch(c.wallet);
    o.sol += c.sol;
    o.tokens += c.tokens;
    o.carrySol = c.sol;
    o.carryTokens = c.tokens;
    o.since = c.since;
  }

  // 4. Decide what is payable now.
  interface Candidate extends Owed {
    paySol: bigint;
    payTokens: bigint;
  }
  const candidates: Candidate[] = [];
  const carriedOut: CarryInput[] = [];
  for (const o of [...owed.values()].sort(byWallet)) {
    const solBalance = o.holder?.solBalance ?? 0n;
    const canSol = o.sol >= params.minSolLamports && o.sol > 0n && solBalance + o.sol >= params.rentExemptMinLamports;
    const canTokens = o.tokens >= params.minTokensRaw && o.tokens > 0n && (o.holder?.hasTokenAccount ?? false);
    const c: Candidate = { ...o, paySol: canSol ? o.sol : 0n, payTokens: canTokens ? o.tokens : 0n };
    if (c.paySol > 0n || c.payTokens > 0n) candidates.push(c);
    else if (o.sol > 0n || o.tokens > 0n) carriedOut.push({ wallet: o.wallet, sol: o.sol, tokens: o.tokens, since: o.since });
  }

  // 5. Recipient cap: keep the largest SOL (then token) payouts, carry the rest whole.
  let selected = candidates;
  if (candidates.length > params.maxRecipients) {
    const ranked = [...candidates].sort((a, b) => {
      if (a.paySol !== b.paySol) return a.paySol > b.paySol ? -1 : 1;
      if (a.payTokens !== b.payTokens) return a.payTokens > b.payTokens ? -1 : 1;
      return byWallet(a, b);
    });
    selected = ranked.slice(0, params.maxRecipients).sort(byWallet);
    for (const c of ranked.slice(params.maxRecipients)) {
      carriedOut.push({ wallet: c.wallet, sol: c.sol, tokens: c.tokens, since: c.since });
    }
  }

  const entries: RoundEntry[] = [];
  for (const c of selected) {
    entries.push({
      index: entries.length,
      wallet: c.wallet,
      weightedAmount: c.weight,
      sol: c.paySol,
      tokens: c.payTokens,
      carriedSol: c.paySol > 0n ? c.carrySol : 0n,
      carriedTokens: c.payTokens > 0n ? c.carryTokens : 0n,
    });
    const leftSol = c.sol - c.paySol;
    const leftTokens = c.tokens - c.payTokens;
    if (leftSol > 0n || leftTokens > 0n) carriedOut.push({ wallet: c.wallet, sol: leftSol, tokens: leftTokens, since: c.since });
  }
  carriedOut.sort(byWallet);

  const solPot = entries.reduce((s, e) => s + e.sol, 0n);
  const tokenPot = entries.reduce((s, e) => s + e.tokens, 0n);
  if (solPot > inputs.potSol || tokenPot > inputs.potTokens) throw new Error("payouts exceed pot (bug)");

  const merkleRoot = buildMerkleTree(
    entries.map((e) => hashLeaf({ mint: inputs.mint, roundId: inputs.roundId, index: e.index, wallet: e.wallet, sol: e.sol, tokens: e.tokens })),
  ).root;

  return { totalWeight, distributableSol, distributableTokens, solPot, tokenPot, entries, carriedOut, released, merkleRoot };
}

// ---- JSON (de)serialisation for the public snapshot -------------------------------------------------

export function roundInputsToJson(inputs: RoundInputs): RoundInputsJson {
  return {
    mint: inputs.mint,
    roundId: Number(inputs.roundId),
    snapshotAt: inputs.snapshotAt,
    potSolLamports: inputs.potSol.toString(),
    potTokensRaw: inputs.potTokens.toString(),
    params: {
      minSolLamports: inputs.params.minSolLamports.toString(),
      minTokensRaw: inputs.params.minTokensRaw.toString(),
      rentExemptMinLamports: inputs.params.rentExemptMinLamports.toString(),
      carryExpiryMs: inputs.params.carryExpiryMs,
      maxRecipients: inputs.params.maxRecipients,
    },
    holders: [...inputs.holders].sort(byWallet).map((h) => ({
      wallet: h.wallet,
      lots: h.lots.map((l) => ({ amountRaw: l.amount.toString(), acquiredAt: l.acquiredAt })),
      solBalanceLamports: h.solBalance.toString(),
      hasTokenAccount: h.hasTokenAccount,
    })),
    carriedIn: [...inputs.carriedIn].sort(byWallet).map((c) => ({
      wallet: c.wallet,
      solLamports: c.sol.toString(),
      tokensRaw: c.tokens.toString(),
      since: c.since,
    })),
  };
}

export function roundInputsFromJson(json: RoundInputsJson): RoundInputs {
  return {
    mint: json.mint,
    roundId: BigInt(json.roundId),
    snapshotAt: json.snapshotAt,
    potSol: BigInt(json.potSolLamports),
    potTokens: BigInt(json.potTokensRaw),
    params: {
      minSolLamports: BigInt(json.params.minSolLamports),
      minTokensRaw: BigInt(json.params.minTokensRaw),
      rentExemptMinLamports: BigInt(json.params.rentExemptMinLamports),
      carryExpiryMs: json.params.carryExpiryMs,
      maxRecipients: json.params.maxRecipients,
    },
    holders: json.holders.map((h) => ({
      wallet: h.wallet,
      lots: h.lots.map((l) => ({ amount: BigInt(l.amountRaw), acquiredAt: l.acquiredAt })),
      solBalance: BigInt(h.solBalanceLamports),
      hasTokenAccount: h.hasTokenAccount,
    })),
    carriedIn: json.carriedIn.map((c) => ({ wallet: c.wallet, sol: BigInt(c.solLamports), tokens: BigInt(c.tokensRaw), since: c.since })),
  };
}

/** `decimals` converts the token pot to whole tokens for the summary fields (API convention). */
export function buildRoundSnapshot(inputs: RoundInputs, result: RoundResult, ts: number, decimals = 6): RoundSnapshot {
  return {
    version: 1,
    mint: inputs.mint,
    roundId: Number(inputs.roundId),
    ts,
    snapshotAt: inputs.snapshotAt,
    solPot: Number(result.solPot) / 1e9,
    tokenPot: Number(result.tokenPot) / 10 ** decimals,
    recipients: result.entries.length,
    snapshotHash: toHex(result.merkleRoot),
    status: "computed",
    inputs: roundInputsToJson(inputs),
    totalWeight: result.totalWeight.toString(),
    entries: result.entries.map((e) => ({
      index: e.index,
      wallet: e.wallet,
      weightedAmount: e.weightedAmount.toString(),
      solLamports: e.sol.toString(),
      tokensRaw: e.tokens.toString(),
      carriedSolLamports: e.carriedSol.toString(),
      carriedTokensRaw: e.carriedTokens.toString(),
      sig: null,
    })),
    carriedOut: result.carriedOut.map((c) => ({ wallet: c.wallet, solLamports: c.sol.toString(), tokensRaw: c.tokens.toString(), since: c.since })),
  };
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
}

/** Recompute a published snapshot from its inputs and compare every output (spec §5.5). */
export function verifyRoundSnapshot(snapshot: RoundSnapshot, onChainRootHex?: string): VerifyResult {
  const problems: string[] = [];
  const inputs = roundInputsFromJson(snapshot.inputs);
  if (inputs.mint !== snapshot.mint) problems.push("inputs.mint mismatch");
  if (Number(inputs.roundId) !== snapshot.roundId) problems.push("inputs.roundId mismatch");
  let result: RoundResult;
  try {
    result = computeRound(inputs);
  } catch (err) {
    return { ok: false, problems: [...problems, `recompute failed: ${(err as Error).message}`] };
  }
  const root = toHex(result.merkleRoot);
  if (root !== snapshot.snapshotHash) problems.push(`merkle root ${root} ≠ published ${snapshot.snapshotHash}`);
  if (onChainRootHex !== undefined && root !== onChainRootHex.toLowerCase()) problems.push(`merkle root ${root} ≠ on-chain ${onChainRootHex}`);
  if (result.totalWeight.toString() !== snapshot.totalWeight) problems.push("totalWeight mismatch");
  if (result.entries.length !== snapshot.entries.length) problems.push("entry count mismatch");
  result.entries.forEach((e, i) => {
    const p = snapshot.entries[i];
    if (!p || p.wallet !== e.wallet || p.solLamports !== e.sol.toString() || p.tokensRaw !== e.tokens.toString() || p.index !== e.index) {
      problems.push(`entry ${i} mismatch`);
    }
  });
  const carried = JSON.stringify(result.carriedOut.map((c) => [c.wallet, c.sol.toString(), c.tokens.toString()]));
  const published = JSON.stringify(snapshot.carriedOut.map((c) => [c.wallet, c.solLamports, c.tokensRaw]));
  if (carried !== published) problems.push("carriedOut mismatch");
  return { ok: problems.length === 0, problems };
}
