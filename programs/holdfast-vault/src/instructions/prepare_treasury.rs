use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use anchor_spl::associated_token::{self, get_associated_token_address_with_program_id, AssociatedToken};
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::constants::*;
use crate::errors::HoldfastError;
use crate::events::TreasuryPrepared;
use crate::state::CoinVault;
use crate::treasury::{spendable_lamports, treasury_seeds};

/// Permissionless. Creates what the treasury still lacks for buybacks and token payouts: its token
/// account for the coin, its WSOL account and, when the three `volume_*` accounts are passed, its
/// pump.fun or PumpSwap user volume accumulator. The treasury pays the rent out of the floor bucket,
/// so a launch only pays for the vault, and coins that never earn fees never pay for these accounts.
/// Allowed only once the floor bucket can still fund a buyback step afterwards.
#[derive(Accounts)]
pub struct PrepareTreasury<'info> {
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump = vault.bump, has_one = mint)]
    pub vault: Box<Account<'info, CoinVault>>,
    #[account(mut, seeds = [TREASURY_SEED, mint.key().as_ref()], bump = vault.treasury_bump)]
    pub treasury: SystemAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the treasury's ATA for the coin (address checked); created when missing.
    #[account(mut, address = get_associated_token_address_with_program_id(&treasury.key(), &mint.key(), &token_program.key()))]
    pub treasury_token_account: UncheckedAccount<'info>,
    /// CHECK: the treasury's WSOL ATA (address checked); created when missing.
    #[account(mut, address = get_associated_token_address_with_program_id(&treasury.key(), &WSOL_MINT, &wsol_token_program.key()))]
    pub treasury_wsol_account: UncheckedAccount<'info>,
    #[account(address = WSOL_MINT)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = vault.token_program_id())]
    pub token_program: Interface<'info, TokenInterface>,
    pub wsol_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: pump or pump_amm (key checked in the handler).
    pub volume_program: Option<UncheckedAccount<'info>>,
    /// CHECK: PDA `["user_volume_accumulator", treasury]` of `volume_program` (checked in the handler).
    #[account(mut)]
    pub user_volume_accumulator: Option<UncheckedAccount<'info>>,
    /// CHECK: PDA `["__event_authority"]` of `volume_program` (checked in the handler).
    pub volume_event_authority: Option<UncheckedAccount<'info>>,
}

pub fn prepare_treasury(ctx: Context<PrepareTreasury>) -> Result<()> {
    let mint = ctx.accounts.vault.mint;
    let bump = [ctx.accounts.vault.treasury_bump];
    let seeds = treasury_seeds(&mint, &bump);
    let treasury = ctx.accounts.treasury.to_account_info();
    let system = ctx.accounts.system_program.to_account_info();
    let before = treasury.lamports();
    // The floor bucket pays, and must still hold at least one minimum buyback step afterwards.
    let min_floor_after = MIN_DEFEND_LAMPORTS * BPS_DENOMINATOR / DEFEND_STEP_BPS;
    let missing = *ctx.accounts.treasury_token_account.owner == system_program::ID
        || *ctx.accounts.treasury_wsol_account.owner == system_program::ID
        || ctx.accounts.user_volume_accumulator.as_ref().is_some_and(|a| *a.owner == system_program::ID);
    require!(!missing || ctx.accounts.vault.floor_sol > min_floor_after, HoldfastError::FloorVaultTooSmall);

    let mut created_token_account = false;
    let mut created_wsol_account = false;
    for (account, account_mint, token_program, created) in [
        (
            ctx.accounts.treasury_token_account.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            &mut created_token_account,
        ),
        (
            ctx.accounts.treasury_wsol_account.to_account_info(),
            ctx.accounts.wsol_mint.to_account_info(),
            ctx.accounts.wsol_token_program.to_account_info(),
            &mut created_wsol_account,
        ),
    ] {
        if *account.owner != system_program::ID {
            continue; // already a token account (its address is the canonical ATA)
        }
        associated_token::create(CpiContext::new_with_signer(
            ctx.accounts.associated_token_program.to_account_info(),
            associated_token::Create {
                payer: treasury.clone(),
                associated_token: account,
                authority: treasury.clone(),
                mint: account_mint,
                system_program: system.clone(),
                token_program,
            },
            &[&seeds],
        ))?;
        *created = true;
    }

    let volume = (
        ctx.accounts.volume_program.as_ref(),
        ctx.accounts.user_volume_accumulator.as_ref(),
        ctx.accounts.volume_event_authority.as_ref(),
    );
    let created_accumulator = match volume {
        (None, None, None) => None,
        (Some(program), Some(accumulator), Some(event_authority)) => {
            let program_id = program.key();
            require!(program_id == PUMP_PROGRAM_ID || program_id == PUMP_AMM_PROGRAM_ID, HoldfastError::InvalidVolumeAccounts);
            let (expected_accumulator, _) = Pubkey::find_program_address(&[USER_VOLUME_ACCUMULATOR_SEED, treasury.key.as_ref()], &program_id);
            let (expected_authority, _) = Pubkey::find_program_address(&[EVENT_AUTHORITY_SEED], &program_id);
            require!(accumulator.key() == expected_accumulator && event_authority.key() == expected_authority, HoldfastError::InvalidVolumeAccounts);
            if *accumulator.owner == system_program::ID {
                let ix = Instruction {
                    program_id,
                    accounts: vec![
                        AccountMeta::new(treasury.key(), true),
                        AccountMeta::new_readonly(treasury.key(), false),
                        AccountMeta::new(accumulator.key(), false),
                        AccountMeta::new_readonly(system_program::ID, false),
                        AccountMeta::new_readonly(event_authority.key(), false),
                        AccountMeta::new_readonly(program_id, false),
                    ],
                    data: PUMP_INIT_USER_VOLUME_ACCUMULATOR.to_vec(),
                };
                invoke_signed(
                    &ix,
                    &[
                        treasury.clone(),
                        accumulator.to_account_info(),
                        system.clone(),
                        event_authority.to_account_info(),
                        program.to_account_info(),
                    ],
                    &[&seeds],
                )?;
                Some(program_id)
            } else {
                None
            }
        }
        _ => return err!(HoldfastError::InvalidVolumeAccounts),
    };

    let rent_paid = before.checked_sub(treasury.lamports()).ok_or(HoldfastError::InvariantViolation)?;
    if rent_paid == 0 {
        return Ok(());
    }
    let vault = &mut ctx.accounts.vault;
    require!(vault.floor_sol >= rent_paid.saturating_add(min_floor_after), HoldfastError::FloorVaultTooSmall);
    vault.floor_sol -= rent_paid;
    vault.total_treasury_rent = vault.total_treasury_rent.saturating_add(rent_paid);
    require!(spendable_lamports(&treasury)? >= vault.accounted_lamports()?, HoldfastError::InvariantViolation);

    emit!(TreasuryPrepared {
        mint,
        rent_paid,
        token_account: created_token_account,
        wsol_account: created_wsol_account,
        volume_accumulator_program: created_accumulator.unwrap_or_default(),
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
