import { Connection } from "@solana/web3.js";
import { nextRoundAt } from "@holdfast/core";
import { connectDb } from "@holdfast/db";
import pino from "pino";

import { Web3Chain } from "./chain.js";
import { loadConfig, loadKeypair } from "./config.js";
import { loadProgramConfig } from "./crank.js";
import { Monitor, opsPort } from "./monitor.js";
import { runPayoutRound } from "./payout/worker.js";
import { loadCoinKeys, mapLimit, sleep } from "./util.js";

const log = pino({ name: "payout" });

/** Starts each payout cycle on the shared 2-minute wall-clock schedule (same as the API's countdown). */
async function main() {
  const cfg = loadConfig();
  const db = await connectDb(cfg.databaseUrl);
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const chain = new Web3Chain(connection, cfg.priorityMicroLamports);
  const keeper = loadKeypair(cfg.keeperKeypairPath);

  const programConfig = await loadProgramConfig(chain);
  if (!programConfig.keeper.equals(keeper.publicKey)) throw new Error("KEEPER_KEYPAIR is not Config.keeper");
  const monitor = new Monitor({ service: "payout", lowBalanceLamports: cfg.payout.keeperMinBalanceLamports * 2n, maxLoopAgeMs: 10 * 60_000 }, log);
  const ops = await monitor.start(opsPort(process.env, "PAYOUT_OPS_PORT", 9102));
  log.info({ keeper: keeper.publicKey.toBase58(), opsPort: ops?.port ?? null, alerts: monitor.alerter.enabled }, "payout worker started");

  let stopping = false;
  process.on("SIGTERM", () => (stopping = true));
  process.on("SIGINT", () => (stopping = true));

  while (!stopping) {
    const startAt = nextRoundAt(Date.now());
    await sleep(Math.max(0, startAt - Date.now()));
    if (stopping) break;
    const coins = await loadCoinKeys(db);
    const [keeperInfo] = await chain.getAccounts([keeper.publicKey]);
    await monitor.keeperBalance(BigInt(keeperInfo?.lamports ?? 0));
    const outcomes = await mapLimit(coins, cfg.payout.coinConcurrency, async (coin) => {
      const mint = coin.mint.toBase58();
      try {
        const outcome = await runPayoutRound({ db, chain, keeper, cfg: cfg.payout, log }, coin);
        await monitor.round(mint, outcome);
        return outcome;
      } catch (err) {
        log.error({ mint, err: (err as Error).message }, "payout round failed");
        await monitor.round(mint, { kind: "error", error: (err as Error).message });
        return { kind: "skipped" as const, reason: "error" };
      }
    });
    monitor.loopDone(coins.length);
    const paid = outcomes.filter((o) => o.kind === "paid").length;
    log.info({ roundAt: new Date(startAt).toISOString(), coins: coins.length, paid, tookMs: Date.now() - startAt }, "payout cycle done");
  }
  await ops?.close();
  await db.close();
}

main().catch((err) => {
  log.fatal({ err: (err as Error).message }, "payout worker crashed");
  process.exit(1);
});
