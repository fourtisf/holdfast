import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { fixedToSolPerToken } from "@holdfast/core";
import {
  getCoin,
  getRound,
  getTradesBySig,
  getVaultState,
  getWalletBalance,
  insertRound,
  isExcluded,
  listCandles,
  listDefends,
  listFloorHistory,
  loadLedger,
  type Db,
} from "@holdfast/db";
import type { ProcessResult } from "../src/index.js";
import { coinFixture, harness, holdfastFields, launchTx, TxBuilder, wallet, type CoinFixture, type Harness } from "./fixtures.js";

const T0 = 1_760_000_000; // unix seconds, block time of the launch
let h: Harness;
let db: Db;
let coin: CoinFixture;
const launcher = wallet();
const depositor = wallet();

function tradeSig(r: ProcessResult): string {
  if (r.status !== "processed") throw new Error(`not processed: ${r.status}`);
  for (const n of r.notifications) if (n.kind === "trade") return n.sig;
  throw new Error("no trade notification");
}

async function lots(owner: string) {
  return (await loadLedger(db, coin.mint, owner)).lots.map((l) => [l.amount, l.acquiredAt]);
}

async function buy(slot: number, ts: number, user: string, tokens: bigint, pre: bigint, sol = 1_000_000_000n) {
  return h.run(
    new TxBuilder(slot, ts, user)
      .curveTrade({ mint: coin.mint, user, isBuy: true, sol, tokens })
      .balance(coin.mint, coin.ata(coin.bondingCurve), coin.bondingCurve, 900_000_000_000_000n, 900_000_000_000_000n - tokens)
      .balance(coin.mint, coin.ata(user), user, pre === 0n ? null : pre, pre + tokens)
      .build(),
  );
}

async function sell(slot: number, ts: number, user: string, tokens: bigint, pre: bigint, sol = 500_000_000n) {
  return h.run(
    new TxBuilder(slot, ts, user)
      .curveTrade({ mint: coin.mint, user, isBuy: false, sol, tokens })
      .balance(coin.mint, coin.ata(coin.bondingCurve), coin.bondingCurve, 800_000_000_000_000n, 800_000_000_000_000n + tokens)
      .balance(coin.mint, coin.ata(user), user, pre, pre - tokens)
      .build(),
  );
}

async function transfer(slot: number, ts: number, from: string, to: string, amount: bigint, fromPre: bigint, toPre: bigint) {
  return h.run(
    new TxBuilder(slot, ts, from)
      .balance(coin.mint, coin.ata(from), from, fromPre, fromPre - amount)
      .balance(coin.mint, coin.ata(to), to, toPre === 0n ? null : toPre, toPre + amount)
      .build(),
  );
}

beforeEach(async () => {
  h = await harness({ globalExclusions: [{ address: launcher, reason: "launcher" }] });
  db = h.db;
  coin = coinFixture();
  const r = await h.run(launchTx(coin, { launcher, depositor, slot: 100, ts: T0, devBuy: 50_000_000_000n }));
  expect(r.status).toBe("processed");
});
afterEach(async () => {
  await db.close();
});

