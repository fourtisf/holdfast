use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::HoldfastError;
use crate::events::PlatformFeesSwept;
use crate::state::{CoinVault, Config};
use crate::treasury::{spendable_lamports, transfer_lamports, treasury_seeds};

/// Permissionless. Sends the coin's whole platform bucket to `Config::platform_treasury`, the only
/// address it can pay; the caller only chooses when.
#[derive(Accounts)]
pub struct SweepPlatformFees<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = platform_treasury)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VAULT_SEED, vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, CoinVault>>,
    #[account(mut, seeds = [TREASURY_SEED, vault.mint.as_ref()], bump = vault.treasury_bump)]
    pub treasury: SystemAccount<'info>,
    /// CHECK: must equal `config.platform_treasury` (has_one); it only receives lamports.
    #[account(mut)]
    pub platform_treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn sweep_platform_fees(ctx: Context<SweepPlatformFees>) -> Result<()> {
    require!(!ctx.accounts.config.paused, HoldfastError::Paused);
    require!(ctx.accounts.config.platform_treasury != Pubkey::default(), HoldfastError::PlatformTreasuryNotSet);
    let amount = ctx.accounts.vault.platform_sol;
    require!(amount > 0, HoldfastError::NothingToSweep);

    let mint = ctx.accounts.vault.mint;
    let bump = [ctx.accounts.vault.treasury_bump];
    let seeds = treasury_seeds(&mint, &bump);
    let treasury = ctx.accounts.treasury.to_account_info();
    transfer_lamports(&ctx.accounts.system_program.to_account_info(), &treasury, &ctx.accounts.platform_treasury.to_account_info(), &seeds, amount)?;

    let vault = &mut ctx.accounts.vault;
    vault.platform_sol = 0;
    vault.total_platform_swept = vault.total_platform_swept.saturating_add(amount);
    require!(spendable_lamports(&treasury)? >= vault.accounted_lamports()?, HoldfastError::InvariantViolation);

    emit!(PlatformFeesSwept { mint, platform_treasury: ctx.accounts.platform_treasury.key(), amount, ts: Clock::get()?.unix_timestamp });
    Ok(())
}
