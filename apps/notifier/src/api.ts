/**
 * The bot reads and launches through the public API (the same numbers and rules as the website):
 * launch quotes, deposit launches, image uploads, coin cards, trending coins and $MOATPAD burns.
 * With INTERNAL_API_TOKEN, calls made for a Telegram user carry the token and the user's id, so the
 * API rate limits them per user rather than per notifier IP.
 */
import {
  INTERNAL_TOKEN_HEADER,
  TELEGRAM_USER_HEADER,
  type BurnStats,
  type CoinDetail,
  type CoinSummary,
  type LaunchQuote,
  type LaunchRequest,
  type LaunchResponse,
  type Page,
} from "@holdfast/core";

/** The API refused a request; `message` is its human-readable reason. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** What a quote is for: the cost depends on the name and ticker too (their length sets the mint account's rent). */
export interface QuoteRequest {
  devBuySol: number;
  name?: string;
  ticker?: string;
}

/** `userId`: the Telegram user a launch call is made for (the API's rate-limit key with INTERNAL_API_TOKEN). */
export interface MoatpadApi {
  quote(req: QuoteRequest, userId?: number): Promise<LaunchQuote>;
  createLaunch(req: LaunchRequest, userId?: number): Promise<LaunchResponse>;
  /** Returns the hosted image URL to put in the launch form. */
  uploadImage(bytes: Uint8Array, filename: string, userId?: number): Promise<string>;
  /** Null when no Moatpad coin has this mint. */
  coin(mint: string): Promise<CoinDetail | null>;
  trending(limit: number): Promise<CoinSummary[]>;
  burns(): Promise<BurnStats>;
}

type Fetch = typeof fetch;

export interface HttpMoatpadApiOptions {
  fetch?: Fetch;
  timeoutMs?: number;
  /** INTERNAL_API_TOKEN (null: calls are rate limited per notifier IP, like any client). */
  internalToken?: string | null;
}

export class HttpMoatpadApi implements MoatpadApi {
  private readonly base: string;
  private readonly fetchFn: Fetch;
  private readonly timeoutMs: number;
  private readonly internalToken: string | null;

  constructor(baseUrl: string, opts: HttpMoatpadApiOptions = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.internalToken = opts.internalToken ?? null;
  }

  private async request<T>(path: string, init: RequestInit = {}, userId?: number): Promise<T> {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (this.internalToken && userId !== undefined) {
      headers[INTERNAL_TOKEN_HEADER] = this.internalToken;
      headers[TELEGRAM_USER_HEADER] = String(userId);
    }
    const res = await this.fetchFn(`${this.base}${path}`, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    if (!res.ok) {
      const message = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `HTTP ${res.status}`;
      throw new ApiError(res.status, message);
    }
    return body as T;
  }

  quote(req: QuoteRequest, userId?: number): Promise<LaunchQuote> {
    const params = [`devBuySol=${encodeURIComponent(String(req.devBuySol))}`];
    if (req.name) params.push(`name=${encodeURIComponent(req.name)}`);
    if (req.ticker) params.push(`ticker=${encodeURIComponent(req.ticker)}`);
    return this.request(`/launch/quote?${params.join("&")}`, {}, userId);
  }

  createLaunch(req: LaunchRequest, userId?: number): Promise<LaunchResponse> {
    return this.request("/launch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) }, userId);
  }

  async uploadImage(bytes: Uint8Array, filename: string, userId?: number): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([bytes]), filename);
    const res = await this.request<{ imageUrl: string }>("/uploads/image", { method: "POST", body: form }, userId);
    return res.imageUrl;
  }

  async coin(mint: string): Promise<CoinDetail | null> {
    try {
      return await this.request<CoinDetail>(`/coins/${encodeURIComponent(mint)}`);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    }
  }

  async trending(limit: number): Promise<CoinSummary[]> {
    const page = await this.request<Page<CoinSummary>>(`/coins?sort=trending&limit=${limit}`);
    return page.items;
  }

  burns(): Promise<BurnStats> {
    return this.request("/burns");
  }
}
