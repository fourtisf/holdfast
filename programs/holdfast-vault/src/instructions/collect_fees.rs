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
/// donation) into the 40/25/15/10/10 buckets, and adds coin tokens sent to the treasury to the holder pool.
/// The treasury's token accounts are optional: they only exist once `prepare_treasury` ran (or someone
/// created one to send tokens), and a coin's first fees are booked without them.
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
    pub treasury_wsol_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(address = vault.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        associated_token::mint = mint,
        associated_token::authority = treasury,
        associated_token::token_program = token_program,
    )]
    pub treasury_token_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(address = vault.token_program_id())]
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

    let unwrapped_wsol = ctx.accounts.treasury_wsol_account.as_ref().map_or(0, |a| a.amount);
    if let Some(wsol) = ctx.accounts.treasury_wsol_account.as_ref().filter(|a| a.amount > 0) {
        let treasury = ctx.accounts.treasury.to_account_info();
        let wsol_account = wsol.to_account_info();
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
    let tokens = match ctx.accounts.treasury_token_account.as_ref() {
        Some(account) => {
            require!(account.amount >= vault.holder_tokens, HoldfastError::InvariantViolation);
            let tokens = account.amount - vault.holder_tokens;
            vault.holder_tokens = account.amount;
            tokens
        }
        None => 0,
    };

    let available = spendable_lamports(&ctx.accounts.treasury.to_account_info())?;
    let accounted = vault.accounted_lamports()?;
    require!(available >= accounted, HoldfastError::InvariantViolation);
    let amount = available - accounted;
    if amount == 0 && tokens == 0 {
        return Ok(());
    }

    let split = split_fees(amount);
    vault.floor_sol = vault.floor_sol.checked_add(split.floor).ok_or(HoldfastError::MathOverflow)?;
    vault.holder_sol = vault.holder_sol.checked_add(split.holder).ok_or(HoldfastError::MathOverflow)?;
    vault.creator_sol = vault.creator_sol.checked_add(split.creator).ok_or(HoldfastError::MathOverflow)?;
    vault.platform_sol = vault.platform_sol.checked_add(split.platform).ok_or(HoldfastError::MathOverflow)?;
    vault.burn_sol = vault.burn_sol.checked_add(split.burn).ok_or(HoldfastError::MathOverflow)?;
    vault.total_fees = vault.total_fees.saturating_add(amount);

    emit!(FeesCollected {
        mint,
        amount,
        floor: split.floor,
        holder: split.holder,
        creator: split.creator,
        platform: split.platform,
        burn: split.burn,
        unwrapped_wsol,
        tokens,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
