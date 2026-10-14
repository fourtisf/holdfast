-- Holdfast schema v4: launchpad features (graduation progress, comments, leaderboards, portfolio).

-- Bonding-curve real token reserves after the newest curve trade: graduation progress =
-- 1 − real_token_reserves / initial_real_token_reserves (pump.fun Global, 793.1M tokens).
ALTER TABLE coins ADD COLUMN IF NOT EXISTS curve_real_token_reserves numeric(20,0);

-- Wallet-signed comments on a coin. The signature covers mint, body and timestamp (see
-- @holdfast/core comments.ts), so nobody can post in someone else's name.
CREATE TABLE IF NOT EXISTS comments (
  id             bigserial PRIMARY KEY,
  mint           text NOT NULL REFERENCES coins(mint),
  wallet         text NOT NULL,
  body           text NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  reply_to       bigint REFERENCES comments(id),
  signed_at      timestamptz NOT NULL,
  signature      text NOT NULL UNIQUE,
  hidden         boolean NOT NULL DEFAULT false,
  hidden_reason  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_mint_idx ON comments (mint, id DESC);
CREATE INDEX IF NOT EXISTS comments_wallet_idx ON comments (wallet, created_at DESC);

CREATE INDEX IF NOT EXISTS trades_wallet_ts_idx ON trades (wallet, ts DESC);
CREATE INDEX IF NOT EXISTS payouts_wallet_confirmed_idx ON payouts (wallet) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS coins_creator_idx ON coins (creator);
