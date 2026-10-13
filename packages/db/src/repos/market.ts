import type { CoinSort } from "@holdfast/core";
import type { Queryable } from "../db.js";
import { big, likeEscape, msOrNull, num, numOrNull, ts } from "../sql.js";
import { COIN_COLUMNS, mapCoin, type CoinRow } from "./coins.js";
import { mapVaultState, type VaultStateRow } from "./vault.js";

/** Everything the coin list / coin header needs, aggregated in SQL. */
export interface CoinMetrics {
  coin: CoinRow;
  vault: VaultStateRow | null;
  /** Spot price after the newest trade (SOL per whole token), 0 before the first trade. */
  price: number;
  /** Newest trade's execution price, the basis of the 24h change. */
  lastTradePrice: number | null;
  /** Trade price 24h ago (or the first trade, for younger coins). */
  price24hAgo: number | null;
  volume24h: bigint;
  volume1h: bigint;
  trades1h: number;
  holders: number;
  /** Lifetime SOL / tokens paid to holders: on-chain total, or confirmed payouts if larger (mirror lag). */
  paidOutSol: bigint;
  paidOutTokens: bigint;
  defendedSol: bigint;
  defendCount: number;
  lastDefendAt: number | null;
}

export interface ListCoinsOptions {
  /** `vault_buying` also filters to coins priced at or below their floor. */
  sort: CoinSort;
  search?: string | null;
  limit: number;
  /** Offset pagination (all sorts but `newest`). */
  offset?: number;
  /** Keyset pagination for `newest`: the last coin of the previous page. */
  after?: { createdAt: number; mint: string } | null;
  now: number;
}

const FLOOR_PRICE = "(COALESCE(v.floor, 0)::float8 * power(10::float8, c.decimals) / 1e27)";

const METRICS_SELECT = `
  SELECT ${COIN_COLUMNS}, v.mint AS v_mint, v.floor_sol, v.holder_sol, v.burn_sol, v.holder_tokens, v.ath, v.floor, v.defend_count,
    v.last_defend_ts, v.round_id, v.total_fees, v.total_defended, v.total_paid_sol, v.total_paid_tokens, v.total_burned_sol,
    v.slot, v.updated_at,
    COALESCE(c.last_price, lt.price, 0) AS m_price,
    lt.price AS m_last_trade_price,
    COALESCE(p24.price, ft.price) AS m_price_24h,
    COALESCE(tv.vol24, 0) AS m_vol24, COALESCE(tv.vol1h, 0) AS m_vol1h, COALESCE(tv.trades1h, 0) AS m_trades1h,
    h.holders AS m_holders,
    GREATEST(COALESCE(v.total_paid_sol, 0), pp.paid_sol) AS m_paid_sol,
    GREATEST(COALESCE(v.total_paid_tokens, 0), pp.paid_tokens) AS m_paid_tokens,
    GREATEST(COALESCE(v.total_defended, 0), dd.defended) AS m_defended,
    GREATEST(COALESCE(v.defend_count, 0), dd.defends) AS m_defends,
    COALESCE(dd.last_defend, v.last_defend_ts) AS m_last_defend,
    ${FLOOR_PRICE} AS m_floor_price
  FROM coins c
  LEFT JOIN vault_state v ON v.mint = c.mint
  LEFT JOIN LATERAL (SELECT price FROM trades t WHERE t.mint = c.mint ORDER BY ts DESC, slot DESC, ix_index DESC LIMIT 1) lt ON true
  LEFT JOIN LATERAL (SELECT price FROM trades t WHERE t.mint = c.mint AND t.ts <= $1::timestamptz - interval '24 hours'
                     ORDER BY ts DESC, slot DESC, ix_index DESC LIMIT 1) p24 ON true
  LEFT JOIN LATERAL (SELECT price FROM trades t WHERE t.mint = c.mint ORDER BY ts ASC, slot ASC, ix_index ASC LIMIT 1) ft ON true
  LEFT JOIN LATERAL (SELECT sum(sol) AS vol24,
                            sum(sol) FILTER (WHERE ts > $1::timestamptz - interval '1 hour') AS vol1h,
                            count(*) FILTER (WHERE ts > $1::timestamptz - interval '1 hour') AS trades1h
                     FROM trades t WHERE t.mint = c.mint AND t.ts > $1::timestamptz - interval '24 hours') tv ON true
  LEFT JOIN LATERAL (SELECT count(*) AS holders FROM wallet_balances wb
                     WHERE wb.mint = c.mint AND wb.balance > 0
                       AND NOT EXISTS (SELECT 1 FROM excluded_wallets e WHERE e.address = wb.wallet)) h ON true
  LEFT JOIN LATERAL (SELECT COALESCE(sum(sol), 0) AS paid_sol, COALESCE(sum(tokens), 0) AS paid_tokens
                     FROM payouts p WHERE p.mint = c.mint AND p.status = 'confirmed') pp ON true
  LEFT JOIN LATERAL (SELECT COALESCE(sum(sol_spent), 0) AS defended, count(*) AS defends, max(ts) AS last_defend
                     FROM defends d WHERE d.mint = c.mint) dd ON true`;

