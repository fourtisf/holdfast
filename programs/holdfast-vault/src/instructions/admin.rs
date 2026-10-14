use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::constants::*;
use crate::errors::HoldfastError;
use crate::program::HoldfastVault;
use crate::state::{Config, Params};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// Only the program's upgrade authority may create the config (prevents an init front-run).
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ HoldfastError::InvalidOwner)]
    pub program: Program<'info, HoldfastVault>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ HoldfastError::InvalidOwner)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn initialize(ctx: Context<Initialize>, keeper: Pubkey, launcher: Pubkey, params: Params) -> Result<()> {
    params.validate()?;
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.authority.key();
    config.pending_admin = Pubkey::default();
    config.keeper = keeper;
    config.launcher = launcher;
    config.hold_mint = Pubkey::default();
    config.platform_treasury = Pubkey::default();
    config.params = params;
    config.paused = false;
    config.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

pub fn set_keeper(ctx: Context<AdminOnly>, keeper: Pubkey) -> Result<()> {
    ctx.accounts.config.keeper = keeper;
    Ok(())
}

pub fn set_launcher(ctx: Context<AdminOnly>, launcher: Pubkey) -> Result<()> {
    ctx.accounts.config.launcher = launcher;
    Ok(())
}

pub fn set_params(ctx: Context<AdminOnly>, params: Params) -> Result<()> {
    params.validate()?;
    ctx.accounts.config.params = params;
    Ok(())
}

/// Where the platform share goes. Moves no funds itself; `sweep_platform_fees` pays only this address.
pub fn set_platform_treasury(ctx: Context<AdminOnly>, platform_treasury: Pubkey) -> Result<()> {
    require!(platform_treasury != Pubkey::default(), HoldfastError::PlatformTreasuryNotSet);
    ctx.accounts.config.platform_treasury = platform_treasury;
    Ok(())
}

pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    Ok(())
}

pub fn transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.config.pending_admin = new_admin;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require_keys_eq!(ctx.accounts.new_admin.key(), config.pending_admin, HoldfastError::NotPendingAdmin);
    config.admin = config.pending_admin;
    config.pending_admin = Pubkey::default();
    Ok(())
}

#[derive(Accounts)]
pub struct SetHoldMint<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub hold_mint: InterfaceAccount<'info, Mint>,
}

/// $HOLD can be set exactly once.
pub fn set_hold_mint(ctx: Context<SetHoldMint>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(config.hold_mint == Pubkey::default(), HoldfastError::HoldMintAlreadySet);
    config.hold_mint = ctx.accounts.hold_mint.key();
    Ok(())
}
