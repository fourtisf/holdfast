/**
 * Minimal Prometheus metrics (text exposition format 0.0.4): counters and gauges with labels.
 * Enough for scraping service health without a client library.
 */
export type Labels = Record<string, string | number | boolean>;

type Kind = "counter" | "gauge";

interface Series {
  labels: Labels;
  value: number;
}

class Metric {
  readonly series = new Map<string, Series>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly kind: Kind,
  ) {}

  protected key(labels: Labels): string {
    return JSON.stringify(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  protected entry(labels: Labels): Series {
    const k = this.key(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { labels, value: 0 };
      this.series.set(k, s);
    }
    return s;
  }

  get(labels: Labels = {}): number {
    return this.series.get(this.key(labels))?.value ?? 0;
  }
}

export class Counter extends Metric {
  constructor(name: string, help: string) {
    super(name, help, "counter");
  }
  inc(labels: Labels = {}, by = 1): void {
    if (by < 0) throw new Error("counters only go up");
    this.entry(labels).value += by;
  }
}

export class Gauge extends Metric {
  constructor(name: string, help: string) {
    super(name, help, "gauge");
  }
  set(value: number, labels: Labels = {}): void {
    this.entry(labels).value = value;
  }
  /** Seconds since the epoch, the usual way to export "last success" timestamps. */
  setToNow(labels: Labels = {}, nowMs = Date.now()): void {
    this.set(nowMs / 1000, labels);
  }
}

const escapeLabel = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function formatValue(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "+Inf";
  if (v === -Infinity) return "-Inf";
  return String(v);
}

export class Metrics {
  private readonly metrics = new Map<string, Metric>();
  constructor(private readonly prefix = "holdfast_") {}

  private register<T extends Metric>(name: string, make: (full: string) => T): T {
    const full = `${this.prefix}${name}`;
    if (!NAME.test(full)) throw new Error(`invalid metric name ${full}`);
    const existing = this.metrics.get(full);
    if (existing) return existing as T;
    const m = make(full);
    this.metrics.set(full, m);
    return m;
  }

  counter(name: string, help: string): Counter {
    return this.register(name, (full) => new Counter(full, help));
  }

  gauge(name: string, help: string): Gauge {
    return this.register(name, (full) => new Gauge(full, help));
  }

  render(): string {
    const lines: string[] = [];
    for (const m of this.metrics.values()) {
      lines.push(`# HELP ${m.name} ${m.help.replace(/\n/g, " ")}`, `# TYPE ${m.name} ${m.kind}`);
      for (const s of m.series.values()) {
        const labels = Object.entries(s.labels);
        const l = labels.length ? `{${labels.map(([k, v]) => `${k}="${escapeLabel(String(v))}"`).join(",")}}` : "";
        lines.push(`${m.name}${l} ${formatValue(s.value)}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }
}
