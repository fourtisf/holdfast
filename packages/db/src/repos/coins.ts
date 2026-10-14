import type { Socials, TriggerBps } from "@holdfast/core";
import type { Queryable } from "../db.js";
import { json, ms, msOrNull, num, numOrNull, ts } from "../sql.js";

export interface CoinRow {
  mint: string;
  name: string;
  ticker: string;
  imageUrl: string | null;
  description: string;
  socials: Socials;
  triggerBps: TriggerBps;
  creator: string | null;
  vault: string;
  treasury: string;
  bondingCurve: string;
  ammPool: string | null;
  tokenProgram: string;
  decimals: number;
  graduated: boolean;
  graduatedAt: number | null;
  launchSig: string | null;
  metadataUri: string | null;
  createdAt: number;
  lastPrice: number | null;
  lastTradeAt: number | null;
  /** Hidden by moderators: not listed, user content withheld (the coin itself lives on). */
  hidden: boolean;
  hiddenReason: string | null;
  needsReview: boolean;
}

export interface NewCoin {
  mint: string;
  name: string;
  ticker: string;
  imageUrl?: string | null;
  description?: string;
  socials?: Socials;
  triggerBps: TriggerBps;
  creator?: string | null;
  vault: string;
  treasury: string;
  bondingCurve: string;
  ammPool?: string | null;
  tokenProgram: string;
  decimals?: number;
  launchSig?: string | null;
  metadataUri?: string | null;
  createdAt?: number;
}

export const COIN_COLUMNS = `c.mint, c.name, c.ticker, c.image_url, c.description, c.socials, c.trigger_bps, c.creator, c.vault,
  c.treasury, c.bonding_curve, c.amm_pool, c.token_program, c.decimals, c.graduated, c.graduated_at, c.launch_sig,
  c.metadata_uri, c.created_at, c.last_price, c.last_trade_at, c.hidden, c.hidden_reason, c.needs_review`;

export function mapCoin(r: Record<string, unknown>): CoinRow {
  return {
    mint: r.mint as string,
    name: r.name as string,
    ticker: r.ticker as string,
    imageUrl: (r.image_url as string | null) ?? null,
    description: (r.description as string) ?? "",
    socials: (r.socials as Socials) ?? {},
    triggerBps: num(r.trigger_bps) as TriggerBps,
    creator: (r.creator as string | null) ?? null,
    vault: r.vault as string,
    treasury: r.treasury as string,
    bondingCurve: r.bonding_curve as string,
    ammPool: (r.amm_pool as string | null) ?? null,
    tokenProgram: r.token_program as string,
    decimals: num(r.decimals),
    graduated: Boolean(r.graduated),
    graduatedAt: msOrNull(r.graduated_at),
    launchSig: (r.launch_sig as string | null) ?? null,
    metadataUri: (r.metadata_uri as string | null) ?? null,
    createdAt: ms(r.created_at),
    lastPrice: numOrNull(r.last_price),
    lastTradeAt: msOrNull(r.last_trade_at),
    hidden: Boolean(r.hidden),
    hiddenReason: (r.hidden_reason as string | null) ?? null,
    needsReview: Boolean(r.needs_review),
  };
}

/** Insert a coin; returns false when it already exists (the existing row is left untouched). */
export async function insertCoin(q: Queryable, coin: NewCoin): Promise<boolean> {
  const res = await q.query(
    `INSERT INTO coins (mint, name, ticker, image_url, description, socials, trigger_bps, creator, vault, treasury,
       bonding_curve, amm_pool, token_program, decimals, launch_sig, metadata_uri, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, COALESCE($17, now()))
     ON CONFLICT (mint) DO NOTHING
     RETURNING mint`,
    [
      coin.mint,
      coin.name,
      coin.ticker,
      coin.imageUrl ?? null,
      coin.description ?? "",
      json(coin.socials ?? {}),
      coin.triggerBps,
      coin.creator ?? null,
      coin.vault,
      coin.treasury,
      coin.bondingCurve,
      coin.ammPool ?? null,
      coin.tokenProgram,
      coin.decimals ?? 6,
      coin.launchSig ?? null,
      coin.metadataUri ?? null,
      coin.createdAt === undefined ? null : ts(coin.createdAt),
    ],
  );
  return res.rows.length > 0;
}

