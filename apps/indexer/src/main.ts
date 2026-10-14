import { Connection, PublicKey } from "@solana/web3.js";
import { pino } from "pino";
import { parseHoldfastEvents } from "@holdfast/chain";
import { connectDb, migrate } from "@holdfast/db";
import { alerterFromEnv, Metrics } from "@holdfast/ops";
import { loadConfig } from "./config.js";
import { Poller, rpcChainSource } from "./poller.js";
import { serialProcessor, type ProcessDeps } from "./process.js";
import { pgPublisher } from "./publisher.js";
import { rpcVaultFetcher } from "./vault.js";
import { buildWebhookServer } from "./webhook.js";

const config = loadConfig();
const log = pino({ level: config.logLevel, base: { service: "indexer" } });
const db = await connectDb(config.databaseUrl, { onError: (err) => log.error({ err }, "db error") });
if (config.migrate) await migrate(db, { log: (msg) => log.info(msg) });

const connection = new Connection(config.rpcUrl, "confirmed");
const alerter = alerterFromEnv("indexer", process.env, log);
const metrics = new Metrics();
const processed = metrics.counter("indexer_transactions_total", "Transactions seen, by outcome");
const lastSlot = metrics.gauge("indexer_last_slot", "Slot of the newest processed relevant transaction");
const lastProcessedAt = metrics.gauge("indexer_last_processed_timestamp_seconds", "When the last relevant transaction was indexed");
const creatorChanges = metrics.counter("indexer_creator_changes_total", "pump.fun admin creator changes on Holdfast coins");
const pollFailures = metrics.counter("indexer_poll_failed_transactions_total", "Transactions the poller failed to index (retried next tick)");
let lastActivity = Date.now();
const holdfastProgram = new PublicKey(config.holdfastProgramId);
const deps: ProcessDeps = {
  db,
  log,
  holdfastProgramId: config.holdfastProgramId,
  parseHoldfastEvents: (logs) => parseHoldfastEvents(logs, holdfastProgram),
  fetchVault: rpcVaultFetcher(connection, undefined, holdfastProgram),
  publisher: pgPublisher,
  reductionOrder: config.reductionOrder,
  globalExclusions: config.launcherAddresses.map((address) => ({ address, reason: "launcher" })),
  onCreatorChange: async (e) => {
    creatorChanges.inc({ harmless: e.toTreasury });
    if (e.toTreasury) {
      log.info({ mint: e.mint, event: e.name, sig: e.sig }, "pump.fun creator event kept the treasury");
      return;
    }
    await alerter.fire(`creator:${e.mint}`, "critical", "pump.fun admin re-pointed a Holdfast coin's creator: its fees no longer reach the vault", {
      mint: e.mint,
      event: e.name,
      newCreator: e.newCreator,
      treasury: e.treasury,
      sig: e.sig,
    });
  },
};
const processOne = serialProcessor(deps);
const process_: typeof processOne = async (tx) => {
  const res = await processOne(tx);
  processed.inc({ status: res.status });
  if (res.status === "processed") {
    lastSlot.set(tx.slot);
    lastProcessedAt.setToNow();
  }
  return res;
};

const poller = config.poll
  ? new Poller({
      db,
      log,
      source: rpcChainSource(connection, { maxSupportedTransactionVersion: config.maxSupportedTransactionVersion }),
      process: process_,
      holdfastProgramId: config.holdfastProgramId,
      intervalMs: config.pollIntervalMs,
      onTick: (r) => {
        lastActivity = Date.now();
        pollFailures.inc({}, r.failed);
      },
    })
  : null;
poller?.start();

const server = buildWebhookServer({
  secret: config.heliusWebhookSecret,
  process: process_,
  logger: log,
  metrics: () => metrics.render(),
  health: async () => {
    await db.query("SELECT 1");
    // With polling on, the poller touches the chain every interval; silence means it is stuck.
    const quietMs = Date.now() - lastActivity;
    const ok = !config.poll || quietMs < Math.max(10 * config.pollIntervalMs, 5 * 60_000);
    return { ok, quietMs };
  },
});
if (!config.heliusWebhookSecret) log.warn("HELIUS_WEBHOOK_SECRET is not set: /webhooks/helius rejects every delivery");
await server.listen({ port: config.port, host: config.host });
log.info({ port: config.port, poll: config.poll, order: config.reductionOrder }, "indexer started");

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  log.info({ signal }, "shutting down");
  await poller?.stop();
  await server.close();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
