/**
 * Payout economics: a payout round costs the keeper transaction fees (open, one per batch of
 * recipients, close). The spec pays every 2 minutes, but a round whose fees would eat a noticeable
 * part of what it pays is not worth sending: its pot simply stays in the on-chain holder bucket and
 * grows until the next round. Likewise a recipient is only paid once its owed amount is large enough
 * that its share of a batch fee is small; smaller amounts are carried (never lost).
 *
 * All amounts are lamports. `maxFeeBps` is the most a round may spend on fees, relative to the value
 * it pays out (default 2%).
 */

export interface PayoutCostModel {
  /** Lamports per signature (5000 on mainnet). */
  signatureLamports: bigint;
  /** Compute-unit price of payout transactions (micro-lamports per CU). */
  priorityMicroLamports: bigint;
  openUnits: number;
  closeUnits: number;
  /** Compute units of a payout batch: base + perRecipient × recipients. */
  batchBaseUnits: number;
  batchUnitsPerRecipient: number;
  /** Recipients per payout transaction (packet-size bound). */
  batchSize: number;
  maxFeeBps: number;
}

export const DEFAULT_PAYOUT_COST_MODEL: PayoutCostModel = {
  signatureLamports: 5_000n,
  priorityMicroLamports: 1_000n,
  openUnits: 100_000,
  closeUnits: 60_000,
  batchBaseUnits: 60_000,
  batchUnitsPerRecipient: 40_000,
  batchSize: 10,
  maxFeeBps: 200,
};

function txFee(m: PayoutCostModel, units: number): bigint {
  return m.signatureLamports + (m.priorityMicroLamports * BigInt(units) + 999_999n) / 1_000_000n;
}

/** Fee of a payout transaction carrying `recipients` entries. */
export function batchFee(m: PayoutCostModel, recipients: number): bigint {
  return txFee(m, m.batchBaseUnits + m.batchUnitsPerRecipient * recipients);
}

/** Estimated fees of a whole round paying `recipients` wallets. */
export function roundFee(m: PayoutCostModel, recipients: number): bigint {
  if (recipients <= 0) return 0n;
  const full = Math.floor(recipients / m.batchSize);
  const rest = recipients % m.batchSize;
  return txFee(m, m.openUnits) + txFee(m, m.closeUnits) + BigInt(full) * batchFee(m, m.batchSize) + (rest > 0 ? batchFee(m, rest) : 0n);
}

/** One recipient's share of a full batch's fee. */
export function feePerRecipient(m: PayoutCostModel): bigint {
  return (batchFee(m, m.batchSize) + BigInt(m.batchSize) - 1n) / BigInt(m.batchSize);
}

/** Smallest payout (in lamports of value) whose share of the batch fee is at most `maxFeeBps`. */
export function minWorthwhileLamports(m: PayoutCostModel): bigint {
  if (m.maxFeeBps <= 0) return 0n;
  return (feePerRecipient(m) * 10_000n + BigInt(m.maxFeeBps) - 1n) / BigInt(m.maxFeeBps);
}

/** `configured`, raised to the smallest SOL amount worth a recipient slot. */
export function effectiveMinSol(configured: bigint, m: PayoutCostModel): bigint {
  const worthwhile = minWorthwhileLamports(m);
  return worthwhile > configured ? worthwhile : configured;
}

/**
 * `configured`, raised to the smallest token amount worth a slot at `lamportsPerRawToken`
 * (price × 1e18 fixed point: lamports per base unit × 10^18). Unknown price → `configured`.
 */
export function effectiveMinTokens(configured: bigint, m: PayoutCostModel, lamportsPerRawTokenFixed: bigint | null): bigint {
  if (!lamportsPerRawTokenFixed || lamportsPerRawTokenFixed <= 0n) return configured;
  const worthwhile = (minWorthwhileLamports(m) * 10n ** 18n + lamportsPerRawTokenFixed - 1n) / lamportsPerRawTokenFixed;
  return worthwhile > configured ? worthwhile : configured;
}

export interface RoundEconomics {
  recipients: number;
  /** SOL paid + tokens paid valued at the current price, lamports. */
  valueLamports: bigint;
  feeLamports: bigint;
  worthIt: boolean;
}

/** Whether a computed round is worth its fees. */
export function assessRound(m: PayoutCostModel, recipients: number, solPot: bigint, tokenPot: bigint, lamportsPerRawTokenFixed: bigint | null): RoundEconomics {
  const tokenValue = lamportsPerRawTokenFixed && lamportsPerRawTokenFixed > 0n ? (tokenPot * lamportsPerRawTokenFixed) / 10n ** 18n : 0n;
  const valueLamports = solPot + tokenValue;
  const feeLamports = roundFee(m, recipients);
  return { recipients, valueLamports, feeLamports, worthIt: recipients > 0 && feeLamports * 10_000n <= valueLamports * BigInt(m.maxFeeBps) };
}
