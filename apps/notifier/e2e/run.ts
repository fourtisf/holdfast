/**
 * End-to-end run of the Moatpad Telegram bot as real processes:
 *
 *   pnpm --filter @holdfast/notifier e2e
 *
 * 1. a throwaway Postgres cluster (initdb + pg_ctl, under /var/tmp), the real migrations and the demo
 *    dataset (seedDemo), plus coins registered the way the launcher does it;
 * 2. the real API (apps/api/src/main.ts) on that database, launches open;
 * 3. a fake Telegram Bot API server (e2e/fake-telegram.ts) that records every call and lets the run
 *    send updates as users: messages, photos, button presses, the bot being added to a group;
 * 4. the real notifier (apps/notifier/src/main.ts) pointed at the fake Telegram, the API and the database;
 * 5. scenarios (e2e/scenarios.ts) that use the bot like people do, write the database the way the
 *    indexer, launcher and payout worker do (NOTIFY included), and check what Telegram receives.
 *
 * Prints a pass/fail table and exits 1 on any failure; takes about 90 s (one scenario waits out the buy
 * limit's one-minute window). Needs Postgres binaries (initdb, pg_ctl; found in
 * /usr/lib/postgresql/<version>/bin, or set E2E_PG_BIN); as root, Postgres runs as the `postgres` user.
 * E2E_DATABASE_URL uses an existing empty database instead (it is migrated and seeded).
 * E2E_KEEP=1 keeps the temp dir (service logs, uploads, the cluster) for a look afterwards.
 * Not part of `pnpm test`.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { connectDb, migrate, seedDemo, type Db } from "@holdfast/db";

import { registerCoin } from "./chain-events.js";
import { FakeTelegram, WaitTimeout } from "./fake-telegram.js";
import { AssertionError, indent, type Ctx } from "./harness.js";
import { freePort, Service, startPostgres, waitForHttp, type PgCluster } from "./processes.js";
import { runScenarios } from "./scenarios.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BOT_TOKEN = "7000000001:AAE2e-fake-token_for-the-e2e-run";
const BOT_USERNAME = "MoatpadE2EBot";
const WEB_URL = "https://moatpad.e2e";
const MOAT_CA = "4qLdhoVDiAkXVXqU4D3rSPp6pMMnJzRJr38do55Hpump";
const BURN_CHAT_ID = -1001000000999;

const log = (msg: string) => console.log(`[e2e] ${msg}`);

/** A real 16×16 PNG (what a Telegram photo download returns here). */
function png(): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(8 + body.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const size = 16;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    rows[y * (1 + size * 3)] = 0;
    for (let x = 0; x < size; x++) rows.set([20 + x * 14, 120, 200 - y * 10], y * (1 + size * 3) + 1 + x * 3);
  }
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]));
}

/** Only what the services need: nothing from the developer's shell (.env values, tokens) leaks in. */
function baseEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "LANG", "TZ", "SYSTEMROOT"];
  return Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
}

