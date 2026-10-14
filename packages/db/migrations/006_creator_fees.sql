-- Creator share of the fees (50 / 25 / 15 / 10 split): the unclaimed bucket and what the creator
-- has claimed so far, mirrored from the on-chain CoinVault.
ALTER TABLE vault_state ADD COLUMN IF NOT EXISTS creator_sol numeric(20,0) NOT NULL DEFAULT 0;
ALTER TABLE vault_state ADD COLUMN IF NOT EXISTS total_creator_claimed numeric(20,0) NOT NULL DEFAULT 0;
