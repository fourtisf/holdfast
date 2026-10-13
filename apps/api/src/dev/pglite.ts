/**
 * Local API without Postgres or Solana: PGlite (WASM Postgres), migrations, the demo dataset and a
 * small trade simulator. `pnpm --filter @holdfast/api dev:pglite`
 *
 *   PGLITE_DIR=./data/pglite   persist between runs (default: in-memory)
 *   DEV_SIMULATE=0             disable simulated trades
 */
import { Connection } from "@solana/web3.js";
import { pino } from "pino";
import { countCoins, createPgliteDb, migrate, seedDemo } from "@holdfast/db";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hkdfDepositAllocator } from "../launch/deposit.js";
import { randomDepositAllocator } from "../launch/dev.js";
import { DbLaunchService } from "../launch/service.js";
import { RpcTradeChain } from "../trade/chain.js";
import { pgEventSource } from "../ws/events.js";
import { startSimulator } from "./simulate.js";

const config = { ...loadConfig(), databaseUrl: "pglite" };
const log = pino({ level: config.logLevel, base: { service: "api-dev" } });

const db = await createPgliteDb({ dataDir: process.env.PGLITE_DIR || undefined });
await migrate(db, { log: (msg) => log.info(msg) });
if ((await countCoins(db)) === 0) {
  const t0 = Date.now();
  const seeded = await seedDemo(db);
  log.info({ coins: seeded.mints.length, ms: Date.now() - t0 }, "seeded demo dataset");
}

const { app } = await buildApp({
  db,
  config,
  tradeChain: new RpcTradeChain(new Connection(config.rpcUrl, "confirmed")),
  launches: new DbLaunchService(db, config.depositMasterSecret ? hkdfDepositAllocator(config.depositMasterSecret) : randomDepositAllocator, { ttlMs: config.launchTtlMs }),
  events: pgEventSource(db),
  logger: log,
});
const stopSim = process.env.DEV_SIMULATE === "0" ? () => {} : startSimulator(db, { intervalMs: 4000, log: (m) => log.warn(m) });
await app.listen({ port: config.port, host: config.host });

async function shutdown() {
  stopSim();
  await app.close();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
