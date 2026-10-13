//! pump.fun bonding curve and PumpSwap pool access: reading spot prices straight from on-chain
//! reserves and executing buys by CPI.
//!
//! Layouts verified against the IDLs shipped in `@pump-fun/pump-sdk` 4.1.0 (see docs/pump-integration.md).
//! The buy CPIs pass the venue's account list through from `remaining_accounts` (so trailing accounts
//! pump.fun adds over time need no program upgrade) but the instruction data is built here and the
//! positions that matter to us are pinned.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::constants::*;
use crate::errors::HoldfastError;
use crate::math;

fn read_u64(data: &[u8], offset: usize) -> Result<u64> {
    let bytes: [u8; 8] = data
        .get(offset..offset + 8)
        .and_then(|s| s.try_into().ok())
        .ok_or(HoldfastError::InvalidAccountData)?;
    Ok(u64::from_le_bytes(bytes))
}

fn read_i128(data: &[u8], offset: usize) -> Option<i128> {
    data.get(offset..offset + 16).and_then(|s| s.try_into().ok()).map(i128::from_le_bytes)
}

fn read_pubkey(data: &[u8], offset: usize) -> Result<Pubkey> {
    let bytes: [u8; 32] = data
        .get(offset..offset + 32)
        .and_then(|s| s.try_into().ok())
        .ok_or(HoldfastError::InvalidAccountData)?;
    Ok(Pubkey::new_from_array(bytes))
}

// ---- bonding curve -------------------------------------------------------------------------------

/// pump `BondingCurve` (discriminator + fields; older accounts are shorter, trailing fields read as 0).
pub struct CurveState {
    pub virtual_token_reserves: u64,
    pub virtual_quote_reserves: u64,
    pub complete: bool,
    pub creator: Pubkey,
    pub sol_quoted: bool,
}

mod curve_offsets {
    pub const VIRTUAL_TOKEN: usize = 8;
    pub const VIRTUAL_QUOTE: usize = 16;
    pub const COMPLETE: usize = 48;
    pub const CREATOR: usize = 49;
    pub const QUOTE_MINT: usize = 83;
}

pub fn read_curve(info: &AccountInfo) -> Result<CurveState> {
    require_keys_eq!(*info.owner, PUMP_PROGRAM_ID, HoldfastError::InvalidOwner);
    let data = info.try_borrow_data()?;
    require!(data.len() >= curve_offsets::CREATOR + 32, HoldfastError::InvalidAccountData);
    require!(data[..8] == PUMP_BONDING_CURVE_DISCRIMINATOR, HoldfastError::InvalidAccountData);
    let sol_quoted = match data.get(curve_offsets::QUOTE_MINT..curve_offsets::QUOTE_MINT + 32) {
        None => true,
        Some(q) => q == [0u8; 32] || q == WSOL_MINT.as_ref(),
    };
    Ok(CurveState {
        virtual_token_reserves: read_u64(&data, curve_offsets::VIRTUAL_TOKEN)?,
        virtual_quote_reserves: read_u64(&data, curve_offsets::VIRTUAL_QUOTE)?,
        complete: data[curve_offsets::COMPLETE] != 0,
        creator: read_pubkey(&data, curve_offsets::CREATOR)?,
        sol_quoted,
    })
}

pub fn curve_price(curve: &CurveState) -> Result<u128> {
    math::price(curve.virtual_quote_reserves as u128, curve.virtual_token_reserves as u128)
        .ok_or_else(|| error!(HoldfastError::MathOverflow))
}

// ---- PumpSwap pool -------------------------------------------------------------------------------

pub struct PoolState {
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub pool_base_token_account: Pubkey,
    pub pool_quote_token_account: Pubkey,
    pub coin_creator: Pubkey,
    pub virtual_quote_reserves: i128,
}

mod pool_offsets {
    pub const BASE_MINT: usize = 43;
    pub const QUOTE_MINT: usize = 75;
    pub const POOL_BASE: usize = 139;
    pub const POOL_QUOTE: usize = 171;
    pub const COIN_CREATOR: usize = 211;
    pub const VIRTUAL_QUOTE: usize = 245;
}

