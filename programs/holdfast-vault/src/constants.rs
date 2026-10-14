use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const TREASURY_SEED: &[u8] = b"treasury";
pub const ROUND_SEED: &[u8] = b"round";

pub const BPS_DENOMINATOR: u64 = 10_000;

/// Creator-fee split. The creator's share accrues in the vault and only the creator recorded at
/// `init_coin` can claim it (`claim_creator_fees`). The platform's share accrues too and can only be
/// swept to `Config::platform_treasury` (`sweep_platform_fees`).
pub const SPLIT_FLOOR_BPS: u64 = 4_000;
pub const SPLIT_HOLDER_BPS: u64 = 2_500;
pub const SPLIT_CREATOR_BPS: u64 = 1_500;
pub const SPLIT_PLATFORM_BPS: u64 = 1_000;
pub const SPLIT_BURN_BPS: u64 = 1_000;

/// floor = ATH × (1 − trigger). Fixed at launch.
pub const TRIGGER_OPTIONS_BPS: [u16; 3] = [1_500, 2_500, 3_500];

/// Each defend step spends 10% of the floor bucket.
pub const DEFEND_STEP_BPS: u64 = 1_000;
pub const MIN_DEFEND_LAMPORTS: u64 = 1_000_000;
/// Lamports a venue may charge the treasury on top of the swap budget, for accounts it creates on
/// first use (e.g. pump.fun's user volume accumulator). Charged to the floor bucket.
pub const DEFEND_RENT_ALLOWANCE: u64 = 10_000_000;
pub const MIN_BURN_LAMPORTS: u64 = 10_000_000;

/// Prices: lamports per token base unit × 1e18.
pub const PRICE_SCALE: u128 = 1_000_000_000_000_000_000;

/// TWAP ring size. 16 slots keep `CoinVault` small (launch rent); the default 600 s window needs
/// samples at least 40 s apart (`twap_min_sample_interval_secs × 15 ≥ twap_window_secs`).
pub const MAX_OBSERVATIONS: usize = 16;
pub const MAX_RECIPIENTS_PER_ROUND: u32 = 8_192;

// Parameter bounds (Config::params). The admin can tune within these, never outside.
pub const MIN_DEFEND_COOLDOWN_SECS: u32 = 30;
pub const MAX_DEFEND_COOLDOWN_SECS: u32 = 86_400;
pub const MAX_DEFENDS_PER_HOUR: u16 = 60;
pub const MAX_DEFEND_PRICE_TOLERANCE_BPS: u16 = 1_000;
pub const MIN_TWAP_WINDOW_SECS: u32 = 120;
pub const MAX_TWAP_WINDOW_SECS: u32 = 3_600;
pub const MIN_SAMPLE_INTERVAL_SECS: u32 = 10;
pub const MAX_ATH_CONFIRM_SECS: u32 = 3_600;
pub const MAX_BURN_SLIPPAGE_BPS: u16 = 2_000;
pub const MIN_ROUND_INTERVAL_SECS: u32 = 60;

pub const VENUE_CURVE: u8 = 0;
pub const VENUE_AMM: u8 = 1;

// ---- external programs (verified against @pump-fun/pump-sdk 4.1.0 IDLs) ------------------------
pub const PUMP_PROGRAM_ID: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const PUMP_AMM_PROGRAM_ID: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// pump `buy_exact_sol_in(spendable_sol_in: u64, min_tokens_out: u64, track_volume: OptionBool, partial_fill: OptionBool)`
pub const PUMP_BUY_EXACT_SOL_IN: [u8; 8] = [56, 252, 116, 8, 158, 223, 205, 95];
/// pump_amm `buy_exact_quote_in(spendable_quote_in: u64, min_base_amount_out: u64, track_volume: OptionBool)`
pub const PUMP_AMM_BUY_EXACT_QUOTE_IN: [u8; 8] = [198, 46, 21, 82, 180, 217, 232, 112];
pub const PUMP_BONDING_CURVE_DISCRIMINATOR: [u8; 8] = [23, 183, 248, 55, 96, 216, 172, 96];
pub const PUMP_AMM_POOL_DISCRIMINATOR: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
/// `init_user_volume_accumulator()` (same discriminator and accounts in pump and pump_amm):
/// payer (signer, mut), user, user_volume_accumulator (mut), system_program, event_authority, program.
pub const PUMP_INIT_USER_VOLUME_ACCUMULATOR: [u8; 8] = [94, 6, 202, 115, 255, 96, 232, 183];
pub const USER_VOLUME_ACCUMULATOR_SEED: &[u8] = b"user_volume_accumulator";
pub const EVENT_AUTHORITY_SEED: &[u8] = b"__event_authority";

/// Account positions inside the venue instructions (IDL order). Only these are checked on-chain;
/// every other account is validated by pump.fun itself.
pub mod curve_buy_accounts {
    pub const MINT: usize = 2;
    pub const BONDING_CURVE: usize = 3;
    pub const ASSOCIATED_USER: usize = 5;
    pub const USER: usize = 6;
    pub const PROGRAM: usize = 11;
    pub const MIN_LEN: usize = 16;
}

pub mod amm_buy_accounts {
    pub const POOL: usize = 0;
    pub const USER: usize = 1;
    pub const BASE_MINT: usize = 3;
    pub const QUOTE_MINT: usize = 4;
    pub const USER_BASE_TOKEN_ACCOUNT: usize = 5;
    pub const USER_QUOTE_TOKEN_ACCOUNT: usize = 6;
    pub const POOL_BASE_TOKEN_ACCOUNT: usize = 7;
    pub const POOL_QUOTE_TOKEN_ACCOUNT: usize = 8;
    pub const PROGRAM: usize = 16;
    pub const MIN_LEN: usize = 23;
}