export async function getCoin(q: Queryable, mint: string): Promise<CoinRow | null> {
  const res = await q.query(`SELECT ${COIN_COLUMNS} FROM coins c WHERE c.mint = $1`, [mint]);
  return res.rows[0] ? mapCoin(res.rows[0]) : null;
}

export async function getCoins(q: Queryable, mints: readonly string[]): Promise<Map<string, CoinRow>> {
  if (mints.length === 0) return new Map();
  const res = await q.query(`SELECT ${COIN_COLUMNS} FROM coins c WHERE c.mint = ANY($1::text[])`, [[...new Set(mints)]]);
  return new Map(res.rows.map((r) => [r.mint as string, mapCoin(r)]));
}

/** Coins whose bonding curve or PumpSwap pool is one of `addresses`. */
export async function findCoinsByVenue(q: Queryable, addresses: readonly string[]): Promise<CoinRow[]> {
  if (addresses.length === 0) return [];
  const res = await q.query(
    `SELECT ${COIN_COLUMNS} FROM coins c WHERE c.bonding_curve = ANY($1::text[]) OR c.amm_pool = ANY($1::text[])`,
    [[...new Set(addresses)]],
  );
  return res.rows.map(mapCoin);
}

export async function listCoins(q: Queryable): Promise<CoinRow[]> {
  const res = await q.query(`SELECT ${COIN_COLUMNS} FROM coins c ORDER BY c.created_at`);
  return res.rows.map(mapCoin);
}

export async function countCoins(q: Queryable): Promise<number> {
  const res = await q.query<{ n: string }>("SELECT count(*) AS n FROM coins");
  return num(res.rows[0]?.n);
}

export async function markGraduated(q: Queryable, mint: string, pool: string | null, atMs: number): Promise<void> {
  await q.query(
    `UPDATE coins SET graduated = true, amm_pool = COALESCE($2, amm_pool), graduated_at = COALESCE(graduated_at, $3)
     WHERE mint = $1`,
    [mint, pool, ts(atMs)],
  );
}

export async function setLaunchSig(q: Queryable, mint: string, sig: string): Promise<void> {
  await q.query("UPDATE coins SET launch_sig = COALESCE(launch_sig, $2) WHERE mint = $1", [mint, sig]);
}

export interface CoinMetadataPatch {
  name?: string;
  ticker?: string;
  imageUrl?: string | null;
  description?: string;
  socials?: Socials;
  creator?: string | null;
  metadataUri?: string | null;
}

/** Fill in launch-form details (launcher) without touching chain-derived columns. */
export async function updateCoinMetadata(q: Queryable, mint: string, patch: CoinMetadataPatch): Promise<void> {
  await q.query(
    `UPDATE coins SET
       name = COALESCE($2, name),
       ticker = COALESCE($3, ticker),
       image_url = CASE WHEN $4::boolean THEN $5 ELSE image_url END,
       description = COALESCE($6, description),
       socials = COALESCE($7::jsonb, socials),
       creator = COALESCE($8, creator),
       metadata_uri = COALESCE($9, metadata_uri)
     WHERE mint = $1`,
    [
      mint,
      patch.name ?? null,
      patch.ticker ?? null,
      patch.imageUrl !== undefined,
      patch.imageUrl ?? null,
      patch.description ?? null,
      patch.socials ? json(patch.socials) : null,
      patch.creator ?? null,
      patch.metadataUri ?? null,
    ],
  );
}

/** Record the spot price after a trade; older slots never overwrite newer ones. */
export async function updateLastPrice(q: Queryable, mint: string, price: number, atMs: number, slot: number): Promise<void> {
  await q.query(
    `UPDATE coins SET last_price = $2, last_trade_at = $3, last_trade_slot = $4
     WHERE mint = $1 AND last_trade_slot <= $4`,
    [mint, price, ts(atMs), slot],
  );
}
