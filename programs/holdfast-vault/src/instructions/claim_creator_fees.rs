use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::HoldfastError;
use crate::events::CreatorFeesClaimed;
use crate::state::{CoinVault, Config};
use crate::treasury::{spendable_lamports, transfer_lamports, treasury_seeds};

/// The coin's creator (recorded once in `init_coin`) withdraws its whole share of the fees. This is
/// the only way SOL leaves a vault outside buybacks, payout rounds and $HOLD burns, and it can only
/// move the creator bucket, only to the creator, signed by the creator.
#[derive(Accounts)]
pub struct ClaimCreatorFees<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VAULT_SEED, vault.mint.as_ref()], bump = vault.bump, has_one = creator)]
    pub vault: Box<Account<'info, CoinVault>>,
    #[account(mut, seeds = [TREASURY_SEED, vault.mint.as_ref()], bump = vault.treasury_bump)]
    pub treasury: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
    require!(!ctx.accounts.config.paused, HoldfastError::Paused);
    let amount = ctx.accounts.vault.creator_sol;
    require!(amount > 0, HoldfastError::NothingToClaim);

    let mint = ctx.accounts.vault.mint;
    let bump = [ctx.accounts.vault.treasury_bump];
    let seeds = treasury_seeds(&mint, &bump);
    let treasury = ctx.accounts.treasury.to_account_info();
    transfer_lamports(&ctx.accounts.system_program.to_account_info(), &treasury, &ctx.accounts.creator.to_account_info(), &seeds, amount)?;

    let vault = &mut ctx.accounts.vault;
    vault.creator_sol = 0;
    vault.total_creator_claimed = vault.total_creator_claimed.saturating_add(amount);
    require!(spendable_lamports(&treasury)? >= vault.accounted_lamports()?, HoldfastError::InvariantViolation);

    emit!(CreatorFeesClaimed { mint, creator: vault.creator, amount, ts: Clock::get()?.unix_timestamp });
    Ok(())
}