pub fn read_pool(info: &AccountInfo) -> Result<PoolState> {
    require_keys_eq!(*info.owner, PUMP_AMM_PROGRAM_ID, HoldfastError::InvalidOwner);
    let data = info.try_borrow_data()?;
    require!(data.len() >= pool_offsets::COIN_CREATOR + 32, HoldfastError::InvalidAccountData);
    require!(data[..8] == PUMP_AMM_POOL_DISCRIMINATOR, HoldfastError::InvalidAccountData);
    Ok(PoolState {
        base_mint: read_pubkey(&data, pool_offsets::BASE_MINT)?,
        quote_mint: read_pubkey(&data, pool_offsets::QUOTE_MINT)?,
        pool_base_token_account: read_pubkey(&data, pool_offsets::POOL_BASE)?,
        pool_quote_token_account: read_pubkey(&data, pool_offsets::POOL_QUOTE)?,
        coin_creator: read_pubkey(&data, pool_offsets::COIN_CREATOR)?,
        virtual_quote_reserves: read_i128(&data, pool_offsets::VIRTUAL_QUOTE).unwrap_or(0),
    })
}

/// SPL Token / Token-2022 account: (mint, owner, amount). Checks the owning program.
pub fn read_token_account(info: &AccountInfo) -> Result<(Pubkey, Pubkey, u64)> {
    require!(
        *info.owner == anchor_spl::token::ID || *info.owner == anchor_spl::token_2022::ID,
        HoldfastError::InvalidOwner
    );
    let data = info.try_borrow_data()?;
    require!(data.len() >= 165, HoldfastError::InvalidAccountData);
    // state byte: 1 = initialized
    require!(data[108] == 1, HoldfastError::InvalidAccountData);
    Ok((read_pubkey(&data, 0)?, read_pubkey(&data, 32)?, read_u64(&data, 64)?))
}

/// Effective price = (quote balance + virtual_quote_reserves) / base balance. pump.fun guarantees the
/// signed sum is never negative.
pub fn pool_price(pool: &PoolState, base_account: &AccountInfo, quote_account: &AccountInfo) -> Result<u128> {
    require_keys_eq!(base_account.key(), pool.pool_base_token_account, HoldfastError::WrongPriceAccount);
    require_keys_eq!(quote_account.key(), pool.pool_quote_token_account, HoldfastError::WrongPriceAccount);
    let (_, _, base) = read_token_account(base_account)?;
    let (_, _, quote) = read_token_account(quote_account)?;
    let effective_quote = (quote as i128).checked_add(pool.virtual_quote_reserves).ok_or(HoldfastError::MathOverflow)?;
    require!(effective_quote > 0, HoldfastError::InvalidAccountData);
    math::price(effective_quote as u128, base as u128).ok_or_else(|| error!(HoldfastError::MathOverflow))
}

pub fn canonical_pool_address(mint: &Pubkey) -> Pubkey {
    let (pool_authority, _) = Pubkey::find_program_address(&[b"pool-authority", mint.as_ref()], &PUMP_PROGRAM_ID);
    let (pool, _) = Pubkey::find_program_address(
        &[b"pool", &0u16.to_le_bytes(), pool_authority.as_ref(), mint.as_ref(), WSOL_MINT.as_ref()],
        &PUMP_AMM_PROGRAM_ID,
    );
    pool
}

pub fn bonding_curve_address(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"bonding-curve", mint.as_ref()], &PUMP_PROGRAM_ID).0
}

/// Spot price for a venue given its price accounts.
pub fn spot_price(venue: u8, price_account: &AccountInfo, base: Option<&AccountInfo>, quote: Option<&AccountInfo>) -> Result<u128> {
    match venue {
        VENUE_CURVE => curve_price(&read_curve(price_account)?),
        VENUE_AMM => {
            let pool = read_pool(price_account)?;
            let (base, quote) = (base.ok_or(HoldfastError::WrongPriceAccount)?, quote.ok_or(HoldfastError::WrongPriceAccount)?);
            pool_price(&pool, base, quote)
        }
        _ => err!(HoldfastError::WrongVenue),
    }
}

// ---- buys ------------------------------------------------------------------------------------------

/// Expected identities of the accounts we pin inside a venue buy.
pub struct BuyTargets {
    pub mint: Pubkey,
    pub user: Pubkey,
    pub user_token_account: Pubkey,
    /// Curve: the bonding curve. AMM: the pool.
    pub market: Pubkey,
    /// AMM only: user WSOL account and the pool's token accounts.
    pub user_quote_account: Pubkey,
    pub pool_base_account: Pubkey,
    pub pool_quote_account: Pubkey,
}

