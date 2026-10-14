use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::HoldfastError;
use crate::events::{AthUpdated, Graduated};
use crate::math;
use crate::state::{CoinVault, Config, Observation};
use crate::venue;

/// Price accounts of a coin's current venue: the bonding curve, or the PumpSwap pool plus its two
/// token accounts (checked against the pool's own data in `venue::pool_price`).
pub fn vault_spot_price(vault: &CoinVault, price_account: &AccountInfo, base: Option<&AccountInfo>, quote: Option<&AccountInfo>) -> Result<u128> {
    let expected = if vault.venue == VENUE_CURVE { vault.bonding_curve } else { vault.amm_pool };
    require_keys_eq!(price_account.key(), expected, HoldfastError::WrongPriceAccount);
    venue::spot_price(vault.venue, price_account, base, quote)
}

#[derive(Accounts)]
pub struct UpdateAth<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = keeper)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [VAULT_SEED, vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, CoinVault>>,
    /// CHECK: bonding curve or PumpSwap pool, checked against the vault.
    pub price_account: UncheckedAccount<'info>,
    /// CHECK: pool base token account (PumpSwap venue only).
    pub pool_base_account: Option<UncheckedAccount<'info>>,
    /// CHECK: pool quote token account (PumpSwap venue only).
    pub pool_quote_account: Option<UncheckedAccount<'info>>,
}

/// Records a spot observation read directly from reserves, recomputes the TWAP and raises the ATH
/// (and so the floor) only when a higher TWAP has persisted for `ath_confirm_secs`.
pub fn update_ath(ctx: Context<UpdateAth>) -> Result<()> {
    let params = ctx.accounts.config.params;
    let vault = &mut ctx.accounts.vault;
    let spot = vault_spot_price(
        vault,
        &ctx.accounts.price_account,
        ctx.accounts.pool_base_account.as_ref().map(|a| a.as_ref()),
        ctx.accounts.pool_quote_account.as_ref().map(|a| a.as_ref()),
    )?;

    let now = Clock::get()?.unix_timestamp;
    if let Some(last) = vault.latest_observation() {
        require!(now - last.ts >= params.twap_min_sample_interval_secs as i64, HoldfastError::ObservationTooSoon);
    }
    vault.push_observation(Observation { ts: now, price: spot });

    let Some(twap) = math::twap(vault.observations_newest_first(), now, params.twap_window_secs as i64, params.twap_max_gap_secs as i64) else {
        return Ok(()); // not enough history yet
    };

    let (ath, candidate, since) = math::next_ath(vault.ath_price, vault.ath_candidate, vault.ath_candidate_since, twap, now, params.ath_confirm_secs as i64);
    vault.ath_candidate = candidate;
    vault.ath_candidate_since = since;
    if ath > vault.ath_price {
        vault.ath_price = ath;
        vault.floor_price = math::floor_from_ath(ath, vault.trigger_bps).ok_or(HoldfastError::MathOverflow)?;
        emit!(AthUpdated { mint: vault.mint, twap, ath, floor: vault.floor_price, ts: now });
    }
    Ok(())
}

#[derive(Accounts)]
pub struct Graduate<'info> {
    #[account(mut, seeds = [VAULT_SEED, vault.mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, CoinVault>>,
    /// CHECK: the coin's bonding curve (stored at init).
    #[account(address = vault.bonding_curve)]
    pub bonding_curve: UncheckedAccount<'info>,
    /// CHECK: must be the canonical PumpSwap pool PDA for the mint; validated in the handler.
    pub pool: UncheckedAccount<'info>,
}

/// Permissionless: once pump.fun migrated the coin, switch price reads and buybacks to PumpSwap.
pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(vault.venue == VENUE_CURVE, HoldfastError::WrongVenue);
    let curve = venue::read_curve(&ctx.accounts.bonding_curve)?;
    require!(curve.complete, HoldfastError::CurveNotComplete);

    require_keys_eq!(ctx.accounts.pool.key(), venue::canonical_pool_address(&vault.mint), HoldfastError::NotCanonicalPool);
    let pool = venue::read_pool(&ctx.accounts.pool)?;
    require_keys_eq!(pool.base_mint, vault.mint, HoldfastError::NotCanonicalPool);
    require_keys_eq!(pool.quote_mint, WSOL_MINT, HoldfastError::UnsupportedQuote);

    vault.venue = VENUE_AMM;
    vault.amm_pool = ctx.accounts.pool.key();

    emit!(Graduated { mint: vault.mint, pool: vault.amm_pool, coin_creator: pool.coin_creator, ts: Clock::get()?.unix_timestamp });
    Ok(())
}
