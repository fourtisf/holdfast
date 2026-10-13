/** `pnpm --filter @holdfast/launcher start`: the long-running launch worker. */
import { pino } from "pino";
import { connectDb, migrate } from "@holdfast/db";

import { verifyLauncherAuthority } from "./authority.js";
import { loadConfig, redactUrl } from "./config.js";
import { computeLaunchCost, formatSol } from "./cost.js";
import { metadataUriLength } from "./metadata.js";
import { Web3LaunchChain } from "./web3Chain.js";
import { LaunchWorker } from "./worker.js";

const config = loadConfig();
const log = pino({ level: config.logLevel, base: { service: "launcher" } });
const { settings } = config;

const db = await connectDb(config.databaseUrl, { onError: (err) => log.error({ err }, "db error") });
if (config.migrate) await migrate(db, { log: (msg) => log.info(msg) });

const chain = Web3LaunchChain.fromUrl(config.rpcUrl);
const authority = await verifyLauncherAuthority(chain, settings.launcher.publicKey);
if (!authority.ok) {
  log.fatal({ reason: authority.reason }, "launcher wallet cannot call init_coin");
  await db.close();
  process.exit(1);
}

const worker = new LaunchWorker({ db, chain, settings, log });
const cost = computeLaunchCost(await worker.rent(), {
  uriBytes: metadataUriLength(settings.metadata.publicBaseUrl),
  priority: settings.priority,
});
log.info(
  {
    rpc: redactUrl(config.rpcUrl),
    program: config.holdfastProgramId,
    launcher: settings.launcher.publicKey.toBase58(),
    metadataBase: settings.metadata.publicBaseUrl,
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
    } catch (err) {
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
  await db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
