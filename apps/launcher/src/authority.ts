import type { PublicKey } from "@solana/web3.js";
import { configPda, decodeConfig } from "@holdfast/chain";

import type { LaunchChain } from "./chain.js";

/** init_coin requires `launcher == Config.launcher`: refuse to start with the wrong hot wallet. */
export async function verifyLauncherAuthority(chain: LaunchChain, launcher: PublicKey): Promise<{ ok: true } | { ok: false; reason: string }> {
  const info = await chain.getAccountInfo(configPda());
  if (!info) return { ok: false, reason: `Holdfast Config ${configPda().toBase58()} not found (program not initialized on this cluster?)` };
  let config: ReturnType<typeof decodeConfig>;
  try {
    config = decodeConfig(info.data);
  } catch (err) {
    return { ok: false, reason: `Holdfast Config could not be decoded: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!config.launcher.equals(launcher)) {
    return { ok: false, reason: `LAUNCHER_KEYPAIR is ${launcher.toBase58()} but Config.launcher is ${config.launcher.toBase58()}` };
  }
  return { ok: true };
}