fn key_at(accounts: &[AccountInfo], idx: usize) -> Result<Pubkey> {
    accounts.get(idx).map(|a| a.key()).ok_or_else(|| error!(HoldfastError::InvalidVenueAccounts))
}

pub fn validate_curve_buy_accounts(accounts: &[AccountInfo], t: &BuyTargets) -> Result<()> {
    use curve_buy_accounts as ix;
    require!(accounts.len() >= ix::MIN_LEN, HoldfastError::InvalidVenueAccounts);
    let ok = key_at(accounts, ix::MINT)? == t.mint
        && key_at(accounts, ix::BONDING_CURVE)? == t.market
        && key_at(accounts, ix::ASSOCIATED_USER)? == t.user_token_account
        && key_at(accounts, ix::USER)? == t.user
        && key_at(accounts, ix::PROGRAM)? == PUMP_PROGRAM_ID;
    require!(ok, HoldfastError::InvalidVenueAccounts);
    Ok(())
}

pub fn validate_amm_buy_accounts(accounts: &[AccountInfo], t: &BuyTargets) -> Result<()> {
    use amm_buy_accounts as ix;
    require!(accounts.len() >= ix::MIN_LEN, HoldfastError::InvalidVenueAccounts);
    let ok = key_at(accounts, ix::POOL)? == t.market
        && key_at(accounts, ix::USER)? == t.user
        && key_at(accounts, ix::BASE_MINT)? == t.mint
        && key_at(accounts, ix::QUOTE_MINT)? == WSOL_MINT
        && key_at(accounts, ix::USER_BASE_TOKEN_ACCOUNT)? == t.user_token_account
        && key_at(accounts, ix::USER_QUOTE_TOKEN_ACCOUNT)? == t.user_quote_account
        && key_at(accounts, ix::POOL_BASE_TOKEN_ACCOUNT)? == t.pool_base_account
        && key_at(accounts, ix::POOL_QUOTE_TOKEN_ACCOUNT)? == t.pool_quote_account
        && key_at(accounts, ix::PROGRAM)? == PUMP_AMM_PROGRAM_ID;
    require!(ok, HoldfastError::InvalidVenueAccounts);
    Ok(())
}

fn invoke_venue<'info>(program_id: Pubkey, accounts: &[AccountInfo<'info>], signer: &Pubkey, data: Vec<u8>, signer_seeds: &[&[u8]]) -> Result<()> {
    let metas = accounts
        .iter()
        .map(|a| AccountMeta {
            pubkey: a.key(),
            is_signer: a.key == signer || a.is_signer,
            is_writable: a.is_writable,
        })
        .collect();
    let ix = Instruction { program_id, accounts: metas, data };
    invoke_signed(&ix, accounts, &[signer_seeds])?;
    Ok(())
}

/// pump `buy_exact_sol_in(spendable_sol_in, min_tokens_out, track_volume = false, partial_fill = false)`.
pub fn cpi_curve_buy<'info>(accounts: &[AccountInfo<'info>], user: &Pubkey, signer_seeds: &[&[u8]], spendable: u64, min_out: u64) -> Result<()> {
    let mut data = Vec::with_capacity(26);
    data.extend_from_slice(&PUMP_BUY_EXACT_SOL_IN);
    data.extend_from_slice(&spendable.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    data.push(0); // track_volume: OptionBool(false)
    data.push(0); // partial_fill: OptionBool(false)
    invoke_venue(PUMP_PROGRAM_ID, accounts, user, data, signer_seeds)
}

/// pump_amm `buy_exact_quote_in(spendable_quote_in, min_base_amount_out, track_volume = false)`.
pub fn cpi_amm_buy<'info>(accounts: &[AccountInfo<'info>], user: &Pubkey, signer_seeds: &[&[u8]], spendable: u64, min_out: u64) -> Result<()> {
    let mut data = Vec::with_capacity(25);
    data.extend_from_slice(&PUMP_AMM_BUY_EXACT_QUOTE_IN);
    data.extend_from_slice(&spendable.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    data.push(0); // track_volume: OptionBool(false)
    invoke_venue(PUMP_AMM_PROGRAM_ID, accounts, user, data, signer_seeds)
}