describe("registration and launch", () => {
  it("registers the coin from CoinInitialized + CreateEvent and excludes its PDAs", async () => {
    const row = await getCoin(db, coin.mint);
    expect(row).toMatchObject({ name: "Dog Coin", ticker: "DOG", triggerBps: 2500, vault: coin.vault, treasury: coin.treasury, metadataUri: "https://meta/dog.json" });
    expect(row?.launchSig).toBeTruthy();
    for (const a of [coin.vault, coin.treasury, coin.bondingCurve, coin.pool, launcher]) expect(await isExcluded(db, a)).toBe(true);
    expect(h.publisher.events).toEqual(expect.arrayContaining([{ kind: "coin", mint: coin.mint }]));
  });

  it("the launch dev buy creates no lot: the depositor's tokens are untracked", async () => {
    expect(await lots(depositor)).toEqual([]);
    expect(await getWalletBalance(db, coin.mint, depositor)).toMatchObject({ balance: 50_000_000_000n, untracked: 50_000_000_000n });
    expect(await getWalletBalance(db, coin.mint, launcher)).toBeNull();
    const trades = await getTradesBySig(db, (await getCoin(db, coin.mint))!.launchSig!);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ side: "buy", wallet: launcher, source: "curve" });
  });

  it("pool and bonding-curve owners never get a balance row", async () => {
    await buy(110, T0 + 10, wallet(), 1_000n, 0n);
    expect(await getWalletBalance(db, coin.mint, coin.bondingCurve)).toBeNull();
  });

  it("ignores mints that are not Holdfast coins", async () => {
    const other = coinFixture();
    const user = wallet();
    const r = await h.run(
      new TxBuilder(120, T0 + 20, user)
        .curveTrade({ mint: other.mint, user, isBuy: true, sol: 1n, tokens: 1n })
        .balance(other.mint, other.ata(user), user, null, 1n)
        .build(),
    );
    expect(r.status).toBe("irrelevant");
  });
});

describe("lots (spec §2)", () => {
  it("a buy creates a lot dated at block time and records the trade", async () => {
    const alice = wallet();
    const r = await buy(200, T0 + 3600, alice, 1_000_000n, 0n, 2_000_000_000n);
    expect(r).toMatchObject({ status: "processed", trades: 1, lots: 1 });
    expect(await lots(alice)).toEqual([[1_000_000n, (T0 + 3600) * 1000]]);
    expect(await getWalletBalance(db, coin.mint, alice)).toMatchObject({ balance: 1_000_000n, untracked: 0n, updatedSlot: 200 });
    const trade = (await getTradesBySig(db, tradeSig(r)))[0];
    expect(trade).toMatchObject({ side: "buy", sol: 2_000_000_000n, tokens: 1_000_000n, source: "curve", wallet: alice });
    expect(trade?.price).toBeCloseTo(2 / 1, 9);
    // last price = curve spot after the trade (30 SOL / 1.073e9 tokens)
    expect((await getCoin(db, coin.mint))?.lastPrice).toBeCloseTo(fixedToSolPerToken((30_000_000_000n * 10n ** 18n) / 1_073_000_000_000_000n), 15);
  });

  it("partial sell keeps the remaining lot ages (FIFO)", async () => {
    const a = wallet();
    await buy(200, T0 + 100, a, 100n, 0n);
    await buy(201, T0 + 200, a, 50n, 100n);
    await sell(202, T0 + 300, a, 120n, 150n);
    expect(await lots(a)).toEqual([[30n, (T0 + 200) * 1000]]);
    expect(await getWalletBalance(db, coin.mint, a)).toMatchObject({ balance: 30n, untracked: 0n });
  });

  it("selling everything clears all lots; the next buy starts fresh", async () => {
    const a = wallet();
    await buy(200, T0 + 100, a, 100n, 0n);
    await buy(201, T0 + 200, a, 50n, 100n);
    await sell(202, T0 + 300, a, 150n, 150n);
    expect(await lots(a)).toEqual([]);
    await buy(203, T0 + 400, a, 10n, 0n);
    expect(await lots(a)).toEqual([[10n, (T0 + 400) * 1000]]);
  });

  it("tokens received by transfer are untracked; transfers out reduce the sender FIFO", async () => {
    const a = wallet();
    const b = wallet();
    await buy(200, T0 + 100, a, 100n, 0n);
    await buy(201, T0 + 200, a, 100n, 100n);
    await transfer(202, T0 + 300, a, b, 150n, 200n, 0n);
    expect(await lots(a)).toEqual([[50n, (T0 + 200) * 1000]]);
    expect(await lots(b)).toEqual([]);
    expect(await getWalletBalance(db, coin.mint, b)).toMatchObject({ balance: 150n, untracked: 150n });
    // b buys, then sells part: the untracked tokens go first, its lot survives.
    await buy(203, T0 + 400, b, 40n, 150n);
    await sell(204, T0 + 500, b, 160n, 190n);
    expect(await lots(b)).toEqual([[30n, (T0 + 400) * 1000]]);
    expect(await getWalletBalance(db, coin.mint, b)).toMatchObject({ balance: 30n, untracked: 0n });
  });

  it("tokens bought by A but delivered to B are untracked for B", async () => {
    const a = wallet();
    const b = wallet();
    await h.run(
      new TxBuilder(200, T0 + 100, a)
        .curveTrade({ mint: coin.mint, user: a, isBuy: true, sol: 1n, tokens: 70n })
        .balance(coin.mint, coin.ata(b), b, null, 70n)
        .build(),
    );
    expect(await lots(b)).toEqual([]);
    expect(await getWalletBalance(db, coin.mint, b)).toMatchObject({ balance: 70n, untracked: 70n });
  });

  it("LIFO order when configured", async () => {
    await db.close();
    h = await harness({ reductionOrder: "lifo" });
    db = h.db;
    coin = coinFixture();
    await h.run(launchTx(coin, { launcher, depositor, slot: 100, ts: T0, devBuy: 1n }));
    const a = wallet();
    await buy(200, T0 + 100, a, 100n, 0n);
    await buy(201, T0 + 200, a, 50n, 100n);
    await sell(202, T0 + 300, a, 120n, 150n);
    expect(await lots(a)).toEqual([[30n, (T0 + 100) * 1000]]);
  });

  it("decodes trades from Program data logs too", async () => {
    const a = wallet();
    const r = await h.run(
      new TxBuilder(200, T0 + 100, a)
        .curveTrade({ mint: coin.mint, user: a, isBuy: true, sol: 5n, tokens: 25n, viaLogs: true })
        .balance(coin.mint, coin.ata(a), a, null, 25n)
        .build(),
    );
    expect(r).toMatchObject({ status: "processed", trades: 1, lots: 1 });
  });
});

