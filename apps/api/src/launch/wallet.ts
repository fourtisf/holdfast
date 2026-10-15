import type { LaunchRequest, WalletLaunchPrepared } from "@holdfast/core";
import { HttpError } from "../errors.js";

/** Builds a wallet-signed launch transaction (the launcher holds the keys that co-sign it). */
export interface WalletLauncher {
  prepare(req: LaunchRequest, wallet: string): Promise<WalletLaunchPrepared>;
}

/**
 * The launcher's internal POST /wallet-launch (its ops port, LAUNCHER_INTERNAL_URL). Its 4xx
 * messages describe the launch and are passed on to the user; anything else is "unavailable".
 */
export class HttpWalletLauncher implements WalletLauncher {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async prepare(req: LaunchRequest, wallet: string): Promise<WalletLaunchPrepared> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl.replace(/\/+$/, "")}/wallet-launch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...req, wallet }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new HttpError(503, "The launcher is unavailable, try again in a moment");
    }
    const body = (await res.json().catch(() => null)) as (WalletLaunchPrepared & { error?: string }) | null;
    if (res.ok && body?.transaction) return body;
    if (res.status >= 400 && res.status < 500) throw new HttpError(422, body?.error ?? "This launch cannot be prepared");
    throw new HttpError(503, "The launcher could not prepare the launch, try again in a moment");
  }
}
