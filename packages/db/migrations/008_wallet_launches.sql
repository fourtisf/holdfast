-- Launches signed by the creator's own wallet: the launcher builds the one-transaction launch with the
-- wallet as fee payer and co-signs it (mint + launcher); the wallet signs and sends it. A row waits here
-- until the coin's vault exists on-chain (then the coin is registered with the form's details) or until
-- it expires (the wallet never sent it, or the blockhash ran out).
CREATE TABLE IF NOT EXISTS wallet_launches (
  mint        text PRIMARY KEY,
  wallet      text NOT NULL,
  form        jsonb NOT NULL,
  uri         text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'live', 'expired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS wallet_launches_status_idx ON wallet_launches (status, expires_at);
