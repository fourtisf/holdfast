import { Connection, PublicKey } from "@solana/web3.js";
import { pino } from "pino";
import { parseHoldfastEvents } from "@holdfast/chain";
import { connectDb, migrate } from "@holdfast/db";
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
};
const process_ = serialProcessor(deps);

const poller = config.poll
  ? new Poller({
      db,
      log,
      source: rpcChainSource(connection, { maxSupportedTransactionVersion: config.maxSupportedTransactionVersion }),
      process: process_,
      holdfastProgramId: config.holdfastProgramId,
      intervalMs: config.pollIntervalMs,
    })
  : null;
poller?.start();

const server = buildWebhookServer({ secret: config.heliusWebhookSecret, process: process_, logger: log });
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
