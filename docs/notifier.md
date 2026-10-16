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
| `/start`, `/help` | What the bot does and the command list (`/start` also takes the website's deep links) |
| `/launch` | Launch a coin, one question at a time, paid with one SOL transfer (private chat only) |
| `/cancel` | Stop the launch being filled in |
| `/coin <mint>` | The coin's card: market cap, volume, holders, floor vault, payouts, with an alerts button. It does not follow the coin |
| `/trending` | The top coins right now |
| `/burns` | $MOATPAD bought and burned so far |
| `/buybot [<mint> [min SOL] \| off]` | In a group: post every buy of a Moatpad coin there (admins only). In a private chat: how to set it up |
| `/follow <mint>` | Follow a coin: round results, floor defences, graduation. The coin must exist in `coins` |
| `/unfollow <mint>` | Unfollow a coin (`/uncoin` still works) |
| `/watch <wallet>` | Payouts to that wallet, and its weight milestones |
| `/unwatch <wallet>` | Stop watching a wallet |
| `/alerts` | What this chat follows, and how to turn it off (`/list` still works) |
| `/stop` | Remove every subscription of this chat, and its buy bot |

Addresses must be base58 Solana addresses (32 to 44 characters that decode to 32 bytes). `/watch` on a coin mint
points to `/follow` instead. A chat holds at most **20 subscriptions** (wallets and coins together). The bot works in
private chats, groups (commands only; `/cmd@OtherBot` is ignored) and channels where it is an admin. In a group
only admins add or remove the group's alerts (`/follow`, `/watch`, `/unfollow`, `/unwatch`, `/stop`, `/buybot`, the
alerts button). In a forum (topics) supergroup the bot answers in the topic of the command, `/buybot` posts the
coin's buys and floor defences in the topic it was sent in, and `/follow` and `/watch` alerts go to the topic they were
sent in (sent again from another topic, they move there). When a topic is deleted, what posted there goes to the
General topic.

A chat gets at most 20 replies a minute in a group (Telegram's own limit for a bot), and a private chat at most 3 in
any 3 seconds and 20 a minute, well under Telegram's limit of about one message a second there; past that, commands
and button presses there are not answered (a button gets a short toast) until the budget allows again. The bot handles
updates one at a time, so a reply never waits out a Telegram flood wait (429): Telegram refusing one, however briefly,
drops it at once, and no other chat waits behind a flooded one. Other bots' commands in a group (`/price`, which a bot
that is an admin or posted last receives too) are ignored and use up none of those replies.
When the API is down, a command gets "Moatpad is not reachable right now" instead of no answer. While launches are
paused (`LAUNCHES_PAUSED`), `/launch` says so before the first question.

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
| `weight:<wallet>:<mint>:<0.5 or 1.0>:<lot id>` | a weight milestone (claimed for every open lot of the position) |
| `buy:<sig>:<wallet>` | a buy alert (one per buying wallet and transaction; a claim under the older `buy:<sig>:<instruction index>` of one of its parts counts too, so a buy posted just before an upgrade is not posted again) |
| `launch:<launchId>:<stage>` | launch progress (`underpaid:<lamports received>` while a short deposit can still be topped up) |
| `burn:<sig>:<mint>` | a $MOATPAD burn |
| `update:<update_id>` | the reply to a command |

