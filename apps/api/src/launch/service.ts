import { randomUUID } from "node:crypto";
import type { LaunchRequest, LaunchResponse, LaunchStatus } from "@holdfast/core";
import { addExcluded, getLaunch, insertLaunch, nextDepositIndex, type Db } from "@holdfast/db";
import { lamportsToSol, lamportsToSolString, solToLamports } from "../format.js";
import { launchCost, type LaunchCostSettings } from "./cost.js";
import { toLaunchStatus } from "../present.js";
import type { DepositAllocator } from "./deposit.js";

/**
 * POST /launch and GET /launch/:id delegate here. The launcher service (deposit watcher, coin
 * creation, refunds) can supply its own implementation; the default records the launch with a
 * fresh deposit address and lets the launcher pick it up from `launches`.
 */
export interface LaunchService {
  create(req: LaunchRequest): Promise<LaunchResponse>;
  get(id: string): Promise<LaunchStatus | null>;
}

export function solanaPayUrl(address: string, lamports: bigint, ticker: string): string {
  const params = new URLSearchParams({ amount: lamportsToSolString(lamports), label: "Holdfast", message: `Launch $${ticker}` });
  return `solana:${address}?${params.toString().replace(/\+/g, "%20")}`;
}

export class DbLaunchService implements LaunchService {
  constructor(
    private readonly db: Db,
    private readonly allocateDepositAddress: DepositAllocator,
    private readonly opts: { ttlMs: number; cost: LaunchCostSettings; now?: () => number },
  ) {}

  async create(req: LaunchRequest): Promise<LaunchResponse> {
    const now = this.opts.now?.() ?? Date.now();
    const devBuyLamports = solToLamports(req.devBuySol ?? 0);
    const required = launchCost(this.opts.cost, req).requiredLamports;
    const id = randomUUID();
    const expiresAt = now + this.opts.ttlMs;
    const row = await this.db.tx(async (q) => {
      const index = await nextDepositIndex(q);
      const depositAddress = await this.allocateDepositAddress(index);
      const launch = await insertLaunch(q, { id, form: req, depositAddress, depositIndex: index, requiredLamports: required, devBuyLamports, expiresAt });
      // Deposit addresses never earn (spec §2), even if they end up holding tokens.
      await addExcluded(q, [{ address: depositAddress, reason: "deposit" }]);
      return launch;
    });
    return {
      launchId: row.id,
      depositAddress: row.depositAddress,
      requiredLamports: required.toString(),
      requiredSol: lamportsToSol(required),
      solanaPayUrl: solanaPayUrl(row.depositAddress, required, req.ticker),
      expiresAt: row.expiresAt,
    };
  }

  async get(id: string): Promise<LaunchStatus | null> {
    const row = await getLaunch(this.db, id);
    return row ? toLaunchStatus(row) : null;
  }
}
