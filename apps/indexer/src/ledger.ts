import {
  applyBuy,
  applyDecrease,
  applyUntrackedIncrease,
  type LotConsumption,
  type OwnerMovement,
  type ReductionOrder,
  type WalletLedger,
} from "@holdfast/core";
import type { ParsedTx } from "./tx.js";

/**
 * Per-token-account bookkeeping on top of @holdfast/core lot rules.
 *
 * Every token account the indexer has seen is mirrored with its amount and slot. A transaction is
 * applied to an account only when it continues that history (`pre == stored`, or a later slot):
 *  - later slot but `pre ≠ stored` → a gap (history never indexed, e.g. a wallet-to-wallet transfer
 *    that touched no watched address). The difference is reconciled first: tokens that appeared are
 *    untracked, tokens that disappeared reduce lots (untracked first, then FIFO).
 *  - earlier slot (or same slot without continuity) → stale: the account already reflects it. The
 *    balance is left alone, but a buy in it can still turn untracked tokens back into a lot dated at
 *    its block time ("late buy"), so out-of-order delivery does not cost a buyer their lot.
 */

export interface AccountChange {
  account: string;
  owner: string;
  pre: bigint;
  post: bigint;
}

export interface StoredAccount {
  owner: string;
  amount: bigint;
  slot: number;
}

/** pre/post token balances of `mint`, joined per token account. Accounts without an owner are dropped. */
export function accountChanges(tx: ParsedTx, mint: string): AccountChange[] {
  const byAccount = new Map<string, { owner: string | null; pre: bigint; post: bigint }>();
  for (const b of tx.preTokenBalances) {
    if (b.mint !== mint) continue;
    const e = byAccount.get(b.account) ?? { owner: null, pre: 0n, post: 0n };
    e.pre += b.amount;
    e.owner ??= b.owner;
    byAccount.set(b.account, e);
  }
  for (const b of tx.postTokenBalances) {
    if (b.mint !== mint) continue;
    const e = byAccount.get(b.account) ?? { owner: null, pre: 0n, post: 0n };
    e.post += b.amount;
    e.owner = b.owner ?? e.owner;
    byAccount.set(b.account, e);
  }
  const out: AccountChange[] = [];
  for (const [account, e] of byAccount) if (e.owner) out.push({ account, owner: e.owner, pre: e.pre, post: e.post });
  return out.sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
}

export interface OwnerEffect {
  owner: string;
  /** Net history missed before this tx (+ appeared, − disappeared). Reconciled first. */
  gap: bigint;
  /** post − pre over accounts this tx continues. */
  delta: bigint;
  /** Positive changes on stale accounts (late-buy candidates). */
  staleIn: bigint;
}

export interface AccountsPlan {
  effects: Map<string, OwnerEffect>;
  /** New mirror rows for the accounts this tx advanced. */
  accountUpdates: { address: string; owner: string; amount: bigint }[];
}

export function planAccounts(
  changes: readonly AccountChange[],
  stored: ReadonlyMap<string, StoredAccount>,
  slot: number,
  mode: "absolute" | "delta" = "absolute",
): AccountsPlan {
  const effects = new Map<string, OwnerEffect>();
  const effect = (owner: string) => {
    let e = effects.get(owner);
    if (!e) {
      e = { owner, gap: 0n, delta: 0n, staleIn: 0n };
      effects.set(owner, e);
    }
    return e;
  };
  const accountUpdates: AccountsPlan["accountUpdates"] = [];

  for (const c of changes) {
    let prev = stored.get(c.account);
    if (prev && prev.owner !== c.owner) {
      // Token account changed hands outside our view: the old owner lost what we mirrored.
      if (prev.amount > 0n) effect(prev.owner).gap -= prev.amount;
      prev = undefined;
    }
    const delta = c.post - c.pre;
    if (mode === "delta") {
      // Only the change is known: apply it, keep the mirror moving by the same delta.
      effect(c.owner).delta += delta;
      const base = prev?.amount ?? 0n;
      const next = base + delta;
      accountUpdates.push({ address: c.account, owner: c.owner, amount: next < 0n ? 0n : next });
      continue;
    }
    const prevAmount = prev?.amount ?? 0n;
    const prevSlot = prev?.slot ?? -1;
    const continues = prevAmount === c.pre;
    const fresh = slot > prevSlot || (slot === prevSlot && continues);
    if (fresh) {
      const e = effect(c.owner);
      if (!continues) e.gap += c.pre - prevAmount;
      e.delta += delta;
      accountUpdates.push({ address: c.account, owner: c.owner, amount: c.post });
    } else if (delta > 0n) {
      effect(c.owner).staleIn += delta;
    }
  }
  return { effects, accountUpdates };
}

export interface NewLotPlan {
  amount: bigint;
  acquiredAt: number;
  /** Offset added to the tx's lot source index (late-buy lots use a separate range). */
  late: boolean;
}

export interface LedgerPlan {
  ledger: WalletLedger;
  consumed: LotConsumption[];
  newLots: NewLotPlan[];
}

/**
 * Apply one transaction's effect on a wallet: gap reconciliation, then the movement from
 * `classifyMovements`, then the late-buy upgrade (untracked → lot) for stale accounts.
 */
export function planLedger(
  start: WalletLedger,
  input: {
    gap: bigint;
    movement: OwnerMovement | null;
    /** Tokens bought in this tx that landed in stale accounts. */
    lateBuy: bigint;
    acquiredAt: number;
    order: ReductionOrder;
    lotKey: string;
  },
): LedgerPlan {
  let ledger = start;
  const consumed: LotConsumption[] = [];
  const newLots: NewLotPlan[] = [];
  const decrease = (amount: bigint) => {
    const r = applyDecrease(ledger, amount, input.order);
    ledger = r.ledger;
    consumed.push(...r.consumed);
  };

  if (input.gap > 0n) ledger = applyUntrackedIncrease(ledger, input.gap);
  else if (input.gap < 0n) decrease(-input.gap);

  const m = input.movement;
  if (m) {
    if (m.decrease > 0n) decrease(m.decrease);
    if (m.untrackedIn > 0n) ledger = applyUntrackedIncrease(ledger, m.untrackedIn);
    if (m.bought > 0n) {
      ledger = applyBuy(ledger, { id: `~${input.lotKey}:0`, amount: m.bought, acquiredAt: input.acquiredAt });
      newLots.push({ amount: m.bought, acquiredAt: input.acquiredAt, late: false });
    }
  }

  const late = input.lateBuy < ledger.untracked ? input.lateBuy : ledger.untracked;
  if (late > 0n) {
    const base = { balance: ledger.balance - late, untracked: ledger.untracked - late, lots: ledger.lots };
    ledger = applyBuy(base, { id: `~${input.lotKey}:1`, amount: late, acquiredAt: input.acquiredAt });
    newLots.push({ amount: late, acquiredAt: input.acquiredAt, late: true });
  }
  return { ledger, consumed, newLots };
}
