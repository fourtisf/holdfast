/** `pnpm --filter @holdfast/notifier start`: the Telegram bot. */
import { pino } from "pino";
import { connectDb, countSubscriptionsByKind, migrate, pruneSent } from "@holdfast/db";

import { HttpMoatpadApi } from "./api.js";
import { Bot, SerialQueue } from "./bot.js";
import { GROUP_COMMANDS, PRIVATE_COMMANDS } from "./commands.js";
import { loadConfig } from "./config.js";
import { LaunchFlow } from "./launch.js";
import { listenForEvents, MAX_EVENT_AGE_MS, Notifier } from "./events.js";
import { NotifierMonitor } from "./monitor.js";
import { Outbox } from "./outbox.js";
import { TelegramClient } from "./telegram.js";

/** Delivered-message claims are kept this long (milestone claims forever). */
const SENT_RETENTION_MS = Math.max(30 * 24 * 3600_000, 2 * MAX_EVENT_AGE_MS);
const PRUNE_EVERY_MS = 24 * 3600_000;

const config = loadConfig();
const log = pino({ level: config.logLevel, base: { service: "notifier" } });

const db = await connectDb(config.databaseUrl, { onError: (err) => log.error({ err }, "db error") });
if (config.migrate) await migrate(db, { log: (msg) => log.info(msg) });

const tg = new TelegramClient(config.botToken, { apiUrl: config.telegramApiUrl });
const me = await tg.getMe().catch((err: unknown) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "cannot reach Telegram with TELEGRAM_BOT_TOKEN (getMe failed)");
  return null;
});
if (!me) {
  await db.close();
  process.exit(1);
}

const monitor = new NotifierMonitor(log, { maxPollAgeMs: (config.pollTimeoutSec + 60) * 1000 });
const ops = await monitor.start(config.opsPort);
const links = { webUrl: config.webUrl, cluster: config.cluster, botUsername: me.username ?? null, moatCa: config.moatCa };
const api = new HttpMoatpadApi(config.apiUrl, { internalToken: config.internalApiToken });
const launch = new LaunchFlow({ db, api, tg, links, now: Date.now });
const outbox = new Outbox(db, tg, { metrics: monitor, log });
const notifier = new Notifier({ db, outbox, links, burnChatId: config.burnChatId, log, metrics: monitor });
const bot = new Bot({
  db,
  tg,
  commands: { db, links, now: Date.now, api, launch, tg },
  botUsername: me.username ?? null,
  pollTimeoutSec: config.pollTimeoutSec,
  metrics: monitor,
  log,
});
// The "/" menu Telegram shows next to the message box.
await Promise.all([tg.setMyCommands(PRIVATE_COMMANDS, "default"), tg.setMyCommands(GROUP_COMMANDS, "groups")]).catch((err: unknown) =>
  log.warn({ err: err instanceof Error ? err.message : String(err) }, "could not set the bot's command menu"),
);

// Events, catch-up and milestone sweeps run one at a time, in arrival order.
const queue = new SerialQueue((err) => {
  monitor.error("queue");
  log.error({ err: err instanceof Error ? err.message : String(err) }, "background task failed");
});
const catchUp = (reason: "startup" | "reconnect") =>
  queue.push(async () => {
    const sent = await notifier.catchUp(Date.now() - config.catchUpMs);
    if (sent > 0) log.info({ sent, windowMs: config.catchUpMs, reason }, "caught up on missed events");
  });
const unlisten = await listenForEvents(db, (n) => queue.push(() => notifier.handle(n)), {
  onReconnect: () => {
    log.warn("database notifications are back after a dropped connection; catching up");
    if (config.catchUpMs > 0) catchUp("reconnect");
  },
});

const sweep = () =>
  queue.push(async () => {
    const sent = await notifier.checkMilestones();
    monitor.setSubscriptions(await countSubscriptionsByKind(db));
    if (sent > 0) log.info({ sent }, "weight milestones sent");
  });
const prune = () =>
  queue.push(async () => {
    const removed = await pruneSent(db, Date.now() - SENT_RETENTION_MS, ["weight:"]);
    if (removed > 0) log.info({ removed }, "pruned old delivery records");
  });

if (config.catchUpMs > 0) catchUp("startup");
sweep();
prune();
const timers = [setInterval(sweep, config.milestoneIntervalMs), setInterval(prune, PRUNE_EVERY_MS)];

const abort = new AbortController();
const polling = bot.run(abort.signal);
log.info(
  {
    bot: me.username ?? me.id,
    webUrl: config.webUrl,
    apiUrl: config.apiUrl,
    perUserApiLimits: config.internalApiToken !== null,
    burnChat: config.burnChatId,
    cluster: config.cluster,
    opsPort: ops?.port ?? null,
    alerts: monitor.alerter.enabled,
    milestoneIntervalMs: config.milestoneIntervalMs,
  },
  "notifier started",
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  for (const t of timers) clearInterval(t);
  abort.abort();
  await unlisten().catch(() => {});
  await polling;
  await queue.idle();
  await ops?.close();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