describe("robustness", () => {
  it("reprocessing a transaction is a no-op", async () => {
    const a = wallet();
    const tx = new TxBuilder(200, T0 + 100, a)
      .curveTrade({ mint: coin.mint, user: a, isBuy: true, sol: 1_000_000_000n, tokens: 100n })
      .balance(coin.mint, coin.ata(a), a, null, 100n)
      .build();
    expect((await h.run(tx)).status).toBe("processed");
    expect((await h.run(tx)).status).toBe("duplicate");
    expect(await lots(a)).toEqual([[100n, (T0 + 100) * 1000]]);
    expect(await getTradesBySig(db, tx.signature)).toHaveLength(1);
    const candles = await listCandles(db, coin.mint, "1m", { limit: 10 });
    expect(candles.at(-1)?.volume).toBe(1_000_000_000n);
  });

  it("out-of-order delivery: a sell indexed before its buy still leaves the right lot", async () => {
    const a = wallet();
    const buyTx = new TxBuilder(200, T0 + 100, a)
      .curveTrade({ mint: coin.mint, user: a, isBuy: true, sol: 1n, tokens: 100n })
      .balance(coin.mint, coin.ata(a), a, null, 100n)
      .build();
    const sellTx = new TxBuilder(201, T0 + 200, a)
      .curveTrade({ mint: coin.mint, user: a, isBuy: false, sol: 1n, tokens: 40n })
      .balance(coin.mint, coin.ata(a), a, 100n, 60n)
      .build();
    await h.run(sellTx);
    expect(await getWalletBalance(db, coin.mint, a)).toMatchObject({ balance: 60n, untracked: 60n });
    await h.run(buyTx);
    expect(await lots(a)).toEqual([[60n, (T0 + 100) * 1000]]);
    expect(await getWalletBalance(db, coin.mint, a)).toMatchObject({ balance: 60n, untracked: 0n });
  });

  it("a missed transfer out (balance gap) reduces lots FIFO before the next trade", async () => {
    const a = wallet();
    await buy(200, T0 + 100, a, 100n, 0n);
    await buy(201, T0 + 200, a, 100n, 100n);
    // The chain says a held 150 before this sell: 50 left unseen.
    await sell(300, T0 + 300, a, 10n, 150n);
    expect(await lots(a)).toEqual([
      [40n, (T0 + 100) * 1000],
      [100n, (T0 + 200) * 1000],
    ]);
  });

  it("skips failed transactions", async () => {
    const a = wallet();
    const tx = { ...new TxBuilder(200, T0, a).curveTrade({ mint: coin.mint, user: a, isBuy: true, sol: 1n, tokens: 1n }).build(), err: { InstructionError: [0, "Custom"] } };
    expect((await h.run(tx)).status).toBe("failed_tx");
    expect((await h.run(tx)).status).toBe("duplicate");
  });
});

