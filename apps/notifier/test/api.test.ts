import { describe, expect, it } from "vitest";
import { INTERNAL_TOKEN_HEADER, TELEGRAM_USER_HEADER } from "@holdfast/core";

import { ApiError, HttpMoatpadApi } from "../src/api.js";

const TOKEN = "f".repeat(64);

/** Records each request's URL and headers; answers `body` with `status`. */
function recorder(status = 200, body: unknown = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const LAUNCH = { name: "Dog", ticker: "DOG", triggerBps: 2500 as const };

describe("HttpMoatpadApi", () => {
  it("sends INTERNAL_API_TOKEN and the Telegram user with the launch calls made for a user", async () => {
    const { fetch, calls } = recorder(200, { imageUrl: "https://x/y.png", items: [] });
    const api = new HttpMoatpadApi("http://api:4000/", { fetch, internalToken: TOKEN });
    await api.createLaunch(LAUNCH, 7);
    await api.uploadImage(new Uint8Array(3), "a.png", 7);
    await api.quote(0.5, 7);
    await api.trending(5);
    expect(calls.map((c) => c.url)).toEqual(["http://api:4000/launch", "http://api:4000/uploads/image", "http://api:4000/launch/quote?devBuySol=0.5", "http://api:4000/coins?sort=trending&limit=5"]);
    for (const c of calls.slice(0, 3)) expect(c.headers).toMatchObject({ [INTERNAL_TOKEN_HEADER]: TOKEN, [TELEGRAM_USER_HEADER]: "7" });
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[3]!.headers).toEqual({});
  });

  it("sends neither header without a token, and reports API refusals", async () => {
    const { fetch, calls } = recorder(429, { error: "Rate limit exceeded, retry in 1 minute" });
    const api = new HttpMoatpadApi("http://api:4000", { fetch });
    const err = await api.createLaunch(LAUNCH, 7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, message: "Rate limit exceeded, retry in 1 minute" });
    expect(Object.keys(calls[0]!.headers)).toEqual(["content-type"]);
  });
});
