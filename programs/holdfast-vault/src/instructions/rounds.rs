use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::errors::HoldfastError;
use crate::events::{PayoutBatch, RoundClosed, RoundOpened};
use crate::state::{CoinVault, Config, PayoutRound};
use crate::treasury::{is_regular_wallet, rent_exempt_minimum, spendable_lamports, transfer_lamports, treasury_seeds};
use crate::venue::read_token_account;

#[derive(Accounts)]
#[instruction(round_id: u64, sol_pot: u64, token_pot: u64, snapshot_hash: [u8; 32], recipient_count: u32)]
pub struct OpenRound<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = keeper)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VAULT_SEED, vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, CoinVault>>,
    #[account(
        init,
        payer = keeper,
        space = PayoutRound::space(recipient_count),
        seeds = [ROUND_SEED, vault.mint.as_ref(), &round_id.to_le_bytes()],
        bump,
    )]
    pub round: Box<Account<'info, PayoutRound>>,
    pub system_program: Program<'info, System>,
}

/// Commits a round: the pot (≤ the holder buckets right now) and the merkle root of the published
/// snapshot. Payouts of this round can never exceed the committed pot.
pub fn open_round(ctx: Context<OpenRound>, round_id: u64, sol_pot: u64, token_pot: u64, snapshot_hash: [u8; 32], recipient_count: u32) -> Result<()> {
    let params = ctx.accounts.config.params;
    require!(!ctx.accounts.config.paused, HoldfastError::Paused);
    let vault = &mut ctx.accounts.vault;
    require!(!vault.round_open, HoldfastError::RoundAlreadyOpen);
    require!(round_id == vault.round_id + 1, HoldfastError::InvalidRoundId);
    require!((1..=MAX_RECIPIENTS_PER_ROUND).contains(&recipient_count), HoldfastError::InvalidRecipientCount);
    require!(sol_pot <= vault.holder_sol && token_pot <= vault.holder_tokens, HoldfastError::PotExceedsBucket);

    let now = Clock::get()?.unix_timestamp;
    if vault.round_id > 0 {
        require!(now - vault.last_round_ts >= params.min_round_interval_secs as i64, HoldfastError::RoundTooSoon);
    }
    vault.round_id = round_id;
    vault.round_open = true;
    vault.last_round_ts = now;

    let round = &mut ctx.accounts.round;
    round.vault = vault.key();
    round.mint = vault.mint;
    round.round_id = round_id;
    round.payer = ctx.accounts.keeper.key();
    round.sol_pot = sol_pot;
    round.token_pot = token_pot;
    round.snapshot_hash = snapshot_hash;
    round.recipient_count = recipient_count;
    round.opened_at = now;
    round.bump = ctx.bumps.round;
    round.paid_bitmap = vec![0u8; PayoutRound::bitmap_len(recipient_count)];

    emit!(RoundOpened { mint: vault.mint, round_id, sol_pot, token_pot, snapshot_hash, recipient_count, ts: now });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct PayoutEntry {
    /// Position in the published snapshot (bitmap index).
    pub index: u32,
    pub sol: u64,
    pub tokens: u64,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct Payout<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = keeper)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump = vault.bump, has_one = mint)]
    pub vault: Box<Account<'info, CoinVault>>,
    #[account(mut, seeds = [ROUND_SEED, mint.key().as_ref(), &round_id.to_le_bytes()], bump = round.bump, has_one = vault)]
    pub round: Box<Account<'info, PayoutRound>>,
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
    #[account(address = vault.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Pays a batch of a round. `remaining_accounts`, per entry in order: the wallet, then — only if
