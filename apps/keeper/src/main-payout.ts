import { Connection } from "@solana/web3.js";
import { nextRoundAt } from "@holdfast/core";
import { connectDb } from "@holdfast/db";
import pino from "pino";

import { Web3Chain } from "./chain.js";
import { loadConfig, loadKeypair } from "./config.js";
import { loadProgramConfig } from "./crank.js";
import { runPayoutRound } from "./payout/worker.js";
import { SdkPumpGateway } from "./pump.js";
import { loadCoinKeys, mapLimit, sleep } from "./util.js";

const log = pino({ name: "payout" });

/** Starts each payout cycle on the shared 2-minute wall-clock schedule (same as the API's countdown). */
async function main() {
  const cfg = loadConfig();
  const db = await connectDb(cfg.databaseUrl);
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const chain = new Web3Chain(connection, cfg.priorityMicroLamports);
  const keeper = loadKeypair(cfg.keeperKeypairPath);
  const pump = new SdkPumpGateway(connection);

  const programConfig = await loadProgramConfig(chain);
  if (!programConfig.keeper.equals(keeper.publicKey)) throw new Error("KEEPER_KEYPAIR is not Config.keeper");
  log.info({ keeper: keeper.publicKey.toBase58() }, "payout worker started");

  let stopping = false;
  process.on("SIGTERM", () => (stopping = true));
  process.on("SIGINT", () => (stopping = true));

  while (!stopping) {
    const startAt = nextRoundAt(Date.now());
    await sleep(Math.max(0, startAt - Date.now()));
    if (stopping) break;
    const coins = await loadCoinKeys(db);
    const outcomes = await mapLimit(coins, cfg.payout.coinConcurrency, async (coin) => {
      try {
        return await runPayoutRound({ db, chain, keeper, pump, cfg: cfg.payout, log }, coin);
      } catch (err) {
        log.error({ mint: coin.mint.toBase58(), err: (err as Error).message }, "payout round failed");
        return { kind: "skipped" as const, reason: "error" };
      }
    });
    const paid = outcomes.filter((o) => o.kind === "paid").length;
    log.info({ roundAt: new Date(startAt).toISOString(), coins: coins.length, paid, tookMs: Date.now() - startAt }, "payout cycle done");
  }
  await db.close();
}

main().catch((err) => {
  log.fatal({ err: (err as Error).message }, "payout worker crashed");
  process.exit(1);
});