const SORT_ORDER: Record<CoinSort, string> = {
  newest: "created_at DESC, mint DESC",
  // 1h activity: SOL volume plus 0.1 SOL per trade, so many small trades also trend.
  trending: "(m_vol1h::float8 / 1e9 + 0.1 * m_trades1h) DESC, m_vol24 DESC, created_at DESC, mint DESC",
  // A filter (see SORT_FILTER): coins at/below their floor, most recent defend first.
  vault_buying: "m_last_defend DESC NULLS LAST, created_at DESC, mint DESC",
  top_payouts: "m_paid_sol DESC, created_at DESC, mint DESC",
  biggest_vault: "COALESCE(floor_sol, 0) DESC, created_at DESC, mint DESC",
};

/** Sorts that also filter the list. */
const SORT_FILTER: Partial<Record<CoinSort, string>> = {
  vault_buying: "m_floor_price > 0 AND m_price > 0 AND m_price <= m_floor_price",
};

function mapMetrics(r: Record<string, unknown>): CoinMetrics {
  return {
    coin: mapCoin(r),
    vault: r.v_mint ? mapVaultState({ ...r, mint: r.v_mint }) : null,
    price: num(r.m_price),
    lastTradePrice: numOrNull(r.m_last_trade_price),
    price24hAgo: numOrNull(r.m_price_24h),
    volume24h: big(r.m_vol24),
    volume1h: big(r.m_vol1h),
    trades1h: num(r.m_trades1h),
    holders: num(r.m_holders),
    paidOutSol: big(r.m_paid_sol),
    paidOutTokens: big(r.m_paid_tokens),
    defendedSol: big(r.m_defended),
    defendCount: num(r.m_defends),
    lastDefendAt: msOrNull(r.m_last_defend),
  };
}

function searchClause(search: string, params: unknown[]): string {
  const term = search.trim().replace(/^\$/, "").toLowerCase();
  params.push(`%${likeEscape(term)}%`, search.trim());
  const like = `$${params.length - 1}`;
  const exact = `$${params.length}`;
  return `(lower(c.name) LIKE ${like} ESCAPE '\\' OR lower(c.ticker) LIKE ${like} ESCAPE '\\' OR c.mint = ${exact})`;
}

export async function listCoinMetrics(q: Queryable, opts: ListCoinsOptions): Promise<CoinMetrics[]> {
  const params: unknown[] = [ts(opts.now)];
  const where: string[] = [];
  if (opts.search && opts.search.trim()) where.push(searchClause(opts.search, params));
  if (opts.sort === "newest" && opts.after) {
    params.push(ts(opts.after.createdAt), opts.after.mint);
    where.push(`(c.created_at, c.mint) < ($${params.length - 1}, $${params.length})`);
  }
  params.push(opts.limit, opts.sort === "newest" ? 0 : (opts.offset ?? 0));
  const filter = SORT_FILTER[opts.sort];
  const sql = `SELECT * FROM (${METRICS_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}) m
    ${filter ? `WHERE ${filter}` : ""}
    ORDER BY ${SORT_ORDER[opts.sort]} LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const res = await q.query(sql, params);
  return res.rows.map(mapMetrics);
}

export async function getCoinMetrics(q: Queryable, mint: string, now: number): Promise<CoinMetrics | null> {
  const res = await q.query(`${METRICS_SELECT} WHERE c.mint = $2`, [ts(now), mint]);
  return res.rows[0] ? mapMetrics(res.rows[0]) : null;
}

export interface GlobalStats {
  coins: number;
  /** Σ floor_sol, lamports. */
  totalVaultSol: bigint;
  totalPaidSol: bigint;
  defends24h: number;
  volume24h: bigint;
}

export async function getGlobalStats(q: Queryable, now: number): Promise<GlobalStats> {
  const res = await q.query(
    `SELECT
       (SELECT count(*) FROM coins) AS coins,
       (SELECT COALESCE(sum(floor_sol), 0) FROM vault_state) AS vault_sol,
       (SELECT COALESCE(sum(GREATEST(COALESCE(v.total_paid_sol, 0), COALESCE(p.paid, 0))), 0)
          FROM coins c
          LEFT JOIN vault_state v ON v.mint = c.mint
          LEFT JOIN (SELECT mint, sum(sol) AS paid FROM payouts WHERE status = 'confirmed' GROUP BY mint) p ON p.mint = c.mint) AS paid_sol,
       (SELECT count(*) FROM defends WHERE ts > $1::timestamptz - interval '24 hours') AS defends24h,
       (SELECT COALESCE(sum(sol), 0) FROM trades WHERE ts > $1::timestamptz - interval '24 hours') AS volume24h`,
    [ts(now)],
  );
  const r = res.rows[0] ?? {};
  return {
    coins: num(r.coins),
    totalVaultSol: big(r.vault_sol),
    totalPaidSol: big(r.paid_sol),
    defends24h: num(r.defends24h),
    volume24h: big(r.volume24h),
  };
}
