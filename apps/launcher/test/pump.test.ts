import { Keypair } from "@solana/web3.js";
import BN from "bn.js";
import { describe, expect, it } from "vitest";
import { associatedTokenAddress, bondingCurvePda, TOKEN_2022_PROGRAM_ID, treasuryPda } from "@holdfast/chain";

import { encodePumpAccount, pump, quoteDevBuy, readPumpBuyState, type PumpBuyState } from "../src/pump.js";
import { FakeChain, fakeFeeConfig, fakeGlobal } from "./fakeChain.js";

const SOL = 1_000_000_000n;

function state(): PumpBuyState {
  const global = fakeGlobal();
  return {
    global,
    feeConfig: fakeFeeConfig(),
    bondingCurve: { ...pump.newBondingCurve(global), creator: Keypair.generate().publicKey },
    mintSupply: global.tokenTotalSupply,
    curveBaseTokenBalance: new BN(global.tokenTotalSupply.toString()),
  };
}

describe("quoteDevBuy", () => {
  it("buys what the spend buys, costs at most the spend, allows the slippage within the budget", () => {
    const q = quoteDevBuy(state(), SOL, 2n * SOL, 500);
    expect(q.tokens).toBeGreaterThan(30_000_000_000_000n); // ~34M tokens for 1 SOL on a fresh curve
    expect(q.cost).toBeLessThanOrEqual(SOL);
    expect(q.cost).toBeGreaterThan(SOL - 10n);
    expect(q.maxSolCost).toBe((q.cost * 10_500n + 9_999n) / 10_000n);
  });

  it("caps max_sol_cost at the budget and refuses a budget below the cost", () => {
    const q = quoteDevBuy(state(), SOL, SOL + 1_000n, 500);
    expect(q.maxSolCost).toBe(SOL + 1_000n);
    expect(() => quoteDevBuy(state(), SOL, SOL / 2n, 500)).toThrow(/cannot cover/);
    const complete = state();
    complete.bondingCurve = { ...complete.bondingCurve, complete: true };
    expect(() => quoteDevBuy(complete, SOL, 2n * SOL, 500)).toThrow(/complete/);
  });
});

describe("readPumpBuyState", () => {
  it("decodes Global, FeeConfig, the curve, the supply and the curve's token balance", async () => {
    const chain = new FakeChain({ now: Date.now, configLauncher: Keypair.generate().publicKey });
    const mint = Keypair.generate().publicKey;
    const curve = { ...pump.newBondingCurve(chain.global), creator: treasuryPda(mint) };
    chain.put(bondingCurvePda(mint), { lamports: 1n, owner: pump.PUMP_PROGRAM_ID, data: encodePumpAccount("bondingCurve", curve) });
    const mintData = Buffer.alloc(82);
    mintData.writeBigUInt64LE(1_000_000_000_000_000n, 36);
    chain.put(mint, { lamports: 1n, owner: TOKEN_2022_PROGRAM_ID, data: mintData });
    const ata = associatedTokenAddress(bondingCurvePda(mint), mint, TOKEN_2022_PROGRAM_ID);
    chain.put(ata, { lamports: 1n, owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(170), token: { mint: mint.toBase58(), owner: bondingCurvePda(mint).toBase58(), amount: 793_100_000_000_000n } });
    const s = await readPumpBuyState(chain, mint, TOKEN_2022_PROGRAM_ID);
    expect(s.bondingCurve.creator.equals(treasuryPda(mint))).toBe(true);
    expect(s.global.buybackFeeRecipients.map((k) => k.toBase58())).toEqual(chain.global.buybackFeeRecipients.map((k) => k.toBase58()));
    expect(s.feeConfig.feeTiers).toHaveLength(2);
    expect(s.mintSupply.toString()).toBe("1000000000000000");
    expect(s.curveBaseTokenBalance.toString()).toBe("793100000000000");
    await expect(readPumpBuyState(chain, Keypair.generate().publicKey, TOKEN_2022_PROGRAM_ID)).rejects.toThrow(/not found/);
  });
});
