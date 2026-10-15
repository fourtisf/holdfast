/**
 * Launcher monitoring: launches by status (Prometheus), /healthz (worker loop alive), and alerts for
 * launches stuck in progress or newly failed. Failed launches are always refunded; the alert is for
 * the operator to look at why.
 */
import { countLaunchesByStatus, listLaunches, type Db } from "@holdfast/db";
import { alerterFromEnv, freshness, Metrics, startOpsServer, type Alerter, type OpsPostHandler, type OpsServer } from "@holdfast/ops";

interface Logger {
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const IN_PROGRESS = ["deposit_received", "creating", "refunding"] as const;

export class LauncherMonitor {
  readonly metrics = new Metrics();
  readonly alerter: Alerter;
  private lastTickAt: number | null = null;
  private readonly launches = this.metrics.gauge("launches", "Launches by status");
  private readonly tickAt = this.metrics.gauge("loop_last_success_timestamp_seconds", "End of the last launcher tick");
  private readonly tickErrors = this.metrics.counter("launcher_tick_errors_total", "Launcher ticks that threw");
  private readonly seenFailed = new Set<string>();
  private primed = false;

  constructor(
    private readonly db: Db,
    log: Logger,
    private readonly opts: { stuckAfterMs: number; maxTickAgeMs: number },
    env: Record<string, string | undefined> = process.env,
    private readonly now: () => number = Date.now,
  ) {
    this.alerter = alerterFromEnv("launcher", env, log);
  }

  start(port: number, post?: Record<string, OpsPostHandler>): Promise<OpsServer | null> {
    if (port <= 0) return Promise.resolve(null);
    return startOpsServer({ port, metrics: this.metrics, health: () => freshness(this.lastTickAt, this.opts.maxTickAgeMs, this.now()), post });
  }

  tickFailed(): void {
    this.tickErrors.inc();
  }

  /** After each worker tick. */
  async tickDone(): Promise<void> {
    this.lastTickAt = this.now();
    this.tickAt.setToNow({}, this.lastTickAt);
    const counts = await countLaunchesByStatus(this.db);
    for (const status of ["awaiting_deposit", "deposit_received", "creating", "live", "refunding", "refunded", "expired", "failed"]) this.launches.set(counts[status] ?? 0, { status });

    const stuck = (await listLaunches(this.db, { statuses: IN_PROGRESS, limit: 100 })).filter((l) => this.now() - l.updatedAt > this.opts.stuckAfterMs);
    if (stuck.length > 0) {
      await this.alerter.fire("launches_stuck", "warning", `${stuck.length} launch(es) stuck in progress`, {
        launches: stuck.slice(0, 5).map((l) => `${l.id} ${l.status} attempts=${l.attempts} ${l.error ?? ""}`.trim()),
      });
    } else {
      await this.alerter.resolve("launches_stuck", "no launch is stuck any more");
    }

    const failed = await listLaunches(this.db, { statuses: ["failed"], limit: 50 });
    // The first pass only learns what had already failed before this process started.
    for (const l of failed) {
      if (this.seenFailed.has(l.id)) continue;
      this.seenFailed.add(l.id);
      if (this.primed) await this.alerter.fire(`launch_failed:${l.id}`, "warning", "launch failed and was refunded", { launchId: l.id, ticker: l.form.ticker, error: l.error });
    }
    this.primed = true;
  }
}
