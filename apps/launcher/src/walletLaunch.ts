import type { LaunchRequest } from "@holdfast/core";

import { ValidationError } from "./metadata.js";
import type { Logger, LaunchWorker } from "./worker.js";

/**
 * Body of POST /wallet-launch on the launcher's ops port: `{ wallet, ...LaunchRequest }` (already
 * validated and moderated by the API). 200 with the co-signed transaction, 422 when the launch itself
 * is not acceptable (the message is shown to the user), 500 otherwise.
 */
export function walletLaunchHandler(worker: Pick<LaunchWorker, "prepareWalletLaunch">, log: Pick<Logger, "warn">) {
  return async (body: unknown): Promise<{ status: number; body: unknown }> => {
    if (!body || typeof body !== "object") return { status: 400, body: { error: "expected a launch" } };
    const { wallet, ...form } = body as { wallet?: unknown } & Record<string, unknown>;
    if (typeof wallet !== "string") return { status: 400, body: { error: "wallet is required" } };
    try {
      return { status: 200, body: await worker.prepareWalletLaunch(form as unknown as LaunchRequest, wallet) };
    } catch (err) {
      if (err instanceof ValidationError) return { status: 422, body: { error: err.message } };
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "wallet launch could not be prepared");
      throw err;
    }
  };
}
