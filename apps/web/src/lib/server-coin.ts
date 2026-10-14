import type { CoinDetail } from "@holdfast/core";
import { API_URL, USE_MOCKS } from "./config";

/** Coin detail for link previews (metadata, OG images), fetched on the server. Null on any error. */
export async function fetchCoinForPreview(mint: string): Promise<CoinDetail | null> {
  try {
    if (USE_MOCKS) {
      const market = await import("./mocks/market");
      return market.coinDetail(mint);
    }
    // Inside docker the browser-facing API URL may not resolve from the web container.
    const base = (process.env.API_INTERNAL_URL || API_URL).replace(/\/$/, "");
    const res = await fetch(`${base}/coins/${encodeURIComponent(mint)}`, { next: { revalidate: 60 }, signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return null;
    const coin = (await res.json()) as CoinDetail;
    return coin.hidden ? null : coin;
  } catch {
    return null;
  }
}
