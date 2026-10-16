/** Real processes for the end-to-end run: a throwaway Postgres cluster and the services (via tsx). */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chownSync, chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, type WriteStream } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `url` until it answers 2xx (or the process died / time ran out). */
export async function waitForHttp(url: string, timeoutMs: number, alive: () => boolean = () => true): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    if (!alive()) throw new Error(`process exited before ${url} answered`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await sleep(200);
  }
  throw new Error(`${url} did not answer within ${timeoutMs} ms (${last})`);
}

/** E2E_PG_BIN, else the newest /usr/lib/postgresql/<v>/bin, else whatever is on PATH. */
function postgresBin(): string {
  if (process.env.E2E_PG_BIN) return process.env.E2E_PG_BIN;
  const root = "/usr/lib/postgresql";
  if (existsSync(root)) {
    const versions = readdirSync(root)
      .filter((v) => existsSync(join(root, v, "bin", "initdb")))
      .sort((a, b) => Number(b) - Number(a));
    if (versions[0]) return join(root, versions[0], "bin");
  }
  return "";
}

export interface PgCluster {
  url: string;
  stop(): Promise<void>;
}

/**
 * initdb + pg_ctl start in `dir` (fsync off, trust auth on 127.0.0.1). As root, Postgres runs as the
 * `postgres` user (initdb refuses root), so `dir` must be readable by it (not a private tmp dir).
 */
export async function startPostgres(dir: string, log: (msg: string) => void): Promise<PgCluster> {
  const bin = postgresBin();
  const tool = (name: string) => (bin ? join(bin, name) : name);
  const asRoot = process.getuid?.() === 0;
  const runAs = (cmd: string, args: string[]) => (asRoot ? { cmd: "runuser", args: ["-u", "postgres", "--", cmd, ...args] } : { cmd, args });
  const data = join(dir, "pg");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  if (asRoot) {
    const uid = Number(spawnSync("id", ["-u", "postgres"], { encoding: "utf8" }).stdout.trim());
    const gid = Number(spawnSync("id", ["-g", "postgres"], { encoding: "utf8" }).stdout.trim());
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error("running as root, but there is no postgres user to run Postgres as");
    chmodSync(dir, 0o755);
    chownSync(data, uid, gid);
  }
  const run = (name: string, args: string[]) => {
    const c = runAs(tool(name), args);
    const r = spawnSync(c.cmd, c.args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${name} failed (${r.status}): ${r.stderr || r.stdout || r.error?.message}`);
    return r.stdout;
  };
  run("initdb", ["-D", data, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--no-locale", "--no-sync"]);
  const port = await freePort();
  const opts = `-p ${port} -k ${data} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`;
  run("pg_ctl", ["-D", data, "-l", join(data, "server.log"), "-w", "-t", "60", "-o", opts, "start"]);
  log(`postgres ${bin || "(PATH)"} on 127.0.0.1:${port}`);
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    async stop() {
      try {
        run("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"]);
      } catch (err) {
        log(`pg_ctl stop: ${(err as Error).message}`);
      }
    },
  };
}

/** A service started with `node --import tsx <script>`, its output in a log file (and the last lines kept in memory). */
export class Service {
  private child: ChildProcess | null = null;
  private out: WriteStream | null = null;
  private exit: Promise<number | null> = Promise.resolve(null);
  private readonly tail: string[] = [];
  /** pino lines at level error (50) or fatal (60), across every start. */
  readonly errors: string[] = [];
  starts = 0;

  constructor(
    readonly name: string,
    private readonly spec: { script: string; cwd: string; env: NodeJS.ProcessEnv; logFile: string },
  ) {}

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  start(): void {
    if (this.running) throw new Error(`${this.name} is already running`);
    this.starts++;
    this.out ??= createWriteStream(this.spec.logFile, { flags: "a" });
    this.out.write(`\n----- ${this.name} start #${this.starts} at ${new Date().toISOString()} -----\n`);
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), this.spec.script], {
      cwd: this.spec.cwd,
      env: this.spec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    let partial = "";
    const onData = (chunk: Buffer) => {
      this.out?.write(chunk);
      const lines = (partial + chunk.toString("utf8")).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        this.tail.push(line);
        if (this.tail.length > 80) this.tail.shift();
        if (/"level":(50|60)\b/.test(line)) this.errors.push(line);
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    this.exit = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  }

  /** SIGTERM (the service's own shutdown), SIGKILL after `graceMs`. Resolves with the exit code. */
  async stop(graceMs = 15_000): Promise<number | null> {
    const child = this.child;
    if (!child || !this.running) return child?.exitCode ?? null;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    const code = await this.exit;
    clearTimeout(timer);
    return code;
  }

  lastLines(n = 30): string[] {
    return this.tail.slice(-n);
  }

  async close(): Promise<void> {
    await this.stop(5_000);
    await new Promise<void>((resolve) => (this.out ? this.out.end(() => resolve()) : resolve()));
    this.out = null;
  }
}
