# Telegram notifier

`apps/notifier` (`@holdfast/notifier`) is a Telegram bot that tells holders what the protocol did for them: payouts
received every 2 minutes, floor-defence buybacks, graduations, and the moment a position's hold-time weight reaches
0.5x and full weight. It reads the same Postgres as the other services and listens on the `holdfast_events` NOTIFY
channel, so it needs no RPC and no keys, only a bot token.

```bash
TELEGRAM_BOT_TOKEN=123456:ABC... pnpm --filter @holdfast/notifier start
```

## Commands

| Command | What it does |
|---|---|
| `/start`, `/help` | What the bot does and the command list |
| `/watch <wallet>` | Payouts to that wallet, and its weight milestones |
| `/unwatch <wallet>` | Stop watching a wallet |
| `/coin <mint>` | Follow a coin: round results, floor defences, graduation. The coin must exist in `coins` |
| `/uncoin <mint>` | Unfollow a coin |
| `/list` | What this chat follows |
| `/stop` | Remove every subscription of this chat |

Addresses must be base58 Solana addresses (32 to 44 characters that decode to 32 bytes). `/watch` on a coin mint
points to `/coin` instead. A chat holds at most **20 subscriptions** (wallets and coins together). The bot works in
private chats, groups (commands only; `/cmd@OtherBot` is ignored) and channels where it is an admin. In a group
only admins add or remove the group's alerts (`/follow`, `/watch`, `/unfollow`, `/unwatch`, `/stop`, `/buybot`, the
alerts button).

## Events

| Trigger | Who gets it | Message |
|---|---|---|
| `round` notification, round status `closed` | each chat watching a wallet with a **confirmed** payout in the round (one message per wallet per round) | 💰 You earned X SOL (+ N TICKER) from $TICKER round #R, with a Solscan link to the payout transaction |
| same | coin followers | Round #R of $TICKER paid X SOL to N holders |
| `trade` notification whose trades in that transaction include `side = 'vault'` for the mint | coin followers | 🛡 Floor defended: the $TICKER vault bought back X SOL at price P, and the current floor |
| `coin` notification with `graduated = true` | coin followers | 🎓 $TICKER graduated to PumpSwap |
| weight sweep, every `NOTIFIER_MILESTONE_INTERVAL_MS` (10 min) | chats watching the wallet | the position reached 0.5x weight / full weight (1.0x) |

Every message links to the coin page (`WEB_URL/coin/<mint>`), and to Solscan when a transaction is known (the
`cluster` query follows `SOLANA_CLUSTER`). SOL amounts keep at most 4 significant decimals.

Weight milestones use `@holdfast/core` (`weightedAmount`): the average weight of a wallet's open lots in a coin,
`Σ amount × weight / Σ amount`, where each lot ramps linearly from 0.1x at purchase to 1.0x after 7 days. A
milestone counts as crossed when the average is at or above it now and was below it when the chat started watching
(lots bought later count at 0.1x then), so watching a wallet that already holds a full-weight position sends nothing.
When a sweep finds both milestones crossed (the notifier was down for days), only full weight is sent.

Not announced:

- Payouts that are pending, failed or carried to the next round; rounds with no confirmed payout.
- Events older than 24 hours (history re-indexed long after the fact).
- Events from more than 10 minutes before the chat subscribed (no graduation news for a coin followed after it
  graduated). Catch-up replays are stricter: only chats that were subscribed when the event happened get it.
- Excluded addresses (pools, PDAs): they hold no earning lots.

## Idempotency

Each message has an event key, and `tg_sent (chat_id, event_key)` records it **before** the send:

| Key | Message |
|---|---|
| `round:<mint>:<roundId>:<wallet>` | a payout |
| `round:<mint>:<roundId>:coin` | a round summary |
| `defend:<mint>:<sig>` | a floor defence |
| `graduated:<mint>` | a graduation |
| `weight:<wallet>:<mint>:<0.5 or 1.0>:<oldest open lot id>` | a weight milestone |
| `update:<update_id>` | the reply to a command |

A closed round is announced by both the payout worker and the indexer, catch-up replays recent events, and Telegram
redelivers updates whose offset was not stored yet. Each of these finds the claim and sends nothing, so restarts never
double-send. If Telegram refuses a send, the claim is released and a later replay of the same event may deliver it.
A request that timed out after Telegram had accepted it can be sent again by such a replay. If the bot was blocked or
removed from the chat (403, "chat not found"), the chat's subscriptions are deleted.

