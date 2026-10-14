/**
 * SOL/USD for the UI's USD toggle. Display only: nothing on-chain or in the payout math uses it.
 * Pyth's Hermes REST endpoint first, CoinGecko as the fallback; the value is cached and refreshed
 * in the background, and reported as unknown (null) once it is older than `maxAgeMs`.
 */

export const PYTH_SOL_USD_FEED_ID = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

export interface SolPriceSource {
  /** Latest SOL price in USD, null while unknown or stale. */
  solUsd(): number | null;
}

export const NO_PRICE: SolPriceSource = { solUsd: () => null };

type FetchFn = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface SolUsdFeedOptions {
  fetch?: FetchFn;
  hermesUrl?: string;
  coingeckoUrl?: string | null;
  refreshMs?: number;
  maxAgeMs?: number;
  timeoutMs?: number;
  now?: () => number;
  log?: { warn(obj: unknown, msg?: string): void };
}

/** Hermes `/v2/updates/price/latest` → USD. */
export function parseHermes(body: unknown): number | null {
  const parsed = (body as { parsed?: { price?: { price?: string | number; expo?: number } }[] } | null)?.parsed;
  const p = parsed?.[0]?.price;
  if (!p || p.price === undefined || typeof p.expo !== "number") return null;
  const v = Number(p.price) * 10 ** p.expo;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** CoinGecko `/simple/price?ids=solana&vs_currencies=usd` → USD. */
export function parseCoingecko(body: unknown): number | null {
  const v = Number((body as { solana?: { usd?: number } } | null)?.solana?.usd);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export class SolUsdFeed implements SolPriceSource {
  private value: number | null = null;
  private at = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly fetchFn: FetchFn;
  private readonly hermesUrl: string;
  private readonly coingeckoUrl: string | null;
  private readonly now: () => number;

  constructor(private readonly opts: SolUsdFeedOptions = {}) {
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchFn);
    const hermes = (opts.hermesUrl ?? "https://hermes.pyth.network").replace(/\/+$/, "");
    this.hermesUrl = `${hermes}/v2/updates/price/latest?ids[]=${PYTH_SOL_USD_FEED_ID}`;
    this.coingeckoUrl = opts.coingeckoUrl === undefined ? "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd" : opts.coingeckoUrl;
    this.now = opts.now ?? Date.now;
  }

  solUsd(): number | null {
    if (this.value === null) return null;
    return this.now() - this.at <= (this.opts.maxAgeMs ?? 10 * 60_000) ? this.value : null;
  }

  private async get(url: string, parse: (b: unknown) => number | null): Promise<number | null> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 5_000);
    try {
      const res = await this.fetchFn(url, { signal: ctl.signal, headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parse(await res.json());
    } finally {
      clearTimeout(t);
    }
  }

  /** One refresh: Hermes, then CoinGecko. Keeps the old value when both fail. */
  async refresh(): Promise<number | null> {
    const sources: [string, string, (b: unknown) => number | null][] = [["pyth", this.hermesUrl, parseHermes]];
    if (this.coingeckoUrl) sources.push(["coingecko", this.coingeckoUrl, parseCoingecko]);
    for (const [name, url, parse] of sources) {
      try {
        const v = await this.get(url, parse);
        if (v !== null) {
          this.value = v;
          this.at = this.now();
          return v;
        }
      } catch (err) {
        this.opts.log?.warn({ err, source: name }, "SOL/USD price fetch failed");
      }
    }
    return null;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.refreshMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
