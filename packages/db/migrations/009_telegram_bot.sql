-- Holdfast schema v9: the Telegram launch bot, the group buy bot and $MOATPAD burns.

-- A launch being filled in step by step in a private chat (/launch). One per chat; `data` holds the
-- answers so far (name, ticker, imageUrl, ...), `step` the question being asked.
CREATE TABLE IF NOT EXISTS tg_drafts (
  chat_id     bigint PRIMARY KEY,
  user_id     bigint NOT NULL,
  step        text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Launches created from Telegram: which chat hears about their progress (deposit received, live, refunded).
CREATE TABLE IF NOT EXISTS tg_launches (
  launch_id   text PRIMARY KEY,
  chat_id     bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Group buy bot: a group posts every buy of one coin (at least min_lamports).
CREATE TABLE IF NOT EXISTS tg_buybots (
  chat_id       bigint PRIMARY KEY,
  mint          text NOT NULL,
  min_lamports  numeric(20, 0) NOT NULL DEFAULT 0,
  created_by    bigint,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tg_buybots_mint_idx ON tg_buybots (mint);

-- $MOATPAD bought and burned by a coin's vault (burn_hold, the 10% buy & burn share).
CREATE TABLE IF NOT EXISTS hold_burns (
  sig          text NOT NULL,
  mint         text NOT NULL,
  sol_spent    numeric(20, 0) NOT NULL,
  hold_burned  numeric(30, 0) NOT NULL,
  ts           timestamptz NOT NULL,
  PRIMARY KEY (sig, mint)
);
CREATE INDEX IF NOT EXISTS hold_burns_ts_idx ON hold_burns (ts DESC);
