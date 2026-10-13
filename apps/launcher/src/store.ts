/**
 * The few queries the launcher needs that @holdfast/db does not offer (yet). Kept tiny and local;
 * the proposed repo additions are in the launcher's hand-off notes.
 */
import type { LaunchStatusKind } from "@holdfast/core";
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

export const TERMINAL_LAUNCH_STATUSES: readonly LaunchStatusKind[] = ["live", "refunded", "expired", "failed"];

/** Finished launches touched (or expiring) after `sinceMs`: watched for late / leftover deposits. */
export async function listRecentTerminalLaunches(q: Queryable, sinceMs: number, limit: number): Promise<LaunchRow[]> {
  const res = await q.query<{ id: string }>(
    `SELECT id FROM launches WHERE status = ANY($1::text[]) AND (updated_at > $2 OR expires_at > $2)
     ORDER BY updated_at DESC LIMIT $3`,
    [[...TERMINAL_LAUNCH_STATUSES], new Date(sinceMs), limit],
  );
  const rows: LaunchRow[] = [];
  for (const { id } of res.rows) {
    const row = await getLaunch(q, id);
    if (row) rows.push(row);
  }
  return rows;
}