Milestone keys are anchored on the position's oldest open lot. Dipping below 0.5x after a large buy and climbing back
sends nothing new. Selling out and buying back starts a new position, which gets its own milestones.

The getUpdates offset lives in `tg_state` (`telegram_update_offset`), stored after each update. Claims older than
30 days are pruned daily, except milestone claims, which are kept.

On startup, and when its LISTEN connection to the database comes back after a drop, the notifier replays rounds
closed, vault buybacks, graduations, launch progress and burns from the last `NOTIFIER_CATCHUP_MS` (15 minutes), and
buys from the last 2 minutes (buy alerts are only posted while fresh), so a restart or a short outage loses nothing.
NOTIFYs sent while it was down for longer are not replayed.

A group gets at most 15 buy alerts a minute. A buy is claimed (`buy:<sig>:<index>`) before it takes one of those
slots, so a replay of buys already posted uses none. Buys over the limit keep their claim (a replay never posts them
late) and are counted in the group's next alert ("+N more buys since the last alert").

## End-to-end check

`pnpm --filter @holdfast/notifier e2e` runs the real API and notifier against a throwaway Postgres 16 cluster and a
fake Telegram Bot API, uses the bot like people do (launch wizard, buy bot and its per-minute limit, alerts, weight
milestones, burns, restarts, supergroup migrations) and prints a pass/fail table. It takes about a minute and a half,
most of it waiting out the buy limit's one-minute window. How it works and its options: the comment at the top of
`apps/notifier/e2e/run.ts`. It is not part of `pnpm test`.

## Schema

Migration `005_notifier.sql`: `tg_subscriptions (chat_id, kind 'wallet' | 'coin', target, created_at)`,
`tg_state (key, value)` and `tg_sent (chat_id, event_key, sent_at)`. Repository functions are in
`packages/db/src/repos/notifier.ts`.

## Configuration

| Variable | Default | |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | (required) | From @BotFather. One polling process per token |
| `DATABASE_URL` | (required) | The shared Postgres |
| `WEB_URL` | `PUBLIC_SITE_URL`, else `http://localhost:3000` | Coin links |
| `SOLANA_CLUSTER` | `mainnet-beta` | Solscan links: `mainnet-beta`, `devnet`, `testnet`, `localnet` |
| `NOTIFIER_OPS_PORT` | `9104` | `/healthz` and `/metrics`; `0` disables |
| `NOTIFIER_MILESTONE_INTERVAL_MS` | `600000` | Weight sweep interval |
| `NOTIFIER_POLL_TIMEOUT_SECS` | `30` | getUpdates long-poll timeout |
| `NOTIFIER_CATCHUP_MS` | `900000` | Replay window at startup and after a database reconnect; `0` disables |
| `NOTIFIER_MIGRATE` | `1` | `0` skips migrations at startup |
| `TELEGRAM_API_URL` | `https://api.telegram.org` | A self-hosted Bot API server |
| `LOG_LEVEL` | `info` | pino level |

## Operations

- **Health**: `GET :9104/healthz` is 200 while the last getUpdates call returned within the poll timeout + 60 s.
  docker-compose uses it as the container healthcheck.
- **Metrics** (`GET :9104/metrics`, prefix `holdfast_`): `notifier_messages_total{kind, result}` (result `sent`,
  `duplicate`, `failed`, `unavailable`; kind `payout`, `round`, `defend`, `graduated`, `milestone`),
  `notifier_commands_total{command}`, `notifier_events_total{kind}`, `notifier_errors_total{source}`,
  `notifier_subscriptions{kind}` and `loop_last_success_timestamp_seconds`.
- **Alerts** go through the shared `ALERT_*` settings (`@holdfast/ops`): a rejected token (401) is critical; another
  process polling the same bot (409) or polling that fails 3 times in a row is a warning.
- **Rate limits**: a 429 is retried after its `retry_after`, up to 3 times. Messages fan out one at a time, in order.
- **Shutdown**: SIGINT/SIGTERM stop the poll loop and the LISTEN, wait for queued fan-outs to finish, then close the
  ops server and the database.
- Run a single instance per bot token: Telegram gives updates to one poller only.
