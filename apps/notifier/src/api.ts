/**
 * The bot reads and launches through the public API (the same numbers and rules as the website):
 * launch quotes, deposit launches, image uploads, coin cards, trending coins and $MOATPAD burns.
 */
import type { BurnStats, CoinDetail, CoinSummary, LaunchQuote, LaunchRequest, LaunchResponse, Page } from "@holdfast/core";

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

export interface MoatpadApi {
  quote(devBuySol: number): Promise<LaunchQuote>;
  createLaunch(req: LaunchRequest): Promise<LaunchResponse>;
  /** Returns the hosted image URL to put in the launch form. */
  uploadImage(bytes: Uint8Array, filename: string): Promise<string>;
  /** Null when no Moatpad coin has this mint. */
  coin(mint: string): Promise<CoinDetail | null>;
  trending(limit: number): Promise<CoinSummary[]>;
  burns(): Promise<BurnStats>;
}

type Fetch = typeof fetch;

export class HttpMoatpadApi implements MoatpadApi {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: Fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchFn(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
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

  quote(devBuySol: number): Promise<LaunchQuote> {
    return this.request(`/launch/quote?devBuySol=${encodeURIComponent(String(devBuySol))}`);
  }

  createLaunch(req: LaunchRequest): Promise<LaunchResponse> {
    return this.request("/launch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
  }

  async uploadImage(bytes: Uint8Array, filename: string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([bytes]), filename);
    const res = await this.request<{ imageUrl: string }>("/uploads/image", { method: "POST", body: form });
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
