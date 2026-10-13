import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { fixedToSolPerToken } from "@holdfast/core";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "../constants.js";
import {
  ammSpotAfter,
  ammSpotBefore,
  curveSpotAfter,
  decodePumpEventBytes,
  emitCpiData,
  encodePumpEvent,
  parsePumpEvents,
  programDataLog,
  programDataLogs,
  tradeAmounts,
  type AmmBuyEvent,
  type AmmSellEvent,
  type CurveTradeEvent,
} from "./index.js";

const PUMP = PUMP_PROGRAM_ID.toBase58();
const AMM = PUMP_AMM_PROGRAM_ID.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const user = Keypair.generate().publicKey.toBase58();
const pool = Keypair.generate().publicKey.toBase58();

const trade = encodePumpEvent("pump", "TradeEvent", {
  mint,
  user,
  is_buy: true,
  sol_amount: 1_000_000_000n,
  token_amount: 34_612_903_225_806n,
  timestamp: 1_760_000_000,
  virtual_sol_reserves: 31_000_000_000n,
  virtual_token_reserves: 1_038_387_096_774_194n,
  real_sol_reserves: 1_000_000_000n,
  real_token_reserves: 758_487_096_774_194n,
  fee: 9_500_000n,
  creator_fee: 500_000n,
  ix_name: "buy_v2",
  shareholders: [{ address: user, share_bps: 10_000 }],
});

describe("pump event decoding", () => {
  it("decodes TradeEvent bytes produced with the IDL coder", () => {
    const e = decodePumpEventBytes("pump", trade) as CurveTradeEvent;
    expect(e).toMatchObject({
      type: "curve_trade",
      mint,
      user,
      isBuy: true,
      solAmount: 1_000_000_000n,
      tokenAmount: 34_612_903_225_806n,
      timestamp: 1_760_000_000,
      ixName: "buy_v2",
      fee: 9_500_000n,
    });
    const amounts = tradeAmounts(e);
    expect(amounts.price).toBeCloseTo(1 / 34_612_903.225806, 12);
    expect(fixedToSolPerToken(curveSpotAfter(e))).toBeCloseTo(31 / 1_038_387_096.774194, 12);
  });

  it("returns null for foreign / garbage bytes", () => {
    expect(decodePumpEventBytes("pump", Uint8Array.from([1, 2, 3]))).toBeNull();
    expect(decodePumpEventBytes("pump", new Uint8Array(40))).toBeNull();
    expect(decodePumpEventBytes("pump_amm", trade)).toBeNull();
  });

  it("finds events in emit_cpi inner instructions and in Program data logs, once", () => {
    const create = encodePumpEvent("pump", "CreateEvent", { name: "Dog", symbol: "DOG", uri: "u", mint, bonding_curve: pool, user, creator: user, timestamp: 5 });
    const sell = encodePumpEvent("pump_amm", "SellEvent", { pool, user, base_amount_in: 10n, quote_amount_out: 20n, virtual_quote_reserves: -7n });
    const logs = [
      `Program ${PUMP} invoke [1]`,
      "Program log: Instruction: BuyV2",
      programDataLog(trade), // same event also emitted via cpi below → reported once
      `Program ${PUMP} invoke [2]`,
      `Program ${PUMP} success`,
      `Program ${PUMP} success`,
      `Program ${AMM} invoke [1]`,
      programDataLog(sell),
      `Program ${AMM} success`,
      "Program data: bm90LWFuLWV2ZW50", // not inside any program: ignored
    ];
    const events = parsePumpEvents({
      logMessages: logs,
      instructions: [
        { programId: PUMP, data: emitCpiData(create), outerIndex: 0 },
        { programId: PUMP, data: emitCpiData(trade), outerIndex: 0 },
        { programId: AMM, data: Uint8Array.from([1, 2, 3]), outerIndex: 1 },
        { programId: "11111111111111111111111111111111", data: emitCpiData(trade), outerIndex: 1 },
      ],
    });
    expect(events.map((e) => [e.event.type, e.source, e.index])).toEqual([
      ["create", "cpi", 0],
      ["curve_trade", "cpi", 1],
      ["amm_sell", "log", 2],
    ]);
    expect((events[2]!.event as AmmSellEvent).virtualQuoteReserves).toBe(-7n);
    expect(events[0]!.event).toMatchObject({ name: "Dog", symbol: "DOG", mint, bondingCurve: pool });
  });

  it("attributes Program data lines to the executing program", () => {
    expect(
      programDataLogs([`Program A invoke [1]`, `Program B invoke [2]`, "Program data: b", `Program B success`, "Program data: a", `Program A failed: x`]),
    ).toEqual([
      { programId: "B", data: "b" },
      { programId: "A", data: "a" },
    ]);
  });

  it("decodes completion, migration and synthetic-migration events", () => {
    const events = parsePumpEvents({
      instructions: [
        { programId: PUMP, data: emitCpiData(encodePumpEvent("pump", "CompleteEvent", { user, mint, bonding_curve: pool, timestamp: 9 })), outerIndex: 0 },
        {
          programId: PUMP,
          data: emitCpiData(encodePumpEvent("pump", "PostCompleteBuyEvent", { user, mint, base_out: 5n, quote_in: 7n, pool_base_reserves_after: 100n, pool_quote_reserves_after: 200n })),
          outerIndex: 0,
        },
        {
          programId: PUMP,
          data: emitCpiData(encodePumpEvent("pump", "CompletePumpAmmMigrationEvent", { user, mint, pool, mint_amount: 1n, sol_amount: 2n, timestamp: 10 })),
          outerIndex: 1,
        },
        {
          programId: AMM,
          data: emitCpiData(encodePumpEvent("pump_amm", "CreatePoolEvent", { pool, base_mint: mint, quote_mint: user, index: 0, timestamp: 10 })),
          outerIndex: 1,
        },
      ],
    });
    expect(events.map((e) => e.event.type)).toEqual(["complete", "post_complete_buy", "migration", "amm_create_pool"]);
    expect(events[2]!.event).toMatchObject({ pool, mint });
    expect(events[3]!.event).toMatchObject({ pool, baseMint: mint });
    expect(tradeAmounts(events[1]!.event as never)).toMatchObject({ isBuy: true, sol: 7n, tokens: 5n });
  });
});