/// `tokens > 0` — the wallet's token account for the mint. Recipients must be regular wallets.
pub fn payout<'info>(ctx: Context<'_, '_, 'info, 'info, Payout<'info>>, round_id: u64, entries: Vec<PayoutEntry>) -> Result<()> {
    require!(!ctx.accounts.config.paused, HoldfastError::Paused);
    require!(ctx.accounts.vault.round_open && ctx.accounts.vault.round_id == round_id, HoldfastError::RoundNotOpen);

    let mint = ctx.accounts.vault.mint;
    let bump = [ctx.accounts.vault.treasury_bump];
    let seeds = treasury_seeds(&mint, &bump);
    let decimals = ctx.accounts.mint.decimals;
    let treasury = ctx.accounts.treasury.to_account_info();
    let system_program = ctx.accounts.system_program.to_account_info();
    let remaining = ctx.remaining_accounts;
    let rent_min = rent_exempt_minimum()?;

    let mut cursor = 0usize;
    let mut sol_total: u64 = 0;
    let mut token_total: u64 = 0;
    for entry in &entries {
        require!(entry.sol > 0 || entry.tokens > 0, HoldfastError::EmptyEntry);
        ctx.accounts.round.mark_paid(entry.index)?;

        let wallet = remaining.get(cursor).ok_or(HoldfastError::RemainingAccountsMismatch)?;
        cursor += 1;
        require!(is_regular_wallet(wallet) && wallet.key() != treasury.key(), HoldfastError::NotAWallet);

        if entry.sol > 0 {
            transfer_lamports(&system_program, &treasury, wallet, &seeds, entry.sol)?;
            // A first payout to an empty wallet must make it rent-exempt (the worker carries smaller amounts).
            require!(wallet.lamports() >= rent_min, HoldfastError::RecipientBelowRent);
            sol_total = sol_total.checked_add(entry.sol).ok_or(HoldfastError::MathOverflow)?;
        }
        if entry.tokens > 0 {
            let token_account = remaining.get(cursor).ok_or(HoldfastError::RemainingAccountsMismatch)?;
            cursor += 1;
            require_keys_eq!(*token_account.owner, ctx.accounts.token_program.key(), HoldfastError::InvalidRecipientTokenAccount);
            let (ta_mint, ta_owner, _) = read_token_account(token_account)?;
            require!(ta_mint == mint && ta_owner == wallet.key(), HoldfastError::InvalidRecipientTokenAccount);
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.treasury_token_account.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: token_account.clone(),
                        authority: treasury.clone(),
                    },
                    &[&seeds],
                ),
                entry.tokens,
                decimals,
            )?;
            token_total = token_total.checked_add(entry.tokens).ok_or(HoldfastError::MathOverflow)?;
        }
    }
    require!(cursor == remaining.len(), HoldfastError::RemainingAccountsMismatch);

    let round = &mut ctx.accounts.round;
    round.sol_paid = round.sol_paid.checked_add(sol_total).ok_or(HoldfastError::MathOverflow)?;
    round.token_paid = round.token_paid.checked_add(token_total).ok_or(HoldfastError::MathOverflow)?;
    require!(round.sol_paid <= round.sol_pot && round.token_paid <= round.token_pot, HoldfastError::PotExceeded);
    round.paid_count += entries.len() as u32;

    let vault = &mut ctx.accounts.vault;
    vault.holder_sol = vault.holder_sol.checked_sub(sol_total).ok_or(HoldfastError::InvariantViolation)?;
    vault.holder_tokens = vault.holder_tokens.checked_sub(token_total).ok_or(HoldfastError::InvariantViolation)?;
    vault.total_paid_sol = vault.total_paid_sol.saturating_add(sol_total);
    vault.total_paid_tokens = vault.total_paid_tokens.saturating_add(token_total);
    require!(spendable_lamports(&treasury)? >= vault.accounted_lamports()?, HoldfastError::InvariantViolation);

    emit!(PayoutBatch {
        mint,
        round_id,
        recipients: entries.len() as u32,
        sol: sol_total,
        tokens: token_total,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CloseRound<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = keeper)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VAULT_SEED, vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, CoinVault>>,
    #[account(
        mut,
        close = rent_receiver,
        seeds = [ROUND_SEED, vault.mint.as_ref(), &round_id.to_le_bytes()],
        bump = round.bump,
        has_one = vault,
    )]
    pub round: Box<Account<'info, PayoutRound>>,
    /// CHECK: whoever paid the round's rent.
    #[account(mut, address = round.payer)]
    pub rent_receiver: UncheckedAccount<'info>,
}

/// Ends the round. Anything not paid simply stays in the holder buckets for the next round.
pub fn close_round(ctx: Context<CloseRound>, round_id: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(vault.round_open && vault.round_id == round_id, HoldfastError::RoundNotOpen);
    vault.round_open = false;
    emit!(RoundClosed {
        mint: vault.mint,
        round_id,
        sol_paid: ctx.accounts.round.sol_paid,
        tokens_paid: ctx.accounts.round.token_paid,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
