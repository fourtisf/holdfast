import { Connection } from "@solana/web3.js";
import { pino } from "pino";
import { connectDb, migrate } from "@holdfast/db";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { hkdfDepositAllocator } from "./launch/deposit.js";
import { randomDepositAllocator } from "./launch/dev.js";
import { DbLaunchService } from "./launch/service.js";
import { loadClusterRent } from "./launch/cost.js";
import { launchCostSettings } from "./launch/settings.js";
import { SolUsdFeed } from "./services/price.js";
import { RpcTradeChain } from "./trade/chain.js";
import { pgEventSource } from "./ws/events.js";

const config = loadConfig();
const log = pino({ level: config.logLevel, base: { service: "api" } });
if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
if (!config.depositMasterSecret && config.production) throw new Error("DEPOSIT_MASTER_SECRET is required in production");

const db = await connectDb(config.databaseUrl, { onError: (err) => log.error({ err }, "db error") });
if (process.env.API_MIGRATE !== "0") await migrate(db, { log: (msg) => log.info(msg) });

const allocator = config.depositMasterSecret ? hkdfDepositAllocator(config.depositMasterSecret) : randomDepositAllocator;
if (!config.depositMasterSecret) log.warn("DEPOSIT_MASTER_SECRET not set: deposit addresses are random and unrecoverable (dev only)");

const connection = new Connection(config.rpcUrl, "confirmed");
await loadClusterRent(async (len) => BigInt(await connection.getMinimumBalanceForRentExemption(len))).catch((err: Error) =>
  log.warn({ err: err.message }, "could not read the cluster's rent; quoting with the default rent"),
);

const { app } = await buildApp({
  db,
  config,
  tradeChain: new RpcTradeChain(connection),
  launches: new DbLaunchService(db, allocator, { ttlMs: config.launchTtlMs, cost: launchCostSettings(config) }),
  events: pgEventSource(db),
  prices:
    process.env.PRICE_FEED === "off"
      ? undefined
      : new SolUsdFeed({ hermesUrl: process.env.PYTH_HERMES_URL || undefined, coingeckoUrl: process.env.COINGECKO_PRICE_URL === "off" ? null : process.env.COINGECKO_PRICE_URL || undefined, log }),
  logger: log,
});
await app.listen({ port: config.port, host: config.host });

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  log.info({ signal }, "shutting down");
  await app.close();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