describe("PumpSwap prices", () => {
  const buy = decodePumpEventBytes(
    "pump_amm",
    encodePumpEvent("pump_amm", "BuyEvent", {
      pool,
      user,
      base_amount_out: 1_000_000_000n,
      quote_amount_in: 100_000_000n,
      quote_amount_in_with_lp_fee: 100_200_000n,
      user_quote_amount_in: 100_500_000n,
      lp_fee: 200_000n,
      pool_base_token_reserves: 200_000_000_000_000n,
      pool_quote_token_reserves: 85_000_000_000n,
      virtual_quote_reserves: -5_000_000_000n,
      ix_name: "buy",
    }),
  ) as AmmBuyEvent;

  it("prices on effective quote reserves (signed virtual_quote_reserves)", () => {
    // before: (85 − 5) SOL / 200M tokens
    expect(fixedToSolPerToken(ammSpotBefore(buy))).toBeCloseTo(80 / 200_000_000, 15);
    // after: (85 + 0.1002 − 5) SOL / (200M − 1000) tokens
    expect(fixedToSolPerToken(ammSpotAfter(buy))).toBeCloseTo(80.1002 / 199_999_000, 15);
    expect(tradeAmounts(buy)).toMatchObject({ isBuy: true, sol: 100_000_000n, tokens: 1_000_000_000n });
    expect(tradeAmounts(buy).price).toBeCloseTo(0.1 / 1000, 12);
  });

  it("sell spot", () => {
    const sell = decodePumpEventBytes(
      "pump_amm",
      encodePumpEvent("pump_amm", "SellEvent", {
        pool,
        user,
        base_amount_in: 1_000_000_000n,
        quote_amount_out: 400_000n,
        quote_amount_out_without_lp_fee: 399_200n,
        pool_base_token_reserves: 200_000_000_000_000n,
        pool_quote_token_reserves: 80_000_000_000n,
        virtual_quote_reserves: 0n,
      }),
    ) as AmmSellEvent;
    expect(fixedToSolPerToken(ammSpotAfter(sell))).toBeCloseTo((80 - 0.0003992) / 200_001_000, 15);
    expect(tradeAmounts(sell)).toMatchObject({ isBuy: false, sol: 400_000n, tokens: 1_000_000_000n });
  });
});
