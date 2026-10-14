import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { BorshCoder } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  DEFAULT_PARAMS,
  HOLDFAST_IDL,
  initializeIx,
  setHoldMintIx,
  setParamsIx,
  closeRoundIx,
  coinKeys,
  collectFeesIx,
  decodeCoinVault,
  defendIx,
  encodeHoldfastEventLog,
  initCoinIx,
  openRoundIx,
  parseHoldfastEvents,
  payoutIx,
  prepareTreasuryIx,
  userVolumeAccumulatorPda,
  updateAthIx,
} from "../src/holdfast.js";
import { HOLDFAST_PROGRAM_ID } from "../src/constants.js";
import { treasuryPda, vaultPda } from "../src/pda.js";

const coder = new BorshCoder(HOLDFAST_IDL);
const mint = Keypair.generate().publicKey;
const keeper = Keypair.generate().publicKey;
const zero = new BN(0);

function ixName(data: Buffer): string | undefined {
  return coder.instruction.decode(data)?.name;
}

describe("holdfast client", () => {
  it("decodes a CoinVault account", () => {
    const observations = Array.from({ length: 16 }, () => ({ ts: zero, price: zero }));
    const raw = {
      mint,
      token_program: PublicKey.default,
      bonding_curve: Keypair.generate().publicKey,
      amm_pool: PublicKey.default,
      trigger_bps: 2500,
      venue: 0,
      bump: 255,
      treasury_bump: 254,
      round_open: false,
      ath_price: new BN("27958993476234855"),
      floor_price: new BN("20969245107176141"),
      ath_candidate: zero,
      ath_candidate_since: zero,
      floor_sol: new BN(6_000_000_000),
      holder_sol: new BN(3_000_000_000),
      burn_sol: new BN(1_000_000_000),
      holder_tokens: new BN(42),
      last_defend_ts: new BN(1_760_000_000),
      defend_count: new BN(3),
      hour_window_start: zero,
      hour_window_defends: 0,
      round_id: new BN(9),
      last_round_ts: zero,
      obs_head: 0,
      obs_len: 0,
      observations,
      total_fees: new BN(10_000_000_000),
      total_defended_sol: zero,
      total_tokens_bought: zero,
      total_paid_sol: zero,
      total_paid_tokens: zero,
      total_burn_sol: zero,
      total_hold_burned: zero,
      created_at: new BN(1_759_999_000),
      total_treasury_rent: zero,
    };
    // anchor's encode() uses a fixed 1000-byte buffer; CoinVault is larger, so encode with the layout directly
    const { discriminator, layout } = (coder.accounts as unknown as { accountLayouts: Map<string, { discriminator: number[]; layout: { encode: (v: unknown, b: Buffer) => number } }> }).accountLayouts.get("CoinVault")!;
    const buf = Buffer.alloc(4096);
    const len = layout.encode(raw, buf);
    const data = Buffer.concat([Buffer.from(discriminator), buf.subarray(0, len)]);
    const v = decodeCoinVault(data);
    expect(v.mint.equals(mint)).toBe(true);
    expect(v.triggerBps).toBe(2500);
    expect(v.venue).toBe("curve");
    expect(v.ammPool).toBeNull();
    expect(v.floorSol).toBe(6_000_000_000n);
    expect(v.athPrice).toBe(27958993476234855n);
    expect(v.roundId).toBe(9n);
    expect(v.defendCount).toBe(3n);
  });

  it("parses events from program logs", () => {
    const line = encodeHoldfastEventLog("Defended", {
      mint,
      sol_spent: new BN(600_000_000),
      tokens_bought: new BN(123_456),
      spot_price: new BN(10),
      floor_price: new BN(20),
      venue: 0,
      ts: new BN(1_760_000_123),
    });
    const logs = [`Program ${HOLDFAST_PROGRAM_ID.toBase58()} invoke [1]`, "Program log: Instruction: Defend", line, `Program ${HOLDFAST_PROGRAM_ID.toBase58()} success`];
    const events = parseHoldfastEvents(logs);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.name).toBe("Defended");
    if (ev.name !== "Defended") throw new Error();
    expect(ev.solSpent).toBe(600_000_000n);
    expect(ev.tokensBought).toBe(123_456n);
    expect(ev.ts).toBe(1_760_000_123);
    expect(ev.venue).toBe(0);
    expect(ev.mint.equals(mint)).toBe(true);
  });

  it("ignores events of other programs", () => {
    const line = encodeHoldfastEventLog("FeesCollected", { mint, amount: new BN(1), floor: zero, holder: zero, burn: zero, unwrapped_wsol: zero, tokens: zero, ts: zero });
    const other = Keypair.generate().publicKey.toBase58();
    expect(parseHoldfastEvents([`Program ${other} invoke [1]`, line, `Program ${other} success`])).toEqual([]);
  });

  it("builds instructions in IDL account order", () => {
    const coin = coinKeys(mint);
    expect(coin.vault.equals(vaultPda(mint))).toBe(true);
    expect(coin.treasury.equals(treasuryPda(mint))).toBe(true);

    const init = initCoinIx(coin, keeper, 2500);
    expect(ixName(init.data)).toBe("init_coin");
    // vault + treasury reserve only: the treasury's token accounts come later (prepare_treasury)
    expect(init.keys).toHaveLength(8);
    expect(init.keys[0]!.isSigner).toBe(true);

    expect(ixName(collectFeesIx(coin).data)).toBe("collect_fees");
    // missing treasury token accounts are passed as "none" (the program id)
    const bare = collectFeesIx(coin, { tokenAccount: false, wsolAccount: false });
    expect(bare.keys.filter((k) => k.pubkey.equals(HOLDFAST_PROGRAM_ID))).toHaveLength(2);

    const prepare = prepareTreasuryIx(coin, "curve");
    expect(ixName(prepare.data)).toBe("prepare_treasury");
    expect(prepare.keys.some((k) => k.pubkey.equals(userVolumeAccumulatorPda(coin.treasury, "curve")) && k.isWritable)).toBe(true);
    const prepareAtas = prepareTreasuryIx(coin, null);
    expect(prepareAtas.keys.slice(-3).every((k) => k.pubkey.equals(HOLDFAST_PROGRAM_ID))).toBe(true);

    const ath = updateAthIx(coin, keeper, { priceAccount: coin.bondingCurve });
    expect(ath.keys).toHaveLength(6);
    // optional pool accounts default to the program id
    expect(ath.keys[4]!.pubkey.equals(HOLDFAST_PROGRAM_ID)).toBe(true);

    const venue = Array.from({ length: 18 }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: true }));
    const defend = defendIx(coin, keeper, { priceAccount: coin.bondingCurve }, venue, 5n);
    expect(defend.keys).toHaveLength(15 + 18);
    expect(defend.keys.slice(15).every((k) => !k.isSigner)).toBe(true);
    const decoded = coder.instruction.decode(defend.data)!;
    expect((decoded.data as { min_tokens_out: BN }).min_tokens_out.toString()).toBe("5");

    const open = openRoundIx(coin, keeper, 3n, 1_000n, 2_000n, new Uint8Array(32).fill(9), 4);
    expect(ixName(open.data)).toBe("open_round");

    const wallet = Keypair.generate().publicKey;
    const ta = Keypair.generate().publicKey;
    const pay = payoutIx(coin, keeper, 3n, [
      { index: 0, wallet, sol: 5n, tokens: 0n },
      { index: 1, wallet, sol: 0n, tokens: 7n, tokenAccount: ta },
    ]);
    expect(pay.keys).toHaveLength(9 + 3);
    // a SOL-only batch does not need the treasury token account (it may not exist yet)
    const solOnly = payoutIx(coin, keeper, 3n, [{ index: 0, wallet, sol: 5n, tokens: 0n }]);
    expect(solOnly.keys[6]!.pubkey.equals(HOLDFAST_PROGRAM_ID)).toBe(true);
    expect(pay.keys[6]!.pubkey.equals(coin.treasuryTokenAccount)).toBe(true);
    expect(() => payoutIx(coin, keeper, 3n, [{ index: 0, wallet, sol: 0n, tokens: 1n }])).toThrow();

    expect(ixName(closeRoundIx(coin, keeper, 3n).data)).toBe("close_round");
  });

  it("builds admin instructions", () => {
    const admin = Keypair.generate().publicKey;
    const init = initializeIx(admin, keeper, Keypair.generate().publicKey);
    expect(ixName(init.data)).toBe("initialize");
    expect(init.keys).toHaveLength(5);
    const decoded = coder.instruction.decode(setParamsIx(admin, { ...DEFAULT_PARAMS, defendCooldownSecs: 90 }).data)!;
    expect((decoded.data as { params: { defend_cooldown_secs: number } }).params.defend_cooldown_secs).toBe(90);
    expect(setHoldMintIx(admin, mint).keys).toHaveLength(3);
  });
});
