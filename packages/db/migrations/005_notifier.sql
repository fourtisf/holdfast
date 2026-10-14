-- Holdfast schema v5: Telegram notifier (apps/notifier).

-- What each Telegram chat follows: a wallet (its payouts and weight milestones) or a coin (round
-- results, floor defences, graduation). `target` is the base58 wallet address or mint.
CREATE TABLE IF NOT EXISTS tg_subscriptions (
  chat_id     bigint NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('wallet', 'coin')),
  target      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, kind, target)
);
CREATE INDEX IF NOT EXISTS tg_subscriptions_target_idx ON tg_subscriptions (kind, target);

-- Small key/value store for the bot (the getUpdates offset).
CREATE TABLE IF NOT EXISTS tg_state (
  key    text PRIMARY KEY,
  value  text NOT NULL
);

-- One row per message delivered (or being delivered): a chat never gets the same event twice,
-- across restarts and repeated NOTIFYs. Keys look like `round:<mint>:<roundId>:<wallet>`.
CREATE TABLE IF NOT EXISTS tg_sent (
  chat_id    bigint NOT NULL,
  event_key  text NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, event_key)
);
