//! Treasury PDA helpers: the system-owned account that holds a coin's SOL and signs its swaps.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token;
use anchor_spl::token;
use solana_curve25519::edwards::{validate_edwards, PodEdwardsPoint};

use crate::constants::*;
use crate::errors::HoldfastError;

pub fn treasury_seeds<'a>(mint: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
    [TREASURY_SEED, mint.as_ref(), bump]
}

pub fn transfer_lamports<'info>(
    system_program: &AccountInfo<'info>,
    treasury: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    seeds: &[&[u8]],
    lamports: u64,
) -> Result<()> {
    system_program::transfer(
        CpiContext::new_with_signer(
            system_program.clone(),
            system_program::Transfer { from: treasury.clone(), to: to.clone() },
            &[seeds],
        ),
        lamports,
    )
}

/// Accounts needed to unwrap the treasury's WSOL account in place (close it, then re-create it so it
/// is always there to receive PumpSwap creator fees and defend wraps).
pub struct WsolAccounts<'a, 'info> {
    pub treasury: &'a AccountInfo<'info>,
    pub wsol_account: &'a AccountInfo<'info>,
    pub wsol_mint: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub associated_token_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
}

/// Closes the WSOL account into the treasury (all lamports: rent + wrapped amount) and re-creates
/// it paid by the treasury. Net effect on the treasury: + wrapped amount.
pub fn unwrap_wsol(a: &WsolAccounts, seeds: &[&[u8]]) -> Result<()> {
    token::close_account(CpiContext::new_with_signer(
        a.token_program.clone(),
        token::CloseAccount {
            account: a.wsol_account.clone(),
            destination: a.treasury.clone(),
            authority: a.treasury.clone(),
        },
        &[seeds],
    ))?;
    associated_token::create(CpiContext::new_with_signer(
        a.associated_token_program.clone(),
        associated_token::Create {
            payer: a.treasury.clone(),
            associated_token: a.wsol_account.clone(),
            authority: a.treasury.clone(),
            mint: a.wsol_mint.clone(),
            system_program: a.system_program.clone(),
            token_program: a.token_program.clone(),
        },
        &[seeds],
    ))
}

/// Moves `lamports` from the treasury into its WSOL account and syncs the wrapped balance.
pub fn wrap_sol(a: &WsolAccounts, seeds: &[&[u8]], lamports: u64) -> Result<()> {
    transfer_lamports(a.system_program, a.treasury, a.wsol_account, seeds, lamports)?;
    token::sync_native(CpiContext::new(a.token_program.clone(), token::SyncNative { account: a.wsol_account.clone() }))
}

/// SPL token amount at offset 64 (works for Token and Token-2022 base layout).
pub fn token_amount(info: &AccountInfo) -> Result<u64> {
    let data = info.try_borrow_data()?;
    let bytes: [u8; 8] = data.get(64..72).and_then(|s| s.try_into().ok()).ok_or(HoldfastError::InvalidAccountData)?;
    Ok(u64::from_le_bytes(bytes))
}

/// A "regular wallet": system-owned, no data, not executable, and an ed25519 point (PDAs are off-curve,
/// so pools, program vaults and other PDAs can never receive payouts).
pub fn is_regular_wallet(info: &AccountInfo) -> bool {
    *info.owner == system_program::ID && info.data_is_empty() && !info.executable && is_on_curve(info.key)
}

fn is_on_curve(key: &Pubkey) -> bool {
    validate_edwards(&PodEdwardsPoint(key.to_bytes()))
}

pub fn rent_exempt_minimum() -> Result<u64> {
    Ok(Rent::get()?.minimum_balance(0))
}

/// Lamports above the treasury's own rent reserve.
pub fn spendable_lamports(treasury: &AccountInfo) -> Result<u64> {
    treasury
        .lamports()
        .checked_sub(rent_exempt_minimum()?)
        .ok_or_else(|| error!(HoldfastError::InvariantViolation))
}