A closed round is announced by both the payout worker and the indexer, catch-up replays recent events, and Telegram
redelivers updates whose offset was not stored yet. Each of these finds the claim and sends nothing, so restarts never
double-send. If Telegram refuses a send (or it never reached Telegram), the claim is released. When a later attempt
may get through (no connection could be made, a flood wait, an error on Telegram's side), the notifier remembers that
delivery (the chat, the key and the event, at most 1,000 of them) and once a minute makes it again, and only it: the
event is handled again for just that chat and key. A run makes at most 50, the least recently failed first, and stops
at the first one that fails again (it goes last), so an outage holds up the event queue for one send a minute at most;
a chat still in a flood wait is left for a later run. When handling the event again fails (the database, or data that
changed since), that delivery goes last too, so the other failed deliveries are retried in the next run. A delivery is
retried until it gets through, so an outage in which Telegram cannot be reached loses nothing while the notifier keeps
running, for up to 24 hours (older events are never announced). Other refusals (400 "message is too long", ...) would
only fail again and are not retried; a failed weight milestone is sent by the next sweep. A send that got no answer
after it went out (a timeout, a connection cut, a gateway's 504) may have been posted: it keeps its claim and is never
sent again, by a retry or a catch-up, so such a message can be lost but is never doubled (it ends a retry run too). If
the bot was blocked or removed (403, "chat not found"), the chat's subscriptions and buy bot are deleted; so are they
when the bot is muted (its `my_chat_member` update says "restricted" without the right to send messages) or banned.
`NOTIFIER_BURN_CHAT_ID` is the exception: there it is a setup error, logged at error level, and the claim is released.
A group that lets nobody post for now ("not enough rights to send ...", as when a night-mode bot makes the group
admins-only overnight) and a closed forum topic (`TOPIC_CLOSED`, often only for a while) cost only that message: it is
not retried, and the group keeps its buy bot and alerts. A deleted topic ("message thread not found") moves the buy
bot and the subscriptions that posted there to the General topic, and the message is sent there.

A milestone counts as announced while any open lot of the position holds its claim, and announcing it claims it for
every open lot. A sell that uses up the oldest lot (FIFO) therefore announces nothing again, and dipping below 0.5x
after a large buy and climbing back sends nothing new. Selling out and buying back starts a new position (all new
lots), which gets its own milestones.

The getUpdates offset lives in `tg_state` (`telegram_update_offset`), stored after each update. Claims older than
30 days are pruned daily, except milestone claims, which are kept.

On startup, and when its LISTEN connection to the database comes back after a drop, the notifier replays rounds
closed, vault buybacks, graduations, launch progress and burns from the last `NOTIFIER_CATCHUP_MS` (15 minutes), and
buys from the last 2 minutes (buy alerts are only posted while fresh), so a restart or a short outage loses nothing.
NOTIFYs sent while it was down for longer are not replayed.

A group gets at most 15 buy alerts a minute, and floor defences posted there count against them. A buy is one
wallet's buys in one transaction (a buy split into several instructions is summed; a wallet that also sold the coin in
that transaction, like a bump bot, is not announced). It is claimed (`buy:<sig>:<wallet>`) before it takes one of those
slots, so a replay of buys already posted uses none. Buys over the limit keep their claim (a replay never posts them
late) and are counted in the group's next alert ("+N more buys since the last alert"); so are buys for a group that
is in a Telegram flood wait.

## End-to-end check

`pnpm --filter @holdfast/notifier e2e` runs the real API and notifier against a throwaway Postgres 16 cluster and a
fake Telegram Bot API, uses the bot like people do (launch wizard, buy bot and its per-minute limit, alerts, weight
milestones, burns, restarts, supergroup migrations) and prints a pass/fail table. It takes about a minute and a half,
most of it waiting out the buy limit's one-minute window. How it works and its options: the comment at the top of
`apps/notifier/e2e/run.ts`. It is not part of `pnpm test`.

## Schema

Migration `005_notifier.sql`: `tg_subscriptions (chat_id, kind 'wallet' | 'coin', target, created_at)`,
`tg_state (key, value)` and `tg_sent (chat_id, event_key, sent_at)`. Migration `009_telegram_bot.sql` adds the launch
drafts, `tg_launches`, `tg_buybots` and `hold_burns`; `010_telegram_topics.sql` gives `tg_buybots` and
`tg_subscriptions` their forum topic (`thread_id`). Repository functions are in `packages/db/src/repos/notifier.ts` and `telegram.ts`.

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
| `NOTIFIER_PRIVATE_REPLIES_PER_MINUTE` | `20` | Replies a minute in one private chat |
| `NOTIFIER_PRIVATE_REPLY_BURST` | `3` | Replies in any 3 seconds in one private chat (Telegram allows about one a second) |
| `NOTIFIER_CATCHUP_MS` | `900000` | Replay window at startup and after a database reconnect; `0` disables |
| `NOTIFIER_MIGRATE` | `1` | `0` skips migrations at startup |
| `NOTIFIER_BURN_CHAT_ID` | (none) | Channel or group for the $MOATPAD burn feed; checked at startup (the bot must be able to post there) |
| `NEXT_PUBLIC_TELEGRAM_BOT` | (none) | The bot the website links to; the notifier warns when it is not this bot |
| `TELEGRAM_API_URL` | `https://api.telegram.org` | A self-hosted Bot API server, as an absolute http(s) URL |
| `LOG_LEVEL` | `info` | pino level |

## Operations

- **Health**: `GET :9104/healthz` is 200 while the last getUpdates call returned within the poll timeout + 60 s.
  docker-compose uses it as the container healthcheck.
- **Metrics** (`GET :9104/metrics`, prefix `holdfast_`): `notifier_messages_total{kind, result}` (result `sent`,
  `duplicate`, `failed`, `flooded`, `topic_closed`, `no_rights` (the group lets nobody post for now), `unavailable`,
  `stopped` (not started: shutting down); kind
  `payout`, `round`, `defend`, `graduated`, `milestone`, `buy`, `launch`, `burn`),
  `notifier_commands_total{command}`, `notifier_events_total{kind}`, `notifier_errors_total{source}`,
  `notifier_subscriptions{kind}` and `loop_last_success_timestamp_seconds`.
- **Alerts** go through the shared `ALERT_*` settings (`@holdfast/ops`): a rejected token (401) is critical; another
  process polling the same bot (409) or polling that fails 3 times in a row is a warning, resolved once polling has
  been clean for 5 minutes. A burn chat the bot cannot post in is a warning at startup (`burn_chat`).
- **Rate limits**: the update loop never waits out a 429 (a command reply, a button answer, an admin check or an
  image download is given up at once). An alert's 429 with a `retry_after` of up to 5 s is waited out (up to 3 times);
  a longer one is not: the alert is given up at once (it is retried once the wait is over, a buy alert is counted in
  the group's next one). Either way, sends to that chat fail at once until the wait is over. The update loop and the
  event queue each handle one thing at a time, so no chat can make them wait long. Messages fan out one at a time, in order.
- **Shutdown**: SIGINT/SIGTERM stop the poll loop (the rest of a batch of updates is left for Telegram to deliver
  again) and the LISTEN. Queued tasks that have not started are dropped (the next start's catch-up replays the events
  of the last `NOTIFIER_CATCHUP_MS`), no new message is started, and a flood wait is not waited out any more. The poll and the task in progress
  get 20 seconds (docker's `stop_grace_period` is 30), then the ops server and the database are closed.
- Run a single instance per bot token: Telegram gives updates to one poller only.