interface Result {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

async function main(): Promise<number> {
  // Not os.tmpdir(): a private per-user tmp dir may not be readable by the postgres user.
  const base = existsSync("/var/tmp") ? "/var/tmp" : tmpdir();
  const dir = mkdtempSync(join(base, "moatpad-e2e-"));
  const keep = process.env.E2E_KEEP === "1";
  const cleanups: (() => Promise<void>)[] = [];
  const results: Result[] = [];
  let ctx: Ctx | null = null;
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    log("interrupted: cleaning up");
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    log(`work dir ${dir}`);
    let databaseUrl = process.env.E2E_DATABASE_URL ?? "";
    if (!databaseUrl) {
      const pg: PgCluster = await startPostgres(dir, log);
      cleanups.push(() => pg.stop());
      databaseUrl = pg.url;
    }
    const db: Db = await connectDb(databaseUrl);
    cleanups.push(() => db.close());
    const applied = await migrate(db);
    log(`migrations applied: ${applied.length}`);
    const now = Date.now();
    const seeded = await seedDemo(db, { now });
    log(`seeded ${seeded.mints.length} demo coins`);
    const buy = await registerCoin(db, { label: "buyme", name: "E2E Buy Coin", ticker: "BUYME", floorSol: 2_500_000_000n, createdAt: now - 3_600_000 });
    const alert = await registerCoin(db, { label: "alert", name: "E2E Alert Coin", ticker: "ALERT", floorSol: 800_000_000n, createdAt: now - 7_200_000 });

    const pngBytes = png();
    const botUser = { id: 7000000001, is_bot: true, first_name: "Moatpad", username: BOT_USERNAME };
    const tg = new FakeTelegram({ token: BOT_TOKEN, bot: botUser, fileBytes: pngBytes });
    const tgUrl = await tg.start();
    cleanups.push(() => tg.stop());
    log(`fake Telegram Bot API at ${tgUrl}`);

    const internalToken = randomBytes(32).toString("hex");
    const apiPort = await freePort();
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const metadataDir = join(dir, "uploads");
    mkdirSync(metadataDir, { recursive: true });
    const deadRpc = `http://127.0.0.1:${await freePort()}`;
    const api = new Service("api", {
      script: "src/main.ts",
      cwd: join(ROOT, "apps/api"),
      logFile: join(dir, "api.log"),
      env: {
        ...baseEnv(),
        DATABASE_URL: databaseUrl,
        API_PORT: String(apiPort),
        API_HOST: "127.0.0.1",
        LAUNCHES_PAUSED: "false",
        DEPOSIT_MASTER_SECRET: randomBytes(32).toString("hex"),
        INTERNAL_API_TOKEN: internalToken,
        METADATA_STORE: metadataDir,
        PUBLIC_METADATA_BASE_URL: `${apiUrl}/metadata`,
        // No chain here: the cluster rent read fails fast and the API quotes with the default rent.
        SOLANA_RPC_URL: deadRpc,
        LAUNCHER_INTERNAL_URL: deadRpc,
        PRICE_FEED: "off",
        CORS_ORIGIN: WEB_URL,
        LOG_LEVEL: "warn",
      },
    });
    api.start();
    cleanups.push(() => api.close());
    await waitForHttp(`${apiUrl}/healthz`, 60_000, () => api.running);
    log(`API at ${apiUrl}`);

    const opsPort = await freePort();
    const notifier = new Service("notifier", {
      script: "src/main.ts",
      cwd: join(ROOT, "apps/notifier"),
      logFile: join(dir, "notifier.log"),
      env: {
        ...baseEnv(),
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_API_URL: tgUrl,
        DATABASE_URL: databaseUrl,
        WEB_URL,
        API_INTERNAL_URL: apiUrl,
        INTERNAL_API_TOKEN: internalToken,
        NOTIFIER_BURN_CHAT_ID: String(BURN_CHAT_ID),
        MOAT_CA,
        SOLANA_CLUSTER: "devnet",
        NOTIFIER_OPS_PORT: String(opsPort),
        NOTIFIER_POLL_TIMEOUT_SECS: "10",
        LOG_LEVEL: "info",
      },
    });
    cleanups.push(() => notifier.close());
    const startNotifier = async () => {
      const since = tg.cursor;
      notifier.start();
      await tg.waitForCall(since, (c) => c.method === "getUpdates", 60_000, "the notifier's first getUpdates");
      await waitForHttp(`http://127.0.0.1:${opsPort}/metrics`, 20_000, () => notifier.running);
    };
    await startNotifier();
    log("notifier is polling the fake Telegram");

    ctx = {
      db,
      tg,
      apiUrl,
      webUrl: WEB_URL,
      botUsername: BOT_USERNAME,
      botUser,
      burnChatId: BURN_CHAT_ID,
      moatCa: MOAT_CA,
      notifier,
      api,
      metadataDir,
      opsUrl: `http://127.0.0.1:${opsPort}`,
      pngBytes,
      startNotifier,
      pressed: [],
      coins: { buy, alert, seeded: seeded.mints },
      expectedRefusals: [],
      expectedLogErrors: [],
    };
    const c = ctx;
    await runScenarios(c, async (name, fn) => {
      if (interrupted) return;
      const t0 = Date.now();
      try {
        await fn();
        results.push({ name, ok: true, ms: Date.now() - t0 });
      } catch (err) {
        const message = err instanceof AssertionError || err instanceof WaitTimeout ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err);
        results.push({ name, ok: false, ms: Date.now() - t0, error: message });
      }
    });

    if (!interrupted) {
      const t0 = Date.now();
      const exit = await notifier.stop();
      results.push({ name: "notifier shuts down cleanly on SIGTERM", ok: exit === 0, ms: Date.now() - t0, error: exit === 0 ? undefined : `exit code ${exit}` });
      const errors = [...notifier.errors, ...api.errors].filter((line) => !c.expectedLogErrors.some((re) => re.test(line)));
      results.push({ name: "notifier and API logged no errors", ok: errors.length === 0, ms: 0, error: errors.length ? errors.slice(0, 10).join("\n") : undefined });
    }
  } catch (err) {
    results.push({ name: "setup", ok: false, ms: 0, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  } finally {
    for (const fn of cleanups.reverse()) await fn().catch((err: unknown) => log(`cleanup: ${(err as Error).message}`));
    if (keep) log(`kept ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }

  report(results, ctx);
  return results.every((r) => r.ok) && results.length > 0 && !interrupted ? 0 : 1;
}

function report(results: Result[], ctx: Ctx | null): void {
  const width = Math.min(96, Math.max(...results.map((r) => r.name.length), 10));
  console.log("");
  console.log(`  ${"scenario".padEnd(width)}  result  time`);
  console.log(`  ${"-".repeat(width)}  ------  ------`);
  results.forEach((r) => console.log(`  ${r.name.slice(0, width).padEnd(width)}  ${r.ok ? "PASS  " : "FAIL  "}  ${`${(r.ms / 1000).toFixed(1)}s`.padStart(6)}`));
  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(`  ${results.length - failed.length} passed, ${failed.length} failed`);
  for (const r of failed) {
    console.log("");
    console.log(`  FAIL ${r.name}`);
    console.log(indent(r.error ?? ""));
  }
  if (failed.length > 0 && ctx) {
    for (const s of [ctx.notifier, ctx.api]) {
      console.log("");
      console.log(`  last ${s.name} log lines:`);
      console.log(indent(s.lastLines(25).join("\n")));
    }
  }
}

process.exit(await main());
