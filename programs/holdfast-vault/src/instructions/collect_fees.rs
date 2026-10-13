use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::errors::HoldfastError;
use crate::events::FeesCollected;
use crate::math::split_fees;
use crate::state::CoinVault;
use crate::treasury::{spendable_lamports, treasury_seeds, unwrap_wsol, WsolAccounts};

/// Permissionless. Books every lamport that reached the treasury since the last call (pump.fun creator
/// fees claimed by the keeper's `collect_creator_fee_v2` / PumpSwap `collect_coin_creator_fee`, or any
/// donation) into the 60/30/10 buckets, and adds coin tokens sent to the treasury to the holder pool.
#[derive(Accounts)]
pub struct CollectFees<'info> {
    #[account(mut, seeds = [VAULT_SEED, vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, CoinVault>>,
    #[account(mut, seeds = [TREASURY_SEED, vault.mint.as_ref()], bump = vault.treasury_bump)]
    pub treasury: SystemAccount<'info>,
    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = treasury,
        associated_token::token_program = wsol_token_program,
    )]
    pub treasury_wsol_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = vault.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        associated_token::mint = mint,
        associated_token::authority = treasury,
        associated_token::token_program = token_program,
    )]
    pub treasury_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = vault.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,
    pub wsol_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn collect_fees(ctx: Context<CollectFees>) -> Result<()> {
    let mint = ctx.accounts.vault.mint;
    let bump = [ctx.accounts.vault.treasury_bump];
    let seeds = treasury_seeds(&mint, &bump);

    let unwrapped_wsol = ctx.accounts.treasury_wsol_account.amount;
    if unwrapped_wsol > 0 {
        let treasury = ctx.accounts.treasury.to_account_info();
        let wsol_account = ctx.accounts.treasury_wsol_account.to_account_info();
        let wsol_mint = ctx.accounts.wsol_mint.to_account_info();
        let token_program = ctx.accounts.wsol_token_program.to_account_info();
        let ata_program = ctx.accounts.associated_token_program.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();
        unwrap_wsol(
            &WsolAccounts {
                treasury: &treasury,
                wsol_account: &wsol_account,
                wsol_mint: &wsol_mint,
                token_program: &token_program,
                associated_token_program: &ata_program,
                system_program: &system_program,
            },
            &seeds,
        )?;
    }

    let vault = &mut ctx.accounts.vault;
    // Coin tokens that reached the treasury other than through a buyback (e.g. a donation) join the holder pool.
    let token_balance = ctx.accounts.treasury_token_account.amount;
    require!(token_balance >= vault.holder_tokens, HoldfastError::InvariantViolation);
    let tokens = token_balance - vault.holder_tokens;
    vault.holder_tokens = token_balance;

    let available = spendable_lamports(&ctx.accounts.treasury.to_account_info())?;
    let accounted = vault.accounted_lamports()?;
    require!(available >= accounted, HoldfastError::InvariantViolation);
    let amount = available - accounted;
    if amount == 0 && tokens == 0 {
        return Ok(());
    }

    let (floor, holder, burn) = split_fees(amount);
    vault.floor_sol = vault.floor_sol.checked_add(floor).ok_or(HoldfastError::MathOverflow)?;
    vault.holder_sol = vault.holder_sol.checked_add(holder).ok_or(HoldfastError::MathOverflow)?;
    vault.burn_sol = vault.burn_sol.checked_add(burn).ok_or(HoldfastError::MathOverflow)?;
    vault.total_fees = vault.total_fees.saturating_add(amount);

    emit!(FeesCollected { mint, amount, floor, holder, burn, unwrapped_wsol, tokens, ts: Clock::get()?.unix_timestamp });
    Ok(())
}
