import { Connection } from "@solana/web3.js";
import { connectDb } from "@holdfast/db";
import pino from "pino";

import { Web3Chain } from "./chain.js";
import { loadConfig, loadKeypair } from "./config.js";
import { crankCoin, loadProgramConfig } from "./crank.js";
import { Monitor, opsPort } from "./monitor.js";
import type { CrankMemory } from "./plan.js";
import { SdkPumpGateway } from "./pump.js";
import { loadCoinKeys, mapLimit, mirrorVault, sleep } from "./util.js";

const log = pino({ name: "keeper" });

async function main() {
  const cfg = loadConfig();
  const db = await connectDb(cfg.databaseUrl);
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const chain = new Web3Chain(connection, cfg.priorityMicroLamports);
  const keeper = loadKeypair(cfg.keeperKeypairPath);
  const pump = new SdkPumpGateway(connection);
  const memory = new Map<string, CrankMemory>();

  let programConfig = await loadProgramConfig(chain);
  if (!programConfig.keeper.equals(keeper.publicKey)) {
    throw new Error(`KEEPER_KEYPAIR ${keeper.publicKey.toBase58()} is not Config.keeper ${programConfig.keeper.toBase58()}`);
  }
  const monitor = new Monitor({ service: "keeper", lowBalanceLamports: cfg.payout.keeperMinBalanceLamports * 4n, maxLoopAgeMs: Math.max(cfg.tickMs * 4, 120_000) }, log);
  const ops = await monitor.start(opsPort(process.env, "KEEPER_OPS_PORT", 9101));
  log.info({ keeper: keeper.publicKey.toBase58(), tickMs: cfg.tickMs, opsPort: ops?.port ?? null, alerts: monitor.alerter.enabled }, "keeper started");

  let configLoadedAt = Date.now();
  let stopping = false;
  process.on("SIGTERM", () => (stopping = true));
  process.on("SIGINT", () => (stopping = true));

  while (!stopping) {
    const started = Date.now();
    try {
      if (Date.now() - configLoadedAt > 60_000) {
        programConfig = await loadProgramConfig(chain);
        configLoadedAt = Date.now();
      }
      if (programConfig.paused) {
        log.warn("program paused; skipping tick");
      } else {
        const coins = await loadCoinKeys(db);
        const [keeperInfo] = await chain.getAccounts([keeper.publicKey]);
        await monitor.keeperBalance(BigInt(keeperInfo?.lamports ?? 0));
        await mapLimit(coins, cfg.coinConcurrency, async (coin) => {
          const key = coin.mint.toBase58();
          const mem = memory.get(key) ?? { lastCollectAt: 0, lastBurnAt: 0 };
          memory.set(key, mem);
          try {
            const res = await crankCoin(
              {
                chain,
                pump,
                keeper,
                log,
                options: {
                  collectEverySecs: cfg.collectEverySecs,
                  defendSlippageBps: cfg.defendSlippageBps,
                  curveFeeBpsEstimate: cfg.curveFeeBpsEstimate,
                  ammFeeBpsEstimate: cfg.ammFeeBpsEstimate,
                  burnThresholdLamports: cfg.burnThresholdLamports,
                  burnEverySecs: cfg.burnEverySecs,
                  defendJitterMs: cfg.defendJitterMs,
                  burnSlippageBps: cfg.burnSlippageBps,
                },
                onVault: (c, v) => mirrorVault(db, c, v),
              },
              coin,
              programConfig,
              mem,
            );
            if (res.sent.length > 0) log.info({ mint: key, sent: res.sent }, "cranked");
            await monitor.crank(key, res);
          } catch (err) {
            log.error({ mint: key, err: (err as Error).message }, "crank failed");
          }
        });
        monitor.loopDone(coins.length);
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, "tick failed");
    }
    await sleep(Math.max(1_000, cfg.tickMs - (Date.now() - started)));
  }
  await ops?.close();
  await db.close();
}

main().catch((err) => {
  log.fatal({ err: (err as Error).message }, "keeper crashed");
  process.exit(1);
});
