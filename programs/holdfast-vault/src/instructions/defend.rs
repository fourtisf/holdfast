use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::errors::HoldfastError;
use crate::events::Defended;
use crate::instructions::price::vault_spot_price;
use crate::math;
use crate::state::{CoinVault, Config};
use crate::swap::{execute_buy, BuyRequest};
use crate::treasury::{spendable_lamports, treasury_seeds, WsolAccounts};
use crate::venue::BuyTargets;

/// Permissionless floor defence. `remaining_accounts` = the venue buy instruction's accounts
/// (pump `buy_exact_sol_in` before graduation, PumpSwap `buy_exact_quote_in` after) with the
/// treasury as `user`.
#[derive(Accounts)]
pub struct Defend<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump = vault.bump, has_one = mint)]
    pub vault: Box<Account<'info, CoinVault>>,
    #[account(mut, seeds = [TREASURY_SEED, mint.key().as_ref()], bump = vault.treasury_bump)]
    pub treasury: SystemAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = treasury,
        associated_token::token_program = token_program,
    )]
    pub treasury_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = treasury,
        associated_token::token_program = wsol_token_program,
    )]
    pub treasury_wsol_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: bonding curve or PumpSwap pool, checked against the vault.
    pub price_account: UncheckedAccount<'info>,
    /// CHECK: pool base token account (PumpSwap venue only).
    pub pool_base_account: Option<UncheckedAccount<'info>>,
    /// CHECK: pool quote token account (PumpSwap venue only).
    pub pool_quote_account: Option<UncheckedAccount<'info>>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = vault.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    pub wsol_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn defend<'info>(ctx: Context<'_, '_, 'info, 'info, Defend<'info>>, min_tokens_out: u64) -> Result<()> {
    let params = ctx.accounts.config.params;
    require!(!ctx.accounts.config.paused, HoldfastError::Paused);
    let now = Clock::get()?.unix_timestamp;

    let vault = &ctx.accounts.vault;
    require!(vault.floor_price > 0, HoldfastError::NoFloor);
    if vault.defend_count > 0 {
        require!(now - vault.last_defend_ts >= params.defend_cooldown_secs as i64, HoldfastError::DefendCooldown);
    }
    let (window_start, window_defends) =
        if now - vault.hour_window_start >= 3_600 { (now, 0) } else { (vault.hour_window_start, vault.hour_window_defends) };
    require!(window_defends < params.max_defends_per_hour, HoldfastError::DefendHourlyLimit);

    let spot = vault_spot_price(
        vault,
        &ctx.accounts.price_account,
        ctx.accounts.pool_base_account.as_ref().map(|a| a.as_ref()),
        ctx.accounts.pool_quote_account.as_ref().map(|a| a.as_ref()),
    )?;
    require!(spot <= vault.floor_price, HoldfastError::PriceAboveFloor);

    let budget = math::bps_of(vault.floor_sol, DEFEND_STEP_BPS);
    require!(budget >= MIN_DEFEND_LAMPORTS, HoldfastError::FloorVaultTooSmall);
    // Never pay more than floor × (1 + tolerance) per token, whatever the caller asks for.
    let max_price = math::price_with_tolerance(vault.floor_price, params.defend_price_tolerance_bps).ok_or(HoldfastError::MathOverflow)?;
    let required_min = math::min_tokens_at_price(budget, max_price).ok_or(HoldfastError::MathOverflow)?.max(min_tokens_out);

    let mint = vault.mint;
    let venue = vault.venue;
    let targets = BuyTargets {
        mint,
        user: ctx.accounts.treasury.key(),
        user_token_account: ctx.accounts.treasury_token_account.key(),
        market: if venue == VENUE_CURVE { vault.bonding_curve } else { vault.amm_pool },
        user_quote_account: ctx.accounts.treasury_wsol_account.key(),
        pool_base_account: vault.amm_pool_base_account,
        pool_quote_account: vault.amm_pool_quote_account,
    };

    let bump = [vault.treasury_bump];
    let seeds = treasury_seeds(&mint, &bump);
    let treasury = ctx.accounts.treasury.to_account_info();
    let token_account = ctx.accounts.treasury_token_account.to_account_info();
    let wsol_account = ctx.accounts.treasury_wsol_account.to_account_info();
    let wsol_mint = ctx.accounts.wsol_mint.to_account_info();
    let wsol_token_program = ctx.accounts.wsol_token_program.to_account_info();
    let ata_program = ctx.accounts.associated_token_program.to_account_info();
    let system_program = ctx.accounts.system_program.to_account_info();

    let outcome = execute_buy(&BuyRequest {
        venue,
        treasury: &treasury,
        token_account: &token_account,
        wsol: WsolAccounts {
            treasury: &treasury,
            wsol_account: &wsol_account,
            wsol_mint: &wsol_mint,
            token_program: &wsol_token_program,
            associated_token_program: &ata_program,
            system_program: &system_program,
        },
        targets,
        venue_accounts: ctx.remaining_accounts,
        seeds: &seeds,
        budget,
        min_out: required_min,
    })?;

    // Re-check the price cap on what was really spent (includes any venue rent).
    let min_for_spent = math::min_tokens_at_price(outcome.sol_spent, max_price).ok_or(HoldfastError::MathOverflow)?;
    require!(outcome.tokens_received >= min_for_spent, HoldfastError::SlippageExceeded);

    let vault = &mut ctx.accounts.vault;
    vault.floor_sol = vault.floor_sol.checked_sub(outcome.sol_spent).ok_or(HoldfastError::OverspentSwap)?;
    vault.holder_tokens = vault.holder_tokens.checked_add(outcome.tokens_received).ok_or(HoldfastError::MathOverflow)?;
    vault.total_defended_sol = vault.total_defended_sol.saturating_add(outcome.sol_spent);
    vault.total_tokens_bought = vault.total_tokens_bought.saturating_add(outcome.tokens_received);
    vault.last_defend_ts = now;
    vault.defend_count += 1;
    vault.hour_window_start = window_start;
    vault.hour_window_defends = window_defends + 1;
    require!(spendable_lamports(&treasury)? >= vault.accounted_lamports()?, HoldfastError::InvariantViolation);

    emit!(Defended {
        mint,
        sol_spent: outcome.sol_spent,
        tokens_bought: outcome.tokens_received,
        spot_price: spot,
        floor_price: vault.floor_price,
        venue,
        ts: now,
    });
    Ok(())
}
