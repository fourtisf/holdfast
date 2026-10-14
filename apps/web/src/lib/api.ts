import type {
  CandleTimeframe,
  CandlesResponse,
  CoinDetail,
  CoinSort,
  CoinSummary,
  DefendEvent,
  Holder,
  LaunchRequest,
  LaunchResponse,
  LaunchQuote,
  LaunchStatus,
  Page,
  Position,
  Profile,
  ReportRequest,
  ReportResponse,
  RoundSnapshot,
  RoundSummary,
  Schedule,
  Stats,
  Trade,
  TradeBuildResponse,
  TradeQuote,
  TradeQuoteRequest,
} from "@holdfast/core";
import { API_URL, USE_MOCKS } from "./config";

export interface CoinsQuery {
  sort?: CoinSort;
  q?: string;
  limit?: number;
  cursor?: string | null;
}

export interface HoldfastApi {
  stats(): Promise<Stats>;
  schedule(): Promise<Schedule>;
  coins(query?: CoinsQuery): Promise<Page<CoinSummary>>;
  coin(mint: string): Promise<CoinDetail>;
  candles(mint: string, tf: CandleTimeframe, range?: { from?: number; to?: number }): Promise<CandlesResponse>;
  trades(mint: string, opts?: { limit?: number; before?: string | null }): Promise<Page<Trade>>;
  holders(mint: string, opts?: { limit?: number }): Promise<Holder[]>;
  defends(mint: string, opts?: { limit?: number }): Promise<DefendEvent[]>;
  rounds(mint: string, opts?: { limit?: number }): Promise<RoundSummary[]>;
  round(mint: string, roundId: number): Promise<RoundSnapshot>;
  profile(wallet: string): Promise<Profile>;
  position(wallet: string, mint: string): Promise<Position | null>;
  quote(req: TradeQuoteRequest, signal?: AbortSignal): Promise<TradeQuote>;
  buildTrade(req: TradeQuoteRequest): Promise<TradeBuildResponse>;
  uploadImage(file: File): Promise<{ imageUrl: string }>;
  launch(req: LaunchRequest): Promise<LaunchResponse>;
  launchStatus(launchId: string): Promise<LaunchStatus>;
  /** Deposit needed for a launch, from the launcher's cost model. */
  launchQuote(q?: { devBuySol?: number; name?: string; ticker?: string }): Promise<LaunchQuote>;
  report(mint: string, req: ReportRequest): Promise<ReportResponse>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type QueryValue = string | number | null | undefined;

function withQuery(path: string, query: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...rest,
      headers: { Accept: "application/json", ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError("Network error: the Holdfast API is unreachable.", 0);
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const httpApi: HoldfastApi = {
  stats: () => request("/stats"),
  schedule: () => request("/schedule"),
  coins: (q = {}) => request(withQuery("/coins", { sort: q.sort, q: q.q, limit: q.limit, cursor: q.cursor })),
  coin: (mint) => request(`/coins/${enc(mint)}`),
  candles: (mint, tf, range = {}) => request(withQuery(`/coins/${enc(mint)}/candles`, { tf, from: range.from, to: range.to })),
  trades: (mint, opts = {}) => request(withQuery(`/coins/${enc(mint)}/trades`, { limit: opts.limit, before: opts.before })),
  holders: (mint, opts = {}) => request(withQuery(`/coins/${enc(mint)}/holders`, { limit: opts.limit })),
  defends: (mint, opts = {}) => request(withQuery(`/coins/${enc(mint)}/defends`, { limit: opts.limit })),
  rounds: (mint, opts = {}) => request(withQuery(`/coins/${enc(mint)}/rounds`, { limit: opts.limit })),
  round: (mint, roundId) => request(`/coins/${enc(mint)}/rounds/${roundId}`),
  profile: (wallet) => request(withQuery("/me", { wallet })),
  position: (wallet, mint) => request(withQuery("/me/position", { wallet, mint })),
  quote: (req, signal) => request("/trade/quote", { method: "POST", json: req, signal }),
  buildTrade: (req) => request("/trade/build", { method: "POST", json: req }),
  uploadImage: (file) => {
    const form = new FormData();
    form.append("file", file);
    return request("/uploads/image", { method: "POST", body: form });
  },
  launch: (req) => request("/launch", { method: "POST", json: req }),
  launchStatus: (launchId) => request(`/launch/${enc(launchId)}`),
  launchQuote: (q = {}) => request(withQuery("/launch/quote", { devBuySol: q.devBuySol, name: q.name, ticker: q.ticker })),
  report: (mint, req) => request(`/coins/${enc(mint)}/report`, { method: "POST", json: req }),
};

let mockApi: Promise<HoldfastApi> | null = null;

function impl(): Promise<HoldfastApi> {
  if (!USE_MOCKS) return Promise.resolve(httpApi);
  mockApi ??= import("./mocks/api").then((m) => m.mockApi);
  return mockApi;
}

function lazy<K extends keyof HoldfastApi>(key: K): HoldfastApi[K] {
  const call = async (...args: unknown[]) => {
    const target = await impl();
    return (target[key] as (...a: unknown[]) => unknown)(...args);
  };
  return call as HoldfastApi[K];
}

/** Typed client for every endpoint in docs/api.md. Mock mode (`NEXT_PUBLIC_USE_MOCKS=1`) swaps in generated data. */
export const api: HoldfastApi = {
  stats: lazy("stats"),
  schedule: lazy("schedule"),
  coins: lazy("coins"),
  coin: lazy("coin"),
  candles: lazy("candles"),
  trades: lazy("trades"),
  holders: lazy("holders"),
  defends: lazy("defends"),
  rounds: lazy("rounds"),
  round: lazy("round"),
  profile: lazy("profile"),
  position: lazy("position"),
  quote: lazy("quote"),
  buildTrade: lazy("buildTrade"),
  uploadImage: lazy("uploadImage"),
  launch: lazy("launch"),
  launchStatus: lazy("launchStatus"),
  launchQuote: lazy("launchQuote"),
  report: lazy("report"),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}
