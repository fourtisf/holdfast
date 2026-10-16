/**
 * The few queries the launcher needs that @holdfast/db does not offer (yet). Kept tiny and local;
 * the proposed repo additions are in the launcher's hand-off notes.
 */
import { getLaunch, type LaunchRow, type Queryable } from "@holdfast/db";

/** Store the encrypted mint keypair only if none is stored yet, so a launch can never get two mints. */
export async function setMintSecretOnce(q: Queryable, id: string, mintSecret: string): Promise<LaunchRow | null> {
  await q.query("UPDATE launches SET mint_secret = $2, updated_at = now() WHERE id = $1 AND mint_secret IS NULL", [id, mintSecret]);
  return getLaunch(q, id);
}

/**
 * Point `coins.launch_sig` at the dev-buy transaction. `setLaunchSig` keeps the first value written
 * (the indexer writes the init_coin tx when it registers the coin), but the indexer only skips lots
 * for the transaction recorded here, so it must be tx C, written before tx C is broadcast.
 */
export async function forceLaunchSig(q: Queryable, mint: string, sig: string): Promise<void> {
  await q.query("UPDATE coins SET launch_sig = $2 WHERE mint = $1", [mint, sig]);
}
