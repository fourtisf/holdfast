use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::HoldfastError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Params {
    /// Minimum seconds between two `defend` steps of the same coin.
    pub defend_cooldown_secs: u32,
    /// Maximum `defend` steps per coin per rolling hour window.
    pub max_defends_per_hour: u16,
    /// How far above the floor the *effective* buyback price (fees included) may be.
    pub defend_price_tolerance_bps: u16,
    /// TWAP window used for the ATH.
    pub twap_window_secs: u32,
    /// Minimum spacing between two price observations.
    pub twap_min_sample_interval_secs: u32,
    /// Largest gap between observations inside a valid TWAP window.
    pub twap_max_gap_secs: u32,
    /// A higher TWAP must persist this long before it becomes the new ATH (0 = immediately).
    pub ath_confirm_secs: u32,
    /// Max slippage vs. spot for the $HOLD buy in `burn_hold`.
    pub max_burn_slippage_bps: u16,
    pub min_round_interval_secs: u32,
}

impl Params {
    pub fn validate(&self) -> Result<()> {
        let ok = (MIN_DEFEND_COOLDOWN_SECS..=MAX_DEFEND_COOLDOWN_SECS).contains(&self.defend_cooldown_secs)
            && (1..=MAX_DEFENDS_PER_HOUR).contains(&self.max_defends_per_hour)
            && self.defend_price_tolerance_bps <= MAX_DEFEND_PRICE_TOLERANCE_BPS
            && (MIN_TWAP_WINDOW_SECS..=MAX_TWAP_WINDOW_SECS).contains(&self.twap_window_secs)
            && self.twap_min_sample_interval_secs >= MIN_SAMPLE_INTERVAL_SECS
            // the observation ring must be able to span the whole window
            && (self.twap_min_sample_interval_secs as u64) * (MAX_OBSERVATIONS as u64 - 1) >= self.twap_window_secs as u64
            && self.twap_max_gap_secs >= self.twap_min_sample_interval_secs
            && self.twap_max_gap_secs <= self.twap_window_secs
            && self.ath_confirm_secs <= MAX_ATH_CONFIRM_SECS
            && self.max_burn_slippage_bps <= MAX_BURN_SLIPPAGE_BPS
            && self.min_round_interval_secs >= MIN_ROUND_INTERVAL_SECS;
        require!(ok, HoldfastError::InvalidParams);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    /// Cranks ATH updates, payout rounds and $HOLD burns.
    pub keeper: Pubkey,
    /// Backend wallet allowed to register coins (`init_coin`).
    pub launcher: Pubkey,
    /// $HOLD mint. Default key until set; immutable afterwards.
    pub hold_mint: Pubkey,
    pub params: Params,
    pub paused: bool,
    pub bump: u8,
    pub reserved: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct Observation {
    pub ts: i64,
    pub price: u128,
}

#[account]
#[derive(InitSpace)]
pub struct CoinVault {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub bonding_curve: Pubkey,
    /// Canonical PumpSwap pool once graduated (default key before).
    pub amm_pool: Pubkey,
    pub amm_pool_base_account: Pubkey,
    pub amm_pool_quote_account: Pubkey,
    /// 1500 / 2500 / 3500. Written once in `init_coin`; no instruction updates it.
    pub trigger_bps: u16,
    pub venue: u8,
    pub bump: u8,
    pub treasury_bump: u8,
    pub round_open: bool,

    pub ath_price: u128,
    pub floor_price: u128,
    pub ath_candidate: u128,
    pub ath_candidate_since: i64,

    /// Bucket accounting of the treasury's lamports (see invariant 2 in docs/program.md).
    pub floor_sol: u64,
    pub holder_sol: u64,
    pub burn_sol: u64,
    /// Bought-back tokens in the treasury token account, waiting for payout rounds.
    pub holder_tokens: u64,

    pub last_defend_ts: i64,
    pub defend_count: u64,
    pub hour_window_start: i64,
    pub hour_window_defends: u16,

    /// Last opened round id (0 = none yet).
    pub round_id: u64,
    pub last_round_ts: i64,

    pub obs_head: u8,
    pub obs_len: u8,
    pub observations: [Observation; MAX_OBSERVATIONS],

    pub total_fees: u64,
    pub total_defended_sol: u64,
    pub total_tokens_bought: u64,
    pub total_paid_sol: u64,
    pub total_paid_tokens: u64,
    pub total_burn_sol: u64,
    pub total_hold_burned: u64,
    pub created_at: i64,
    pub reserved: [u8; 64],
}

impl CoinVault {
    pub fn accounted_lamports(&self) -> Result<u64> {
        self.floor_sol
            .checked_add(self.holder_sol)
            .and_then(|v| v.checked_add(self.burn_sol))
            .ok_or_else(|| error!(HoldfastError::MathOverflow))
    }

    pub fn latest_observation(&self) -> Option<Observation> {
        if self.obs_len == 0 {
            return None;
        }
        let idx = (self.obs_head as usize + MAX_OBSERVATIONS - 1) % MAX_OBSERVATIONS;
        Some(self.observations[idx])
    }

    pub fn push_observation(&mut self, obs: Observation) {
        self.observations[self.obs_head as usize] = obs;
        self.obs_head = ((self.obs_head as usize + 1) % MAX_OBSERVATIONS) as u8;
        if (self.obs_len as usize) < MAX_OBSERVATIONS {
            self.obs_len += 1;
        }
    }

    /// Observations from newest to oldest.
    pub fn observations_newest_first(&self) -> impl Iterator<Item = Observation> + '_ {
        (0..self.obs_len as usize).map(move |i| {
            let idx = (self.obs_head as usize + MAX_OBSERVATIONS - 1 - i) % MAX_OBSERVATIONS;
            self.observations[idx]
        })
    }
}

#[account]
pub struct PayoutRound {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub round_id: u64,
    /// Paid the rent; receives it back on close.
    pub payer: Pubkey,
    pub sol_pot: u64,
    pub token_pot: u64,
    pub sol_paid: u64,
    pub token_paid: u64,
    /// Merkle root of the published payout snapshot (see docs/payouts.md).
    pub snapshot_hash: [u8; 32],
    pub recipient_count: u32,
    pub paid_count: u32,
    pub opened_at: i64,
    pub bump: u8,
    pub paid_bitmap: Vec<u8>,
}

impl PayoutRound {
    pub const FIXED_LEN: usize = 32 + 32 + 8 + 32 + 8 * 4 + 32 + 4 + 4 + 8 + 1 + 4;

    pub fn space(recipient_count: u32) -> usize {
        8 + Self::FIXED_LEN + Self::bitmap_len(recipient_count)
    }

    pub fn bitmap_len(recipient_count: u32) -> usize {
        (recipient_count as usize).div_ceil(8)
    }

    /// Marks `index` as paid; errors if it already was.
    pub fn mark_paid(&mut self, index: u32) -> Result<()> {
        require!(index < self.recipient_count, HoldfastError::RecipientIndexOutOfRange);
        let byte = &mut self.paid_bitmap[(index / 8) as usize];
        let bit = 1u8 << (index % 8);
        require!(*byte & bit == 0, HoldfastError::AlreadyPaid);
        *byte |= bit;
        Ok(())
    }
}