describe("candles", () => {
  it("OHLCV across buckets", async () => {
    const a = wallet();
    const base = Math.floor(T0 / 3600) * 3600 + 3600; // start of an hour
    // price = sol / tokens (SOL per whole token, 6 decimals): 1 SOL / 1 token = 1.0
    await buy(200, base + 5, a, 1_000_000n, 0n, 1_000_000_000n); // 1.0
    await buy(201, base + 30, a, 1_000_000n, 1_000_000n, 3_000_000_000n); // 3.0
    await sell(202, base + 50, a, 1_000_000n, 2_000_000n, 2_000_000_000n); // 2.0
    await buy(203, base + 70, a, 1_000_000n, 1_000_000n, 4_000_000_000n); // next minute: 4.0
    const m1 = await listCandles(db, coin.mint, "1m", { limit: 10, from: base * 1000 });
    expect(m1).toEqual([
      { ts: base * 1000, open: 1, high: 3, low: 1, close: 2, volume: 6_000_000_000n, trades: 3 },
      { ts: (base + 60) * 1000, open: 4, high: 4, low: 4, close: 4, volume: 4_000_000_000n, trades: 1 },
    ]);
    const h1 = await listCandles(db, coin.mint, "1h", { limit: 10, from: base * 1000 });
    expect(h1).toEqual([{ ts: base * 1000, open: 1, high: 4, low: 1, close: 4, volume: 10_000_000_000n, trades: 4 }]);
  });
});

