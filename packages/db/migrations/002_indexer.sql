-- Holdfast schema v2: indexer bookkeeping and read-model helpers.

-- Per token-account balance mirror. The indexer compares each transaction's pre-balance with the
-- stored amount: a mismatch means history it never saw (e.g. a wallet-to-wallet transfer that
-- touched no indexed address) or out-of-order delivery. Lots are then reconciled instead of drifting.
CREATE TABLE IF NOT EXISTS token_accounts (
  address     text PRIMARY KEY,
  mint        text NOT NULL REFERENCES coins(mint),
  owner       text NOT NULL,
  amount      numeric(20,0) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  slot        bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS token_accounts_owner_idx ON token_accounts (mint, owner);

-- Spot price after the newest trade (bonding-curve virtual reserves or PumpSwap effective reserves),
-- so list endpoints never scan trades for the current price.
ALTER TABLE coins ADD COLUMN IF NOT EXISTS last_price double precision;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS last_trade_at timestamptz;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS last_trade_slot bigint NOT NULL DEFAULT 0;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS metadata_uri text;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS graduated_at timestamptz;

-- Open / close must follow chain order even when trades are indexed out of order.
ALTER TABLE price_candles ADD COLUMN IF NOT EXISTS open_slot bigint NOT NULL DEFAULT 0;
ALTER TABLE price_candles ADD COLUMN IF NOT EXISTS close_slot bigint NOT NULL DEFAULT 0;
ALTER TABLE price_candles ADD COLUMN IF NOT EXISTS trades integer NOT NULL DEFAULT 0;

-- One keeper transaction may defend more than one coin.
ALTER TABLE defends DROP CONSTRAINT IF EXISTS defends_pkey;
ALTER TABLE defends ADD PRIMARY KEY (sig, mint);

CREATE INDEX IF NOT EXISTS coins_bonding_curve_idx ON coins (bonding_curve);
CREATE INDEX IF NOT EXISTS coins_amm_pool_idx ON coins (amm_pool) WHERE amm_pool IS NOT NULL;
CREATE INDEX IF NOT EXISTS wallet_balances_wallet_idx ON wallet_balances (wallet);
CREATE INDEX IF NOT EXISTS lots_wallet_open_idx ON lots (wallet, mint) WHERE amount_remaining > 0;
CREATE INDEX IF NOT EXISTS payouts_mint_wallet_idx ON payouts (mint, wallet);
CREATE INDEX IF NOT EXISTS payout_rounds_ts_idx ON payout_rounds (ts DESC);
