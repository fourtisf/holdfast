-- Holdfast schema v1. Amounts:
--   *_lamports / sol columns  : numeric(20,0) lamports (u64)
--   tokens / amount columns   : numeric(20,0) token base units (u64)
--   price columns             : double precision, SOL per whole token (display/analytics only;
--                               all payout math uses the exact integer columns)

CREATE TABLE IF NOT EXISTS coins (
  mint            text PRIMARY KEY,
  name            text NOT NULL,
  ticker          text NOT NULL,
  image_url       text,
  description     text NOT NULL DEFAULT '',
  socials         jsonb NOT NULL DEFAULT '{}'::jsonb,
  trigger_bps     smallint NOT NULL CHECK (trigger_bps IN (1500, 2500, 3500)),
  -- wallet that paid for the launch (deposit sender). Informational: it earns no fees.
  creator         text,
  vault           text NOT NULL,   -- CoinVault PDA ["vault", mint]
  treasury        text NOT NULL,   -- treasury PDA ["treasury", mint] = pump.fun creator
  bonding_curve   text NOT NULL,
  amm_pool        text,
  token_program   text NOT NULL,
  decimals        smallint NOT NULL DEFAULT 6,
  graduated       boolean NOT NULL DEFAULT false,
  launch_sig      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coins_created_at_idx ON coins (created_at DESC);
CREATE INDEX IF NOT EXISTS coins_search_idx ON coins (lower(name), lower(ticker));

-- Every swap on a Holdfast mint (curve, PumpSwap, or the vault's own buybacks).
CREATE TABLE IF NOT EXISTS trades (
  sig        text NOT NULL,
  ix_index   integer NOT NULL,        -- position of the trade event within the tx
  mint       text NOT NULL REFERENCES coins(mint),
  wallet     text NOT NULL,
  side       text NOT NULL CHECK (side IN ('buy', 'sell', 'vault')),
  sol        numeric(20,0) NOT NULL,  -- lamports (quote amount incl. fees as reported by the event)
  tokens     numeric(20,0) NOT NULL,
  price      double precision NOT NULL,
  ts         timestamptz NOT NULL,
  slot       bigint NOT NULL,
  source     text NOT NULL CHECK (source IN ('curve', 'pumpswap', 'vault')),
  PRIMARY KEY (sig, ix_index)
);
CREATE INDEX IF NOT EXISTS trades_mint_ts_idx ON trades (mint, ts DESC);
CREATE INDEX IF NOT EXISTS trades_wallet_idx ON trades (wallet, mint);

-- Purchase lots (FIFO). Only valid buy swaps create lots; transfers in never do.
CREATE TABLE IF NOT EXISTS lots (
  id                bigserial PRIMARY KEY,
  wallet            text NOT NULL,
  mint              text NOT NULL REFERENCES coins(mint),
  amount_initial    numeric(20,0) NOT NULL CHECK (amount_initial > 0),
  amount_remaining  numeric(20,0) NOT NULL CHECK (amount_remaining >= 0),
  acquired_at       timestamptz NOT NULL,
  source_sig        text NOT NULL,
  source_ix         integer NOT NULL DEFAULT 0,
  UNIQUE (source_sig, source_ix, wallet)
);
CREATE INDEX IF NOT EXISTS lots_open_idx ON lots (mint, wallet, acquired_at, id) WHERE amount_remaining > 0;

-- Per-wallet balance mirror, so a reduction can consume tokens that never earned (e.g. received by
-- transfer) before touching lots, and so holder counts are cheap. `untracked` = balance − Σ open lots.
CREATE TABLE IF NOT EXISTS wallet_balances (
  wallet     text NOT NULL,
  mint       text NOT NULL REFERENCES coins(mint),
  balance    numeric(20,0) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  untracked  numeric(20,0) NOT NULL DEFAULT 0 CHECK (untracked >= 0),
  updated_slot bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (mint, wallet)
);

CREATE TABLE IF NOT EXISTS price_candles (
  mint    text NOT NULL REFERENCES coins(mint),
  tf      text NOT NULL CHECK (tf IN ('1m', '5m', '15m', '1h')),
  ts      timestamptz NOT NULL,      -- bucket start
  open    double precision NOT NULL,
  high    double precision NOT NULL,
  low     double precision NOT NULL,
  close   double precision NOT NULL,
  volume  numeric(30,0) NOT NULL DEFAULT 0,   -- lamports
  PRIMARY KEY (mint, tf, ts)
);

-- Mirror of the on-chain CoinVault account (refreshed by the keeper/indexer).
CREATE TABLE IF NOT EXISTS vault_state (
  mint            text PRIMARY KEY REFERENCES coins(mint),
  floor_sol       numeric(20,0) NOT NULL DEFAULT 0,
  holder_sol      numeric(20,0) NOT NULL DEFAULT 0,
  burn_sol        numeric(20,0) NOT NULL DEFAULT 0,
  holder_tokens   numeric(20,0) NOT NULL DEFAULT 0,
  ath             numeric(40,0) NOT NULL DEFAULT 0,  -- on-chain fixed point (lamports/base unit × 1e18)
  floor           numeric(40,0) NOT NULL DEFAULT 0,
  defend_count    bigint NOT NULL DEFAULT 0,
  last_defend_ts  timestamptz,
  round_id        bigint NOT NULL DEFAULT 0,
  total_fees      numeric(20,0) NOT NULL DEFAULT 0,
  total_defended  numeric(20,0) NOT NULL DEFAULT 0,
  total_paid_sol  numeric(20,0) NOT NULL DEFAULT 0,
  total_paid_tokens numeric(20,0) NOT NULL DEFAULT 0,
  total_burned_sol numeric(20,0) NOT NULL DEFAULT 0,
  slot            bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Floor history, for the chart's floor line.
CREATE TABLE IF NOT EXISTS floor_history (
  mint   text NOT NULL REFERENCES coins(mint),
  ts     timestamptz NOT NULL,
  ath    numeric(40,0) NOT NULL,
  floor  numeric(40,0) NOT NULL,
  PRIMARY KEY (mint, ts)
);

CREATE TABLE IF NOT EXISTS defends (
  sig            text PRIMARY KEY,
  mint           text NOT NULL REFERENCES coins(mint),
  sol_spent      numeric(20,0) NOT NULL,
  tokens_bought  numeric(20,0) NOT NULL,
  price          double precision NOT NULL,
  ts             timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS defends_mint_ts_idx ON defends (mint, ts DESC);

CREATE TABLE IF NOT EXISTS payout_rounds (
  mint            text NOT NULL REFERENCES coins(mint),
  round_id        bigint NOT NULL,
  sol_pot         numeric(20,0) NOT NULL,   -- Σ SOL paid this round (committed on-chain)
  token_pot       numeric(20,0) NOT NULL,
  snapshot_hash   text NOT NULL,            -- merkle root (hex) committed in open_round
  snapshot_at     timestamptz NOT NULL,
  total_weight    numeric(60,0) NOT NULL,
  recipient_count integer NOT NULL,
  snapshot        jsonb NOT NULL,           -- public RoundSnapshot document
  status          text NOT NULL CHECK (status IN ('computed', 'opened', 'paying', 'closed', 'failed')),
  open_sig        text,
  close_sig       text,
  error           text,
  ts              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mint, round_id)
);

CREATE TABLE IF NOT EXISTS payouts (
  mint       text NOT NULL,
  round_id   bigint NOT NULL,
  idx        integer NOT NULL,              -- index in the round (on-chain bitmap position)
  wallet     text NOT NULL,
  sol        numeric(20,0) NOT NULL,
  tokens     numeric(20,0) NOT NULL,
  sig        text,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'confirmed', 'failed')),
  PRIMARY KEY (mint, round_id, idx),
  FOREIGN KEY (mint, round_id) REFERENCES payout_rounds (mint, round_id)
);
CREATE INDEX IF NOT EXISTS payouts_wallet_idx ON payouts (wallet, mint);

-- Owed amounts that were below the minimum (dust) or could not be delivered yet. Carried forward.
CREATE TABLE IF NOT EXISTS payout_carry (
  mint        text NOT NULL REFERENCES coins(mint),
  wallet      text NOT NULL,
  sol         numeric(20,0) NOT NULL DEFAULT 0,
  tokens      numeric(20,0) NOT NULL DEFAULT 0,
  since       timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mint, wallet)
);

