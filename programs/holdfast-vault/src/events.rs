use anchor_lang::prelude::*;

#[event]
pub struct CoinInitialized {
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub treasury: Pubkey,
    pub creator: Pubkey,
    pub trigger_bps: u16,
    pub bonding_curve: Pubkey,
    pub ts: i64,
}

#[event]
pub struct FeesCollected {
    pub mint: Pubkey,
    pub amount: u64,
    pub floor: u64,
    pub holder: u64,
    pub creator: u64,
    pub platform: u64,
    pub burn: u64,
    pub unwrapped_wsol: u64,
    /// Coin tokens added to the holder pool (sent to the treasury outside buybacks).
    pub tokens: u64,
    pub ts: i64,
}

#[event]
pub struct AthUpdated {
    pub mint: Pubkey,
    pub twap: u128,
    pub ath: u128,
    pub floor: u128,
    pub ts: i64,
}

#[event]
pub struct Graduated {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub coin_creator: Pubkey,
    pub ts: i64,
}

#[event]
pub struct Defended {
    pub mint: Pubkey,
    pub sol_spent: u64,
    pub tokens_bought: u64,
    pub spot_price: u128,
    pub floor_price: u128,
    pub venue: u8,
    pub ts: i64,
}

#[event]
pub struct RoundOpened {
    pub mint: Pubkey,
    pub round_id: u64,
    pub sol_pot: u64,
    pub token_pot: u64,
    pub snapshot_hash: [u8; 32],
    pub recipient_count: u32,
    pub ts: i64,
}

#[event]
pub struct PayoutBatch {
    pub mint: Pubkey,
    pub round_id: u64,
    pub recipients: u32,
    pub sol: u64,
    pub tokens: u64,
    pub ts: i64,
}

#[event]
pub struct RoundClosed {
    pub mint: Pubkey,
    pub round_id: u64,
    pub sol_paid: u64,
    pub tokens_paid: u64,
    pub ts: i64,
}

#[event]
pub struct HoldBurned {
    pub mint: Pubkey,
    pub sol_spent: u64,
    pub hold_burned: u64,
    pub ts: i64,
}

#[event]
pub struct TreasuryPrepared {
    pub mint: Pubkey,
    /// Lamports the treasury paid from the floor bucket.
    pub rent_paid: u64,
    pub token_account: bool,
    pub wsol_account: bool,
    /// pump or pump_amm program whose volume accumulator was created (default key: none).
    pub volume_accumulator_program: Pubkey,
    pub ts: i64,
}

#[event]
pub struct CreatorFeesClaimed {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
    pub ts: i64,
}

#[event]
pub struct PlatformFeesSwept {
    pub mint: Pubkey,
    pub platform_treasury: Pubkey,
    pub amount: u64,
    pub ts: i64,
}