describe("vault activity", () => {
  it("a vault buyback is a `vault` trade plus a defend, never a lot", async () => {
    const r = await h.run(
      new TxBuilder(300, T0 + 600, wallet())
        .holdfast([{ name: "Defended", fields: holdfastFields.defended(coin, 250_000_000n, 9_000_000_000n, T0 + 600) }])
        .curveTrade({ mint: coin.mint, user: coin.treasury, isBuy: true, sol: 250_000_000n, tokens: 9_000_000_000n })
        .balance(coin.mint, coin.ata(coin.treasury), coin.treasury, 0n, 9_000_000_000n)
        .build(),
    );
    expect(r).toMatchObject({ status: "processed", trades: 1, lots: 0 });
    const [trade] = await getTradesBySig(db, tradeSig(r));
    expect(trade).toMatchObject({ side: "vault", source: "vault", wallet: coin.treasury });
    expect(await listDefends(db, coin.mint, { limit: 5 })).toEqual([
      expect.objectContaining({ solSpent: 250_000_000n, tokensBought: 9_000_000_000n, ts: (T0 + 600) * 1000 }),
    ]);
    expect(await getWalletBalance(db, coin.mint, coin.treasury)).toBeNull();
    expect(await getVaultState(db, coin.mint)).toMatchObject({ holderTokens: 9_000_000_000n, totalDefended: 250_000_000n, defendCount: 1n, lastDefendTs: (T0 + 600) * 1000 });
  });

  it("fees, ATH and payout round events update the mirror", async () => {
    await h.run(
      new TxBuilder(300, T0 + 600, wallet())
        .holdfast([
          { name: "FeesCollected", fields: holdfastFields.feesCollected(coin, 1_000_000n, T0 + 600, 5_000n) },
          { name: "AthUpdated", fields: holdfastFields.athUpdated(coin, 4n * 10n ** 13n, 3n * 10n ** 13n, T0 + 600) },
        ])
        .build(),
    );
    expect(await getVaultState(db, coin.mint)).toMatchObject({ floorSol: 600_000n, holderSol: 300_000n, burnSol: 100_000n, holderTokens: 5_000n, totalFees: 1_000_000n, ath: 4n * 10n ** 13n, floor: 3n * 10n ** 13n });
    expect(await listFloorHistory(db, coin.mint)).toEqual([{ ts: (T0 + 600) * 1000, ath: 4n * 10n ** 13n, floor: 3n * 10n ** 13n }]);

    // prepare_treasury: the treasury's own accounts are paid from the floor bucket
    await h.run(new TxBuilder(305, T0 + 650, wallet()).holdfast([{ name: "TreasuryPrepared", fields: holdfastFields.treasuryPrepared(coin, 100_000n, T0 + 650) }]).build());
    expect(await getVaultState(db, coin.mint)).toMatchObject({ floorSol: 500_000n, holderSol: 300_000n, burnSol: 100_000n });

    const holder = wallet();
    await insertRound(db, {
      version: 1,
      mint: coin.mint,
      roundId: 1,
      ts: (T0 + 700) * 1000,
      snapshotAt: (T0 + 700) * 1000,
      solPot: 0.000001,
      tokenPot: 0,
      recipients: 1,
      snapshotHash: "00".repeat(32),
      status: "computed",
      inputs: { mint: coin.mint, roundId: 1, snapshotAt: 0, potSolLamports: "1000", potTokensRaw: "0", params: { minSolLamports: "0", minTokensRaw: "0", rentExemptMinLamports: "0", carryExpiryMs: 0, maxRecipients: 1 }, holders: [], carriedIn: [] },
      totalWeight: "1",
      entries: [{ index: 0, wallet: holder, weightedAmount: "1", solLamports: "1000", tokensRaw: "0", carriedSolLamports: "0", carriedTokensRaw: "0", sig: null }],
      carriedOut: [],
    });
    const opened = await h.run(new TxBuilder(310, T0 + 720, wallet()).holdfast([{ name: "RoundOpened", fields: holdfastFields.roundOpened(coin, 1n, T0 + 720) }]).build());
    expect((await getRound(db, coin.mint, 1))?.status).toBe("opened");
    expect(opened.status === "processed" && opened.notifications).toEqual(expect.arrayContaining([{ kind: "round", mint: coin.mint, roundId: 1 }]));
    await h.run(new TxBuilder(311, T0 + 730, wallet()).holdfast([{ name: "PayoutBatch", fields: holdfastFields.payoutBatch(coin, 1n, 1000n, T0 + 730) }]).build());
    expect((await getRound(db, coin.mint, 1))?.status).toBe("paying");
    expect(await getVaultState(db, coin.mint)).toMatchObject({ holderSol: 299_000n, totalPaidSol: 1000n, roundId: 1n });
    await h.run(new TxBuilder(312, T0 + 740, wallet()).holdfast([{ name: "RoundClosed", fields: holdfastFields.roundClosed(coin, 1n, T0 + 740) }]).build());
    expect((await getRound(db, coin.mint, 1))).toMatchObject({ status: "closed" });
  });

  it("an authoritative vault snapshot (fetchVault) wins over event deltas", async () => {
    await db.close();
    const snapshotFor = (mint: string) => ({
      mint,
      floorSol: 42n,
      holderSol: 7n,
      burnSol: 1n,
      holderTokens: 0n,
      ath: 0n,
      floor: 0n,
      defendCount: 0n,
      lastDefendTs: null,
      roundId: 0n,
      totalFees: 50n,
      totalDefended: 0n,
      totalPaidSol: 0n,
      totalPaidTokens: 0n,
      totalBurnedSol: 0n,
      slot: 999,
    });
    const fetched: string[] = [];
    h = await harness({
      fetchVault: async (mint) => {
        fetched.push(mint);
        return snapshotFor(mint);
      },
    });
    db = h.db;
    coin = coinFixture();
    await h.run(launchTx(coin, { launcher, depositor, slot: 100, ts: T0, devBuy: 1n }));
    await h.run(new TxBuilder(300, T0 + 600, wallet()).holdfast([{ name: "FeesCollected", fields: holdfastFields.feesCollected(coin, 1_000_000n, T0 + 600) }]).build());
    expect(fetched).toEqual([coin.mint, coin.mint]);
    expect(await getVaultState(db, coin.mint)).toMatchObject({ floorSol: 42n, holderSol: 7n, totalFees: 50n, slot: 999 });
  });

  it("an injected fake parser can stand in for the Holdfast decoder", async () => {
    await db.close();
    const c = coinFixture();
    const seen: number[] = [];
    h = await harness({
      parseHoldfastEvents: (logs) => {
        seen.push(logs.length);
        return [
          {
            name: "CoinInitialized",
            mint: new PublicKey(c.mint),
            vault: new PublicKey(c.vault),
            treasury: new PublicKey(c.treasury),
            triggerBps: 3500,
            bondingCurve: new PublicKey(c.bondingCurve),
            ts: T0,
          },
        ];
      },
    });
    db = h.db;
    // Trades of the coin (not yet known) are indexed in the same tx that registers it.
    const user = wallet();
    const r = await h.run(new TxBuilder(1, T0, user).holdfast([]).curveTrade({ mint: c.mint, user, isBuy: true, sol: 1n, tokens: 1n }).build());
    expect(r).toMatchObject({ status: "processed", trades: 1 });
    expect(seen).toHaveLength(1);
    expect(await getCoin(db, c.mint)).toMatchObject({ triggerBps: 3500, name: "", treasury: c.treasury });
    // Trades without any Holdfast invocation never call the decoder.
    await h.run(new TxBuilder(2, T0 + 1, user).curveTrade({ mint: c.mint, user, isBuy: true, sol: 1n, tokens: 1n }).build());
    expect(seen).toHaveLength(1);
  });
});

