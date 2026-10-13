use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::errors::HoldfastError;
use crate::events::CoinInitialized;
use crate::state::{CoinVault, Config};
use crate::treasury::rent_exempt_minimum;
use crate::venue::read_curve;

/// Registers a pump.fun coin whose creator is this program's treasury PDA. Runs right after
/// pump.fun `create_v2(creator = treasury)` in the launch flow.
#[derive(Accounts)]
pub struct InitCoin<'info> {
    #[account(mut)]
    pub launcher: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = launcher)]
    pub config: Account<'info, Config>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = launcher, space = 8 + CoinVault::INIT_SPACE, seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault: Box<Account<'info, CoinVault>>,
    #[account(mut, seeds = [TREASURY_SEED, mint.key().as_ref()], bump)]
    pub treasury: SystemAccount<'info>,
    /// CHECK: pump.fun bonding curve PDA of `mint`; contents validated in the handler.
    #[account(seeds = [b"bonding-curve", mint.key().as_ref()], bump, seeds::program = PUMP_PROGRAM_ID)]
    pub bonding_curve: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = launcher,
        associated_token::mint = mint,
        associated_token::authority = treasury,
        associated_token::token_program = token_program,
    )]
    pub treasury_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = launcher,
        associated_token::mint = wsol_mint,
        associated_token::authority = treasury,
        associated_token::token_program = wsol_token_program,
    )]
    pub treasury_wsol_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub wsol_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn init_coin(ctx: Context<InitCoin>, trigger_bps: u16) -> Result<()> {
    require!(TRIGGER_OPTIONS_BPS.contains(&trigger_bps), HoldfastError::InvalidTrigger);

    let curve = read_curve(&ctx.accounts.bonding_curve)?;
    require_keys_eq!(curve.creator, ctx.accounts.treasury.key(), HoldfastError::CreatorMismatch);
    require!(curve.sol_quoted, HoldfastError::UnsupportedQuote);
    require!(!curve.complete, HoldfastError::CurveComplete);

    // The treasury must stay rent-exempt; the launcher seeds it.
    let rent_min = rent_exempt_minimum()?;
    let treasury_lamports = ctx.accounts.treasury.lamports();
    if treasury_lamports < rent_min {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.launcher.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            rent_min - treasury_lamports,
        )?;
    }

    let now = Clock::get()?.unix_timestamp;
    let vault = &mut ctx.accounts.vault;
    vault.mint = ctx.accounts.mint.key();
    vault.token_program = ctx.accounts.token_program.key();
    vault.bonding_curve = ctx.accounts.bonding_curve.key();
    vault.trigger_bps = trigger_bps;
    vault.venue = VENUE_CURVE;
    vault.bump = ctx.bumps.vault;
    vault.treasury_bump = ctx.bumps.treasury;
    vault.created_at = now;

    emit!(CoinInitialized {
        mint: vault.mint,
        vault: vault.key(),
        treasury: ctx.accounts.treasury.key(),
        trigger_bps,
        bonding_curve: vault.bonding_curve,
        ts: now,
    });
    Ok(())
}
