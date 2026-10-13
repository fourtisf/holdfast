import { describe, expect, it } from "vitest";
import {
  applyBuy,
  applyDecrease,
  applyUntrackedIncrease,
  classifyMovements,
  emptyLedger,
  lotsTotal,
  reconcileBalance,
  type WalletLedger,
} from "../src/lots.js";

const DAY = 24 * 3600 * 1000;

function ledgerWithLots(): WalletLedger {
  let l = emptyLedger();
  l = applyBuy(l, { id: "a", amount: 100n, acquiredAt: 0 });
  l = applyBuy(l, { id: "b", amount: 50n, acquiredAt: 2 * DAY });
  l = applyBuy(l, { id: "c", amount: 25n, acquiredAt: 5 * DAY });
  return l;
}

describe("lots ledger", () => {
  it("each buy creates a lot and keeps lots ordered by age", () => {
    let l = emptyLedger();
    l = applyBuy(l, { id: "late", amount: 10n, acquiredAt: 10 });
    l = applyBuy(l, { id: "early", amount: 5n, acquiredAt: 1 });
    expect(l.lots.map((x) => x.id)).toEqual(["early", "late"]);
    expect(l.balance).toBe(15n);
    expect(lotsTotal(l)).toBe(15n);
  });

  it("partial sell reduces the oldest lot first (FIFO) and remaining lots keep their age", () => {
    const { ledger, consumed } = applyDecrease(ledgerWithLots(), 120n);
    expect(consumed).toEqual([
      { lotId: "a", amount: 100n },
      { lotId: "b", amount: 20n },
    ]);
    expect(ledger.lots).toEqual([
      { id: "b", amount: 30n, acquiredAt: 2 * DAY },
      { id: "c", amount: 25n, acquiredAt: 5 * DAY },
    ]);
    expect(ledger.balance).toBe(55n);
  });

  it("LIFO (owner option) reduces the newest lot first", () => {
    const { ledger, consumed } = applyDecrease(ledgerWithLots(), 30n, "lifo");
    expect(consumed).toEqual([
      { lotId: "c", amount: 25n },
      { lotId: "b", amount: 5n },
    ]);
    expect(ledger.lots.map((x) => [x.id, x.amount])).toEqual([
      ["a", 100n],
      ["b", 45n],
    ]);
  });

  it("selling everything drops all lots so the next buy restarts at 0.1×", () => {
    const sold = applyDecrease(ledgerWithLots(), 175n).ledger;
    expect(sold).toEqual({ balance: 0n, untracked: 0n, lots: [] });
    const rebought = applyBuy(sold, { id: "d", amount: 10n, acquiredAt: 9 * DAY });
    expect(rebought.lots).toEqual([{ id: "d", amount: 10n, acquiredAt: 9 * DAY }]);
  });

  it("over-selling (missed history) clamps at zero and clears", () => {
    const { ledger } = applyDecrease(ledgerWithLots(), 1_000n);
    expect(ledger).toEqual({ balance: 0n, untracked: 0n, lots: [] });
  });

  it("tokens received by transfer never create lots", () => {
    const l = applyUntrackedIncrease(emptyLedger(), 500n);
    expect(l.lots).toHaveLength(0);
    expect(l.balance).toBe(500n);
    expect(l.untracked).toBe(500n);
  });

  it("decreases consume untracked tokens before lots", () => {
    let l = applyUntrackedIncrease(ledgerWithLots(), 40n);
    const r = applyDecrease(l, 50n);
    expect(r.consumedUntracked).toBe(40n);
    expect(r.consumed).toEqual([{ lotId: "a", amount: 10n }]);
    l = r.ledger;
    expect(l.untracked).toBe(0n);
    expect(l.balance).toBe(165n);
    expect(lotsTotal(l)).toBe(165n);
  });

  it("reconcileBalance never creates lots", () => {
    const up = reconcileBalance(ledgerWithLots(), 200n).ledger;
    expect(up.untracked).toBe(25n);
    expect(lotsTotal(up)).toBe(175n);
    const down = reconcileBalance(ledgerWithLots(), 100n).ledger;
    expect(down.balance).toBe(100n);
    expect(lotsTotal(down)).toBe(100n);
  });

  it("invariant balance = untracked + Σlots holds under random operations", () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    let l = emptyLedger();
    for (let i = 0; i < 2_000; i++) {
      const r = rand();
      const amount = BigInt(Math.floor(rand() * 1_000));
      if (r < 0.45 && amount > 0n) l = applyBuy(l, { id: `l${i}`, amount, acquiredAt: i });
      else if (r < 0.6) l = applyUntrackedIncrease(l, amount);
      else l = applyDecrease(l, amount, rand() < 0.5 ? "fifo" : "lifo").ledger;
      expect(l.balance).toBe(l.untracked + lotsTotal(l));
      expect(l.lots.every((x) => x.amount > 0n)).toBe(true);
    }
  });
});

describe("classifyMovements", () => {
  it("a buy creates a lot for the buyer", () => {
    expect(classifyMovements(new Map([["alice", 1_000n]]), [{ user: "alice", tokenAmount: 1_000n }])).toEqual([
      { owner: "alice", bought: 1_000n, untrackedIn: 0n, decrease: 0n },
    ]);
  });

  it("a transfer gives the receiver untracked tokens and reduces the sender", () => {
    expect(
      classifyMovements(
        new Map([
          ["alice", -300n],
          ["bob", 300n],
        ]),
        [],
      ),
    ).toEqual([
      { owner: "alice", bought: 0n, untrackedIn: 0n, decrease: 300n },
      { owner: "bob", bought: 0n, untrackedIn: 300n, decrease: 0n },
    ]);
  });

  it("buying on behalf of another wallet does not create a lot for either", () => {
    expect(classifyMovements(new Map([["bob", 500n]]), [{ user: "alice", tokenAmount: 500n }])).toEqual([
      { owner: "bob", bought: 0n, untrackedIn: 500n, decrease: 0n },
    ]);
  });

  it("only the bought part of a larger inflow becomes a lot", () => {
    expect(classifyMovements(new Map([["alice", 700n]]), [{ user: "alice", tokenAmount: 500n }])).toEqual([
      { owner: "alice", bought: 500n, untrackedIn: 200n, decrease: 0n },
    ]);
  });

  it("buy then sell in one tx nets out", () => {
    expect(classifyMovements(new Map([["alice", 0n]]), [{ user: "alice", tokenAmount: 500n }])).toEqual([]);
    expect(classifyMovements(new Map([["alice", -100n]]), [{ user: "alice", tokenAmount: 500n }])).toEqual([
      { owner: "alice", bought: 0n, untrackedIn: 0n, decrease: 100n },
    ]);
  });
});
