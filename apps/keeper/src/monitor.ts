/**
 * Keeper / payout worker monitoring: Prometheus metrics, /healthz and operator alerts
 * (@holdfast/ops). What pages someone:
 * - the keeper wallet running low (it pays every crank and payout fee);
 * - a coin whose pump.fun creator is no longer its treasury (fees diverted by a pump.fun admin);
 * - an action that keeps failing for a coin (3 passes in a row), or payout rounds that keep failing.
 */
import { alerterFromEnv, Metrics, startOpsServer, freshness, type Alerter, type OpsServer } from "@holdfast/ops";

import type { CrankResult } from "./crank.js";
import type { RoundOutcome } from "./payout/worker.js";

export interface MonitorOptions {
  service: "keeper" | "payout";
  /** Warning below this keeper balance, critical below a fifth of it (lamports). */
  lowBalanceLamports: bigint;
  /** Healthy while the last loop iteration finished within this long. */
  maxLoopAgeMs: number;
  failureStreak?: number;
}

interface Logger {
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
}

export class Monitor {
  readonly metrics = new Metrics();
  readonly alerter: Alerter;
  private lastLoopAt: number | null = null;
  private readonly streaks = new Map<string, number>();
  private readonly actions = this.metrics.counter("keeper_actions_total", "Crank actions by kind and result");
  private readonly rounds = this.metrics.counter("payout_rounds_total", "Payout round outcomes");
  private readonly loopAt = this.metrics.gauge("loop_last_success_timestamp_seconds", "End of the last loop iteration");
  private readonly balance = this.metrics.gauge("keeper_balance_sol", "Keeper wallet balance");
  private readonly coins = this.metrics.gauge("coins", "Coins handled per loop");
  private readonly creatorMismatch = this.metrics.gauge("creator_mismatch_coins", "Coins whose pump.fun creator is not their treasury");
  private readonly mismatched = new Set<string>();

  constructor(
    private readonly opts: MonitorOptions,
    private readonly log: Logger,
    env: Record<string, string | undefined> = process.env,
    private readonly now: () => number = Date.now,
  ) {
    this.alerter = alerterFromEnv(opts.service, env, log);
  }

  start(port: number): Promise<OpsServer | null> {
    if (port <= 0) return Promise.resolve(null);
    return startOpsServer({ port, metrics: this.metrics, health: () => freshness(this.lastLoopAt, this.opts.maxLoopAgeMs, this.now()) });
  }

  loopDone(coins: number): void {
    this.lastLoopAt = this.now();
    this.loopAt.setToNow({}, this.lastLoopAt);
    this.coins.set(coins);
  }

  async keeperBalance(lamports: bigint): Promise<void> {
    this.balance.set(Number(lamports) / 1e9);
    const low = this.opts.lowBalanceLamports;
    if (lamports < low / 5n) await this.alerter.fire("keeper_balance", "critical", "keeper wallet almost empty: cranks and payouts will stop", { sol: Number(lamports) / 1e9 });
    else if (lamports < low) await this.alerter.fire("keeper_balance", "warning", "keeper wallet balance low", { sol: Number(lamports) / 1e9, thresholdSol: Number(low) / 1e9 });
    else await this.alerter.resolve("keeper_balance", "keeper wallet balance back above threshold");
  }

  private async streak(key: string, failed: boolean, message: string, details: Record<string, unknown>): Promise<void> {
    if (!failed) {
      if (this.streaks.delete(key)) await this.alerter.resolve(key, `${message}: recovered`);
      return;
    }
    const n = (this.streaks.get(key) ?? 0) + 1;
    this.streaks.set(key, n);
    if (n >= (this.opts.failureStreak ?? 3)) await this.alerter.fire(key, "warning", message, { ...details, consecutiveFailures: n });
  }

  async crank(mint: string, res: CrankResult): Promise<void> {
    for (const s of res.sent) this.actions.inc({ action: s.action, result: "sent" });
    for (const e of res.errors) this.actions.inc({ action: e.action, result: "error" });
    for (const action of new Set(res.actions)) {
      const err = res.errors.find((e) => e.action === action);
      await this.streak(`crank:${mint}:${action}`, err !== undefined, `${action} keeps failing`, { mint, error: err?.error });
    }
    if (res.creatorOk === false) {
      this.mismatched.add(mint);
      await this.alerter.fire(`creator:${mint}`, "critical", "pump.fun creator of a Holdfast coin is no longer its treasury: creator fees are diverted", { mint });
    } else if (res.creatorOk === true && this.mismatched.delete(mint)) {
      await this.alerter.resolve(`creator:${mint}`, "pump.fun creator restored to the treasury");
    }
    this.creatorMismatch.set(this.mismatched.size);
  }

  async round(mint: string, outcome: RoundOutcome | { kind: "error"; error: string }): Promise<void> {
    const kind = outcome.kind === "skipped" ? "skipped" : outcome.kind;
    this.rounds.inc({ outcome: kind });
    await this.streak(`round:${mint}`, outcome.kind === "error", "payout rounds keep failing", { mint, error: outcome.kind === "error" ? outcome.error : undefined });
  }
}

/** `KEEPER_OPS_PORT=9101` style settings; "0" disables the ops server. */
export function opsPort(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65_535) throw new Error(`${key} must be a port number (0 disables)`);
  return n;
}
