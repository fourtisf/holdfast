-- Platform (Moatpad treasury) share of the fees (40 / 25 / 15 / 10 / 10 split): the unswept bucket and
-- what was swept to the platform treasury so far, mirrored from the on-chain CoinVault.
ALTER TABLE vault_state ADD COLUMN IF NOT EXISTS platform_sol numeric(20,0) NOT NULL DEFAULT 0;
ALTER TABLE vault_state ADD COLUMN IF NOT EXISTS total_platform_swept numeric(20,0) NOT NULL DEFAULT 0;