-- Addresses that never earn (pools, bonding curves, program PDAs, deposit addresses, launcher...).
CREATE TABLE IF NOT EXISTS excluded_wallets (
  address  text PRIMARY KEY,
  reason   text NOT NULL
);

CREATE TABLE IF NOT EXISTS launches (
  id                 uuid PRIMARY KEY,
  status             text NOT NULL CHECK (status IN ('awaiting_deposit', 'deposit_received', 'creating', 'live',
                                                     'refunding', 'refunded', 'expired', 'failed')),
  form               jsonb NOT NULL,
  deposit_address    text NOT NULL UNIQUE,
  deposit_index      bigint NOT NULL UNIQUE,   -- HKDF derivation index of the deposit keypair
  required_lamports  numeric(20,0) NOT NULL,
  dev_buy_lamports   numeric(20,0) NOT NULL DEFAULT 0,
  received_lamports  numeric(20,0) NOT NULL DEFAULT 0,
  sender             text,
  deposit_sig        text,
  mint               text,
  mint_secret        text,                     -- encrypted mint keypair (needed until create lands)
  create_sig         text,
  refund_sig         text,
  error              text,
  attempts           integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS launches_status_idx ON launches (status, expires_at);
CREATE SEQUENCE IF NOT EXISTS launch_deposit_index_seq START 1;

-- Idempotent indexing.
CREATE TABLE IF NOT EXISTS processed_txs (
  sig          text PRIMARY KEY,
  slot         bigint NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS indexer_cursors (
  name        text PRIMARY KEY,
  last_sig    text,
  last_slot   bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
