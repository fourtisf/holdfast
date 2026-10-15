/** `pnpm --filter @holdfast/launcher start`: the long-running launch worker. */
import { pino } from "pino";
import { connectDb, migrate } from "@holdfast/db";

import { verifyLauncherAuthority } from "./authority.js";
import { loadConfig, redactUrl } from "./config.js";
import { formatSol } from "@holdfast/chain";
import { Web3LaunchChain } from "./web3Chain.js";
import { LauncherMonitor } from "./monitor.js";
import { walletLaunchHandler } from "./walletLaunch.js";
import { LaunchWorker } from "./worker.js";

const config = loadConfig();
const log = pino({ level: config.logLevel, base: { service: "launcher" } });
const { settings } = config;

const db = await connectDb(config.databaseUrl, { onError: (err) => log.error({ err }, "db error") });
if (config.migrate) await migrate(db, { log: (msg) => log.info(msg) });

const chain = Web3LaunchChain.fromUrl(config.rpcUrl);
const authority = await verifyLauncherAuthority(chain, settings.launcher.publicKey).catch((err: unknown) => ({
  ok: false as const,
  reason: `cannot read the Holdfast Config from ${redactUrl(config.rpcUrl)}: ${err instanceof Error ? err.message : String(err)}`,
}));
if (!authority.ok) {
  log.fatal({ reason: authority.reason }, "launcher wallet cannot call init_coin");
  await db.close();
  process.exit(1);
}

if (settings.lookupTable && !(await chain.getLookupTable(settings.lookupTable))) {
  log.fatal({ lookupTable: settings.lookupTable.toBase58() }, "LAUNCHER_LOOKUP_TABLE does not exist (pnpm --filter @holdfast/launcher alt create)");
  await db.close();
  process.exit(1);
}

const worker = new LaunchWorker({ db, chain, settings, log, storage: config.storage });
const monitor = new LauncherMonitor(db, log, { stuckAfterMs: 30 * 60_000, maxTickAgeMs: Math.max(20 * config.pollIntervalMs, 2 * 60_000) });
const opsPortValue = Number(process.env.LAUNCHER_OPS_PORT ?? 9103);
// POST /wallet-launch: the API asks for a wallet-signed launch transaction (internal; the port is not published).
const ops = await monitor.start(Number.isInteger(opsPortValue) ? opsPortValue : 9103, { "/wallet-launch": walletLaunchHandler(worker, log) });
// A typical launch (12-byte name, 5-byte ticker, no dev buy).
const cost = await worker.launchCost({ form: { name: "x".repeat(12), ticker: "x".repeat(5) }, devBuyLamports: 0n } as Parameters<typeof worker.launchCost>[0]);
log.info(
  {
    rpc: redactUrl(config.rpcUrl),
    program: config.holdfastProgramId,
    launcher: settings.launcher.publicKey.toBase58(),
    metadataBase: settings.metadata.publicBaseUrl,
    metadataStorage: config.storage.kind,
    opsPort: ops?.port ?? null,
    alerts: monitor.alerter.enabled,
    mode: worker.mode,
    launchCostSol: formatSol(cost.consumed),
    requiredSol: formatSol(cost.launchFee),
  },
  "launcher started",
);
if (cost.exceedsSpecFee) log.warn({ costSol: formatSol(cost.consumed) }, "the real launch cost exceeds the 0.015 SOL of the spec; charging the real cost");

let stopping = false;
const loop = (async () => {
  while (!stopping) {
    try {
      await worker.tick();
      await monitor.tickDone();
    } catch (err) {
      monitor.tickFailed();
      log.error({ err: err instanceof Error ? err.message : String(err) }, "tick failed");
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
})();

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  await loop;
  await ops?.close();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