describe("pump.fun admin creator changes", () => {
  it("reports a creator change of a Holdfast coin to the hook (and flags a harmless one)", async () => {
    await db.close();
    const seen: { name: string; mint: string; toTreasury: boolean }[] = [];
    h = await harness({ onCreatorChange: (e) => void seen.push({ name: e.name, mint: e.mint, toTreasury: e.toTreasury }) });
    db = h.db;
    const c = coinFixture();
    await h.run(launchTx(c, { launcher: wallet(), depositor: wallet(), slot: 100, ts: T0, devBuy: 1n }));
    const thief = wallet();
    await h.run(new TxBuilder(200, T0 + 60, wallet()).pumpEvents([{ name: "AdminCtoEvent", fields: { mint: c.mint, new_creator: thief, timestamp: T0 + 60 } }]).build());
    await h.run(new TxBuilder(201, T0 + 61, wallet()).pumpEvents([{ name: "SetCreatorEvent", fields: { mint: c.mint, creator: c.treasury, timestamp: T0 + 61 } }]).build());
    // other coins' admin events are none of our business
    await h.run(new TxBuilder(202, T0 + 62, wallet()).pumpEvents([{ name: "AdminCtoEvent", fields: { mint: wallet(), new_creator: thief, timestamp: T0 + 62 } }]).build());
    expect(seen).toEqual([
      { name: "AdminCtoEvent", mint: c.mint, toTreasury: false },
      { name: "SetCreatorEvent", mint: c.mint, toTreasury: true },
    ]);
  });
});

