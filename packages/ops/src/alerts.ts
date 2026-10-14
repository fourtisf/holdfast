/**
 * Operator alerts: Telegram (ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID) and/or a webhook
 * (ALERT_WEBHOOK_URL, Slack- and Discord-compatible body). Each alert has a key; the same key is
 * re-sent at most every `minIntervalMs` while it keeps firing, and a "resolved" message follows
 * when `resolve(key)` is called after it fired.
 */
export type Severity = "info" | "warning" | "critical";

export interface Alert {
  key: string;
  severity: Severity;
  service: string;
  message: string;
  details?: Record<string, unknown>;
  resolved?: boolean;
}

export interface AlertSink {
  readonly name: string;
  send(alert: Alert): Promise<void>;
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

const ICON: Record<Severity, string> = { info: "ℹ️", warning: "⚠️", critical: "🚨" };

export function formatAlert(a: Alert): string {
  const head = a.resolved ? `✅ [${a.service}] resolved: ${a.message}` : `${ICON[a.severity]} [${a.service}] ${a.message}`;
  const details = a.details && Object.keys(a.details).length ? `\n${Object.entries(a.details).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")}` : "";
  return head + details;
}

export class TelegramSink implements AlertSink {
  readonly name = "telegram";
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly fetchFn: FetchFn = globalThis.fetch as unknown as FetchFn,
  ) {}
  async send(a: Alert): Promise<void> {
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text: formatAlert(a), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`telegram answered HTTP ${res.status}`);
  }
}

export class WebhookSink implements AlertSink {
  readonly name = "webhook";
  constructor(
    private readonly url: string,
    private readonly fetchFn: FetchFn = globalThis.fetch as unknown as FetchFn,
  ) {}
  async send(a: Alert): Promise<void> {
    const text = formatAlert(a);
    const res = await this.fetchFn(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `text` for Slack, `content` for Discord, the rest for anything else.
      body: JSON.stringify({ text, content: text, ...a }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`);
  }
}

export interface AlertLogger {
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export class Alerter {
  private readonly lastSent = new Map<string, number>();
  private readonly firing = new Set<string>();

  constructor(
    readonly service: string,
    private readonly sinks: readonly AlertSink[],
    private readonly log: AlertLogger,
    private readonly opts: { minIntervalMs?: number; now?: () => number } = {},
  ) {}

  get enabled(): boolean {
    return this.sinks.length > 0;
  }

  private async dispatch(alert: Alert): Promise<void> {
    await Promise.all(
      this.sinks.map((s) => s.send(alert).catch((err: unknown) => this.log.warn({ sink: s.name, err: err instanceof Error ? err.message : String(err) }, "alert delivery failed"))),
    );
  }

  /** Fires (or keeps firing) `key`. Always logged; sent to the sinks at most every minIntervalMs. */
  async fire(key: string, severity: Severity, message: string, details?: Record<string, unknown>): Promise<boolean> {
    const now = (this.opts.now ?? Date.now)();
    (severity === "critical" ? this.log.error : this.log.warn).call(this.log, { alert: key, ...details }, message);
    this.firing.add(key);
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < (this.opts.minIntervalMs ?? 15 * 60_000)) return false;
    this.lastSent.set(key, now);
    await this.dispatch({ key, severity, service: this.service, message, details });
    return true;
  }

  /** Ends `key`; sends one "resolved" message if it had fired. */
  async resolve(key: string, message = key): Promise<void> {
    if (!this.firing.delete(key)) return;
    this.lastSent.delete(key);
    await this.dispatch({ key, severity: "info", service: this.service, message, resolved: true });
  }
}

/** Sinks from ALERT_TELEGRAM_BOT_TOKEN / ALERT_TELEGRAM_CHAT_ID / ALERT_WEBHOOK_URL; ALERT_MIN_INTERVAL_MS. */
export function alerterFromEnv(service: string, env: Record<string, string | undefined>, log: AlertLogger, fetchFn?: FetchFn): Alerter {
  const sinks: AlertSink[] = [];
  if (env.ALERT_TELEGRAM_BOT_TOKEN && env.ALERT_TELEGRAM_CHAT_ID) sinks.push(new TelegramSink(env.ALERT_TELEGRAM_BOT_TOKEN, env.ALERT_TELEGRAM_CHAT_ID, fetchFn));
  if (env.ALERT_WEBHOOK_URL) sinks.push(new WebhookSink(env.ALERT_WEBHOOK_URL, fetchFn));
  const minIntervalMs = env.ALERT_MIN_INTERVAL_MS ? Number(env.ALERT_MIN_INTERVAL_MS) : undefined;
  return new Alerter(service, sinks, log, { minIntervalMs });
}
