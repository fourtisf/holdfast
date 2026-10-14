import { LAUNCH_FEE_LAMPORTS } from "@holdfast/core";
import { describe, expect, it } from "vitest";

import {
  computeLaunchCost,
  DEFAULT_PRIORITY,
  DEFAULT_RENT,
  formatSol,
  initReimbursement,
  priorityFee,
  rentFromChain,
  treasuryPrepareCost,
  txFee,
  type PriorityConfig,
} from "@holdfast/chain";
import { COIN_VAULT_SIZE, PUMP_BONDING_CURVE_SIZE, pumpMintSize, SPL_TOKEN_ACCOUNT_SIZE, TOKEN_2022_ATA_SIZE } from "@holdfast/chain";

const r = DEFAULT_RENT;

describe("account sizes", () => {
  it("match the on-chain layouts", () => {
    expect(COIN_VAULT_SIZE).toBe(730); // 8 + CoinVault::INIT_SPACE (IDL)
    expect(PUMP_BONDING_CURVE_SIZE).toBe(166);
    expect(TOKEN_2022_ATA_SIZE).toBe(170); // 165 + account type + ImmutableOwner TLV
    expect(SPL_TOKEN_ACCOUNT_SIZE).toBe(165);
    // 82 → 165 base + 1 account type + MetadataPointer TLV (4 + 64) = 234, then the TokenMetadata TLV:
    // 4 header + update authority 32 + mint 32 + three u32 string lengths + strings + empty vec 4
    expect(pumpMintSize(10, 4, 100)).toBe(234 + 4 + 32 + 32 + 12 + 114 + 4);
  });

  it("rent matches the cluster formula", () => {
    expect(r(0)).toBe(890_880n);
    expect(r(165)).toBe(2_039_280n);
    expect(r(137)).toBe(1_844_400n); // pump docs: 0.0018444 SOL for the volume accumulator
  });
});

describe("computeLaunchCost", () => {
  it("adds up every account and fee of a launch (worst-case metadata by default)", () => {
    const cost = computeLaunchCost(r);
    const byKey = Object.fromEntries(cost.items.map((i) => [i.key, i.lamports]));
    expect(byKey).toEqual({
      pump_mint: r(pumpMintSize(32, 13, 200)),
      pump_bonding_curve: 2_046_240n,
      pump_curve_token_account: 2_074_080n,
      holdfast_vault: r(COIN_VAULT_SIZE),
      treasury_rent: 890_880n,
      fee_create: 10_000n + 12_500n,
      fee_init: 10_000n + 12_500n,
      fee_refund: 5_000n + 100n,
    });
    expect(cost.consumed).toBe(cost.items.reduce((s, i) => s + i.lamports, 0n));
    expect(cost.floatTotal).toBe(890_880n);
    expect(cost.exceedsSpecFee).toBe(true);
    expect(cost.launchFee).toBe(cost.consumed + cost.floatTotal);
    expect(cost.requiredLamports).toBe(cost.launchFee);
    expect(formatSol(cost.consumed)).toBe("0.015842340");
  });

  it("stays within the spec's 0.015 SOL for realistic metadata (an IPFS URI)", () => {
    const cost = computeLaunchCost(r, { nameBytes: 12, symbolBytes: 5, uriBytes: 80 });
    expect(cost.consumed).toBeLessThanOrEqual(LAUNCH_FEE_LAMPORTS);
  });

  it("the launch no longer pre-pays the treasury's token accounts (prepare_treasury does, from fees)", () => {
    expect(treasuryPrepareCost(r)).toBe(r(170) + r(165) + r(137));
  });

  it("charges the spec's 0.015 SOL when the real cost is lower (max)", () => {
    const cheap = computeLaunchCost(() => 0n, { priority: { ...DEFAULT_PRIORITY, microLamports: 0n } });
    expect(cheap.exceedsSpecFee).toBe(false);
    expect(cheap.launchFee).toBe(LAUNCH_FEE_LAMPORTS);
    expect(cheap.requiredLamports).toBe(LAUNCH_FEE_LAMPORTS);
  });

  it("adds the dev buy, its costs and its refunded float", () => {
    const devBuy = 1_000_000_000n;
    const cost = computeLaunchCost(r, { nameBytes: 5, symbolBytes: 3, uriBytes: 100, devBuyLamports: devBuy });
    expect(cost.devBuy.items.map((i) => [i.key, i.lamports])).toEqual([
      ["sender_token_account", 2_074_080n],
      ["fee_dev_buy", 5_000n + 15_000n],
    ]);
    expect(cost.devBuy.float.map((i) => [i.key, i.lamports])).toEqual([
      ["deposit_token_account", 2_074_080n],
      ["deposit_volume_accumulator", 1_844_400n],
      ["dev_buy_slippage", 50_000_000n],
    ]);
    expect(cost.requiredLamports).toBe(cost.launchFee + devBuy + cost.devBuy.consumed + cost.devBuy.floatTotal);

    const keep = computeLaunchCost(r, { nameBytes: 5, symbolBytes: 3, uriBytes: 100, devBuyLamports: devBuy, closeDepositAccumulator: false });
    expect(keep.devBuy.items.map((i) => i.key)).toContain("deposit_volume_accumulator");
    expect(keep.devBuy.float.map((i) => i.key)).not.toContain("deposit_volume_accumulator");
  });
});

describe("fees", () => {
  it("signatures + compute-unit price × limit, rounded up", () => {
    const p: PriorityConfig = { microLamports: 1n, units: { create: 1, init: 1_000_001, devBuy: 0, refund: 0, atomic: 0, atomicDevBuy: 0 } };
    expect(priorityFee(1n, 1)).toBe(1n);
    expect(priorityFee(0n, 1_000_000)).toBe(0n);
    expect(txFee("create", p)).toBe(10_001n);
    expect(txFee("init", p)).toBe(10_002n);
    expect(txFee("refund", p)).toBe(5_000n);
  });
});

describe("rentFromChain", () => {
  it("derives the linear rent function from the cluster", async () => {
    const fn = await rentFromChain(async (len) => r(len));
    expect(fn(1234)).toBe(r(1234));
    await expect(rentFromChain(async (len) => (len === 1000 ? 1n : r(len)))).rejects.toThrow(/not linear/);
  });
});

describe("initReimbursement", () => {
  it("is exactly the rent init_coin makes the launcher pay", () => {
    expect(initReimbursement(r, { treasuryLamports: 0n }).lamports).toBe(r(COIN_VAULT_SIZE) + r(0));
    expect(initReimbursement(r, { treasuryLamports: 100_000n }).lamports).toBe(r(COIN_VAULT_SIZE) + (r(0) - 100_000n));
    expect(initReimbursement(r, { treasuryLamports: 5_000_000n }).lamports).toBe(r(COIN_VAULT_SIZE));
  });
});
