use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::errors::HoldfastError;
use crate::events::HoldBurned;
use crate::math;
use crate::state::{CoinVault, Config};
use crate::swap::{execute_buy, BuyRequest};
use crate::treasury::{spendable_lamports, treasury_seeds, WsolAccounts};
use crate::venue::{self, BuyTargets};

/// Spends the coin's whole burn bucket on $HOLD and burns exactly what was bought, in one instruction.
/// `remaining_accounts` = the $HOLD venue buy accounts with the coin's treasury as `user`.
#[derive(Accounts)]
pub struct BurnHold<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = keeper, has_one = hold_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VAULT_SEED, vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, CoinVault>>,
    #[account(mut, seeds = [TREASURY_SEED, vault.mint.as_ref()], bump = vault.treasury_bump)]
    pub treasury: SystemAccount<'info>,
    #[account(mut, mint::token_program = hold_token_program)]
    pub hold_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = keeper,
        associated_token::mint = hold_mint,
        associated_token::authority = treasury,
        associated_token::token_program = hold_token_program,
    )]
    pub treasury_hold_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = treasury,
        associated_token::token_program = wsol_token_program,
    )]
    pub treasury_wsol_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: $HOLD bonding curve or canonical PumpSwap pool; validated in the handler.
    pub hold_price_account: UncheckedAccount<'info>,
    /// CHECK: pool base token account (PumpSwap venue only).
    pub pool_base_account: Option<UncheckedAccount<'info>>,
    /// CHECK: pool quote token account (PumpSwap venue only).
    pub pool_quote_account: Option<UncheckedAccount<'info>>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,
    pub hold_token_program: Interface<'info, TokenInterface>,
    pub wsol_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn burn_hold<'info>(ctx: Context<'_, '_, 'info, 'info, BurnHold<'info>>, venue: u8, min_hold_out: u64) -> Result<()> {
    let params = ctx.accounts.config.params;
    require!(!ctx.accounts.config.paused, HoldfastError::Paused);
    require!(ctx.accounts.config.hold_mint != Pubkey::default(), HoldfastError::HoldMintNotSet);

    let budget = ctx.accounts.vault.burn_sol;
    require!(budget >= MIN_BURN_LAMPORTS, HoldfastError::BurnBucketTooSmall);
    let hold_mint = ctx.accounts.hold_mint.key();

    // Locate and price the $HOLD market.
    let price_account = &ctx.accounts.hold_price_account;
    let base = ctx.accounts.pool_base_account.as_ref().map(|a| a.as_ref());
    let quote = ctx.accounts.pool_quote_account.as_ref().map(|a| a.as_ref());
    let (market, pool_base_account, pool_quote_account) = match venue {
        VENUE_CURVE => {
            require_keys_eq!(price_account.key(), venue::bonding_curve_address(&hold_mint), HoldfastError::WrongPriceAccount);
            let curve = venue::read_curve(price_account)?;
            require!(!curve.complete, HoldfastError::CurveComplete);
            require!(curve.sol_quoted, HoldfastError::UnsupportedQuote);
            (price_account.key(), Pubkey::default(), Pubkey::default())
        }
        VENUE_AMM => {
            require_keys_eq!(price_account.key(), venue::canonical_pool_address(&hold_mint), HoldfastError::NotCanonicalPool);
            let pool = venue::read_pool(price_account)?;
            require_keys_eq!(pool.base_mint, hold_mint, HoldfastError::NotCanonicalPool);
            require_keys_eq!(pool.quote_mint, WSOL_MINT, HoldfastError::UnsupportedQuote);
            (price_account.key(), pool.pool_base_token_account, pool.pool_quote_token_account)
        }
        _ => return err!(HoldfastError::WrongVenue),
    };
    let spot = venue::spot_price(venue, price_account, base, quote)?;
    let max_price = math::price_with_tolerance(spot, params.max_burn_slippage_bps).ok_or(HoldfastError::MathOverflow)?;
    let required_min = math::min_tokens_at_price(budget, max_price).ok_or(HoldfastError::MathOverflow)?.max(min_hold_out);

    let mint = ctx.accounts.vault.mint;
    let bump = [ctx.accounts.vault.treasury_bump];
    let seeds = treasury_seeds(&mint, &bump);
    let treasury = ctx.accounts.treasury.to_account_info();
    let hold_account = ctx.accounts.treasury_hold_account.to_account_info();
    let wsol_account = ctx.accounts.treasury_wsol_account.to_account_info();
    let wsol_mint = ctx.accounts.wsol_mint.to_account_info();
    let wsol_token_program = ctx.accounts.wsol_token_program.to_account_info();
    let ata_program = ctx.accounts.associated_token_program.to_account_info();
    let system_program = ctx.accounts.system_program.to_account_info();

    let outcome = execute_buy(&BuyRequest {
        venue,
        treasury: &treasury,
        token_account: &hold_account,
        wsol: WsolAccounts {
            treasury: &treasury,
            wsol_account: &wsol_account,
            wsol_mint: &wsol_mint,
            token_program: &wsol_token_program,
            associated_token_program: &ata_program,
            system_program: &system_program,
        },
        targets: BuyTargets {
            mint: hold_mint,
            user: treasury.key(),
            user_token_account: hold_account.key(),
            market,
            user_quote_account: wsol_account.key(),
            pool_base_account,
            pool_quote_account,
        },
        venue_accounts: ctx.remaining_accounts,
        seeds: &seeds,
        budget,
        min_out: required_min,
    })?;

    token_interface::burn(
        CpiContext::new_with_signer(
            ctx.accounts.hold_token_program.to_account_info(),
            Burn { mint: ctx.accounts.hold_mint.to_account_info(), from: hold_account.clone(), authority: treasury.clone() },
            &[&seeds],
        ),
        outcome.tokens_received,
    )?;

    let vault = &mut ctx.accounts.vault;
    vault.burn_sol = vault.burn_sol.checked_sub(outcome.sol_spent).ok_or(HoldfastError::OverspentSwap)?;
    vault.total_burn_sol = vault.total_burn_sol.saturating_add(outcome.sol_spent);
    require!(spendable_lamports(&treasury)? >= vault.accounted_lamports()?, HoldfastError::InvariantViolation);

    emit!(HoldBurned { mint, sol_spent: outcome.sol_spent, hold_burned: outcome.tokens_received, ts: Clock::get()?.unix_timestamp });
    Ok(())
}
