/**
 * Notifier monitoring (@holdfast/ops): Prometheus metrics, /healthz (healthy while the getUpdates
 * loop keeps returning) and an operator alert when polling Telegram keeps failing.
 */
import { alerterFromEnv, freshness, Metrics, startOpsServer, type Alerter, type OpsServer } from "@holdfast/ops";

import type { DeliveryMetrics, DeliveryResult } from "./outbox.js";
import { TelegramError } from "./telegram.js";

interface Logger {
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
}

export class NotifierMonitor implements DeliveryMetrics {
  readonly metrics = new Metrics();
  readonly alerter: Alerter;
  private lastPollAt: number | null = null;
  private pollFailures = 0;
  private readonly messages = this.metrics.counter("notifier_messages_total", "Telegram messages by kind and delivery result (sent, duplicate, failed, unavailable)");
  private readonly commands = this.metrics.counter("notifier_commands_total", "Bot commands handled, by command");
  private readonly events = this.metrics.counter("notifier_events_total", "holdfast_events notifications handled, by kind");
  private readonly errors = this.metrics.counter("notifier_errors_total", "Errors by source (poll, update, event, milestones)");
  private readonly pollAt = this.metrics.gauge("loop_last_success_timestamp_seconds", "End of the last successful getUpdates call");
  private readonly subscriptions = this.metrics.gauge("notifier_subscriptions", "Subscriptions by kind");

  constructor(
    private readonly log: Logger,
    private readonly opts: { maxPollAgeMs: number; failureStreak?: number },
    env: Record<string, string | undefined> = process.env,
    private readonly now: () => number = Date.now,
  ) {
    this.alerter = alerterFromEnv("notifier", env, log);
  }

  start(port: number): Promise<OpsServer | null> {
    if (port <= 0) return Promise.resolve(null);
    return startOpsServer({ port, metrics: this.metrics, health: () => freshness(this.lastPollAt, this.opts.maxPollAgeMs, this.now()) });
  }

  async pollDone(): Promise<void> {
    this.lastPollAt = this.now();
    this.pollAt.setToNow({}, this.lastPollAt);
    if (this.pollFailures > 0) {
      this.pollFailures = 0;
      await this.alerter.resolve("telegram_poll", "telegram polling recovered");
    }
  }

  async pollFailed(err: unknown): Promise<void> {
    this.error("poll");
    this.pollFailures++;
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof TelegramError && err.code === 401) {
      await this.alerter.fire("telegram_poll", "critical", "TELEGRAM_BOT_TOKEN was rejected: the bot is offline", { error: message });
    } else if (err instanceof TelegramError && err.code === 409) {
      await this.alerter.fire("telegram_poll", "warning", "another process is polling this bot (or a webhook is set): updates are split between them", { error: message });
    } else if (this.pollFailures >= (this.opts.failureStreak ?? 3)) {
      await this.alerter.fire("telegram_poll", "warning", "telegram polling keeps failing", { error: message, consecutiveFailures: this.pollFailures });
    } else {
      this.log.warn({ err: message }, "getUpdates failed");
    }
  }

  delivered(kind: string, result: DeliveryResult): void {
    this.messages.inc({ kind, result });
  }

  command(name: string): void {
    this.commands.inc({ command: name });
  }

  event(kind: string): void {
    this.events.inc({ kind });
  }

  error(source: string): void {
    this.errors.inc({ source });
  }

  setSubscriptions(counts: { wallet: number; coin: number }): void {
    this.subscriptions.set(counts.wallet, { kind: "wallet" });
    this.subscriptions.set(counts.coin, { kind: "coin" });
  }

  /** Current value of one series (tests). */
  counter(name: "messages" | "commands" | "events" | "errors", labels: Record<string, string>): number {
    return this[name].get(labels);
  }
}