describe("graduation and PumpSwap", () => {
  it("migration marks the coin graduated; pool trades are indexed as pumpswap", async () => {
    const a = wallet();
    await h.run(
      new TxBuilder(400, T0 + 1000, wallet())
        .pumpEvents([
          { name: "CompleteEvent", fields: { user: a, mint: coin.mint, bonding_curve: coin.bondingCurve, timestamp: T0 + 1000 } },
          { name: "CompletePumpAmmMigrationEvent", fields: { user: a, mint: coin.mint, pool: coin.pool, bonding_curve: coin.bondingCurve, mint_amount: 1n, sol_amount: 1n, timestamp: T0 + 1000 } },
        ])
        .build(),
    );
    expect(await getCoin(db, coin.mint)).toMatchObject({ graduated: true, ammPool: coin.pool });
    expect(await isExcluded(db, coin.pool)).toBe(true);

    const r = await h.run(
      new TxBuilder(401, T0 + 1100, a)
        .ammTrade({ pool: coin.pool, user: a, isBuy: true, sol: 100_000_000n, tokens: 1_000_000_000n, virtualQuote: -5_000_000_000n })
        .balance(coin.mint, coin.ata(coin.pool), coin.pool, 200_000_000_000_000n, 199_999_000_000_000n)
        .balance(coin.mint, coin.ata(a), a, null, 1_000_000_000n)
        .build(),
    );
    expect(r).toMatchObject({ status: "processed", trades: 1, lots: 1 });
    expect((await getTradesBySig(db, tradeSig(r)))[0]).toMatchObject({ source: "pumpswap", side: "buy", tokens: 1_000_000_000n, sol: 100_000_000n });
    expect(await lots(a)).toEqual([[1_000_000_000n, (T0 + 1100) * 1000]]);
    // spot after = (85 + 0.1 − 5) SOL / (200M − 1000) tokens
    expect((await getCoin(db, coin.mint))?.lastPrice).toBeCloseTo(80.1 / 199_999_000, 15);

    await h.run(
      new TxBuilder(402, T0 + 1200, a)
        .ammTrade({ pool: coin.pool, user: a, isBuy: false, sol: 30_000_000n, tokens: 400_000_000n })
        .balance(coin.mint, coin.ata(a), a, 1_000_000_000n, 600_000_000n)
        .build(),
    );
    expect(await lots(a)).toEqual([[600_000_000n, (T0 + 1100) * 1000]]);
  });

  it("synthetic migration: TradeEvent + PostCompleteBuyEvent both count as the buyer's purchase", async () => {
    const a = wallet();
    const r = await h.run(
      new TxBuilder(400, T0 + 1000, a)
        .pumpEvents([
          { name: "TradeEvent", fields: { mint: coin.mint, user: a, is_buy: true, sol_amount: 10n, token_amount: 70n, timestamp: T0 + 1000, virtual_sol_reserves: 1n, virtual_token_reserves: 1n } },
          { name: "CompleteEvent", fields: { user: a, mint: coin.mint, bonding_curve: coin.bondingCurve, timestamp: T0 + 1000 } },
          { name: "PostCompleteBuyEvent", fields: { user: a, mint: coin.mint, bonding_curve: coin.bondingCurve, base_out: 30n, quote_in: 5n, timestamp: T0 + 1000, pool_base_reserves_after: 100n, pool_quote_reserves_after: 100n } },
        ])
        .balance(coin.mint, coin.ata(a), a, null, 100n)
        .build(),
    );
    expect(r).toMatchObject({ status: "processed", trades: 2 });
    expect(await lots(a)).toEqual([[100n, (T0 + 1000) * 1000]]);
  });
});
