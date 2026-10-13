/**
 * Lot-based hold-age tracking (spec §2 "Pelacakan umur hold").
 *
 * - Every valid buy swap creates a lot {amount, acquiredAt}.
 * - Tokens that arrive any other way (transfers in, airdrops, the launch dev buy) are `untracked`:
 *   they count toward the balance but never earn.
 * - Every decrease (sell or transfer out) first consumes untracked tokens, then lots in FIFO order
 *   (oldest first). LIFO is available behind a flag because the owner still has to confirm FIFO
 *   (see docs/decisions.md).
 * - When the balance reaches zero all lots are dropped, so the next buy starts again at 0.1×.
 */

export type ReductionOrder = "fifo" | "lifo";

export interface Lot {
  id: string;
  amount: bigint;
  acquiredAt: number;
}

export interface WalletLedger {
  balance: bigint;
  untracked: bigint;
  /** Open lots sorted by (acquiredAt, id) ascending. */
  lots: Lot[];
}

export interface LotConsumption {
  lotId: string;
  amount: bigint;
}

export function emptyLedger(): WalletLedger {
  return { balance: 0n, untracked: 0n, lots: [] };
}

export function lotsTotal(ledger: WalletLedger): bigint {
  return ledger.lots.reduce((sum, lot) => sum + lot.amount, 0n);
}

function compareLots(a: Lot, b: Lot): number {
  if (a.acquiredAt !== b.acquiredAt) return a.acquiredAt - b.acquiredAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function applyBuy(ledger: WalletLedger, lot: Lot): WalletLedger {
  if (lot.amount <= 0n) throw new Error("lot amount must be positive");
  const lots = [...ledger.lots, { ...lot }].sort(compareLots);
  return { balance: ledger.balance + lot.amount, untracked: ledger.untracked, lots };
}

/** Tokens received without a buy (transfer in): balance grows, nothing earns. */
export function applyUntrackedIncrease(ledger: WalletLedger, amount: bigint): WalletLedger {
  if (amount < 0n) throw new Error("amount must be non-negative");
  return { balance: ledger.balance + amount, untracked: ledger.untracked + amount, lots: ledger.lots };
}

export interface DecreaseResult {
  ledger: WalletLedger;
  consumedUntracked: bigint;
  consumed: LotConsumption[];
}

/**
 * Sell or transfer out of `amount`. If the ledger believes the wallet holds less than `amount`
 * (missed history), the balance clamps at zero and everything is consumed.
 */
export function applyDecrease(ledger: WalletLedger, amount: bigint, order: ReductionOrder = "fifo"): DecreaseResult {
  if (amount < 0n) throw new Error("amount must be non-negative");
  const newBalance = ledger.balance > amount ? ledger.balance - amount : 0n;

  let remaining = amount;
  const fromUntracked = remaining < ledger.untracked ? remaining : ledger.untracked;
  remaining -= fromUntracked;
  let untracked = ledger.untracked - fromUntracked;

  const ordered = order === "fifo" ? [...ledger.lots] : [...ledger.lots].reverse();
  const consumed: LotConsumption[] = [];
  const kept: Lot[] = [];
  for (const lot of ordered) {
    if (remaining === 0n) {
      kept.push(lot);
      continue;
    }
    const take = remaining < lot.amount ? remaining : lot.amount;
    remaining -= take;
    consumed.push({ lotId: lot.id, amount: take });
    if (take < lot.amount) kept.push({ ...lot, amount: lot.amount - take });
  }

  let lots = kept.sort(compareLots);
  if (newBalance === 0n) {
    for (const lot of lots) consumed.push({ lotId: lot.id, amount: lot.amount });
    lots = [];
    untracked = 0n;
  }
  return { ledger: { balance: newBalance, untracked, lots }, consumedUntracked: fromUntracked, consumed };
}

/**
 * Re-align a ledger with an observed on-chain balance (e.g. after a gap in indexing). Lots are never
 * created here: extra tokens become untracked, missing tokens are removed via `applyDecrease`.
 */
export function reconcileBalance(ledger: WalletLedger, observed: bigint, order: ReductionOrder = "fifo"): DecreaseResult {
  if (observed >= ledger.balance) {
    return { ledger: applyUntrackedIncrease(ledger, observed - ledger.balance), consumedUntracked: 0n, consumed: [] };
  }
  return applyDecrease(ledger, ledger.balance - observed, order);
}

/** Per-owner effect of one transaction on one mint. */
export interface OwnerMovement {
  owner: string;
  /** Tokens to record as a new purchase lot. */
  bought: bigint;
  /** Tokens received without a matching buy by this owner (transfer in). */
  untrackedIn: bigint;
  /** Tokens that left the wallet (sell or transfer out). */
  decrease: bigint;
}

/**
 * Classify a transaction from net token deltas per owner plus the buy events it contains.
 *
 * `deltas`: owner → (post − pre) token balance for the mint, summed over all of the owner's token accounts.
 * `buys`:   buy swap events in the tx (pump TradeEvent with is_buy, PumpSwap BuyEvent) as
 *           { user: signer wallet, tokenAmount }.
 *
 * A positive delta counts as bought only up to what that same owner bought in this tx; anything above
 * is untracked. Tokens bought by A but delivered to B's account are untracked for B (B did not buy).
 */
export function classifyMovements(
  deltas: ReadonlyMap<string, bigint>,
  buys: readonly { user: string; tokenAmount: bigint }[],
): OwnerMovement[] {
  const boughtBy = new Map<string, bigint>();
  for (const buy of buys) boughtBy.set(buy.user, (boughtBy.get(buy.user) ?? 0n) + buy.tokenAmount);

  const out: OwnerMovement[] = [];
  for (const [owner, delta] of deltas) {
    if (delta > 0n) {
      const ownBuys = boughtBy.get(owner) ?? 0n;
      const bought = delta < ownBuys ? delta : ownBuys;
      out.push({ owner, bought, untrackedIn: delta - bought, decrease: 0n });
    } else if (delta < 0n) {
      out.push({ owner, bought: 0n, untrackedIn: 0n, decrease: -delta });
    }
  }
  return out.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
}
