import { Keypair, PublicKey } from "@solana/web3.js";
import { configPda, HOLDFAST_PROGRAM_ID } from "@holdfast/chain";
import { describe, expect, it } from "vitest";

import { verifyLauncherAuthority } from "../src/authority.js";
import { FakeChain, holdfastCoder } from "./fakeChain.js";

async function chainWithConfig(launcher: PublicKey | null): Promise<FakeChain> {
  const chain = new FakeChain({ now: Date.now, configLauncher: launcher ?? PublicKey.default });
  if (!launcher) return chain;
  const data = await holdfastCoder.accounts.encode("Config", {
    admin: Keypair.generate().publicKey,
    pending_admin: PublicKey.default,
    keeper: Keypair.generate().publicKey,
    launcher,
    hold_mint: PublicKey.default,
    params: {
      defend_cooldown_secs: 60,
      max_defends_per_hour: 10,
      defend_price_tolerance_bps: 200,
      twap_window_secs: 600,
      twap_min_sample_interval_secs: 30,
      twap_max_gap_secs: 120,
      ath_confirm_secs: 300,
      max_burn_slippage_bps: 500,
      min_round_interval_secs: 120,
    },
    paused: false,
    bump: 255,
    reserved: Array(64).fill(0),
  });
  chain.put(configPda(), { lamports: 10_000_000n, owner: HOLDFAST_PROGRAM_ID, data });
  return chain;
}

describe("verifyLauncherAuthority", () => {
  it("accepts the wallet stored in Config.launcher and refuses any other", async () => {
    const launcher = Keypair.generate().publicKey;
    const chain = await chainWithConfig(launcher);
    expect(await verifyLauncherAuthority(chain, launcher)).toEqual({ ok: true });
    const other = await verifyLauncherAuthority(chain, Keypair.generate().publicKey);
    expect(other).toMatchObject({ ok: false, reason: expect.stringContaining(launcher.toBase58()) });
  });

  it("reports a cluster where the program was never initialized", async () => {
    const res = await verifyLauncherAuthority(await chainWithConfig(null), Keypair.generate().publicKey);
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining("not found") });
  });
});
