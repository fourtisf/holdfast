//! Treasury-signed buys on pump.fun / PumpSwap with balance-delta accounting, shared by `defend`
//! and `burn_hold`.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::HoldfastError;
use crate::treasury::{token_amount, unwrap_wsol, wrap_sol, WsolAccounts};
use crate::venue::{self, BuyTargets};

pub struct BuyRequest<'a, 'info> {
    pub venue: u8,
    pub treasury: &'a AccountInfo<'info>,
    /// Treasury token account that receives the bought tokens.
    pub token_account: &'a AccountInfo<'info>,
    pub wsol: WsolAccounts<'a, 'info>,
    pub targets: BuyTargets,
    /// The venue instruction's full account list, in IDL order.
    pub venue_accounts: &'a [AccountInfo<'info>],
    pub seeds: &'a [&'a [u8]],
    pub budget: u64,
    pub min_out: u64,
}

pub struct BuyOutcome {
    pub sol_spent: u64,
    pub tokens_received: u64,
}

/// Executes the buy and measures what actually happened: SOL spent is the drop in
/// (treasury lamports + treasury WSOL balance), tokens received the rise of the token account.
pub fn execute_buy(req: &BuyRequest) -> Result<BuyOutcome> {
    let value_before = req.treasury.lamports().checked_add(token_amount(req.wsol.wsol_account)?).ok_or(HoldfastError::MathOverflow)?;
    let tokens_before = token_amount(req.token_account)?;

    match req.venue {
        VENUE_CURVE => {
            venue::validate_curve_buy_accounts(req.venue_accounts, &req.targets)?;
            venue::cpi_curve_buy(req.venue_accounts, req.treasury.key, req.seeds, req.budget, req.min_out)?;
        }
        VENUE_AMM => {
            venue::validate_amm_buy_accounts(req.venue_accounts, &req.targets)?;
            wrap_sol(&req.wsol, req.seeds, req.budget)?;
            venue::cpi_amm_buy(req.venue_accounts, req.treasury.key, req.seeds, req.budget, req.min_out)?;
        }
        _ => return err!(HoldfastError::WrongVenue),
    }

    // Unwrap whatever WSOL is left (AMM change, or creator fees waiting for collect_fees) so the
    // treasury's value is all lamports again.
    if token_amount(req.wsol.wsol_account)? > 0 {
        unwrap_wsol(&req.wsol, req.seeds)?;
    }

    let value_after = req.treasury.lamports().checked_add(token_amount(req.wsol.wsol_account)?).ok_or(HoldfastError::MathOverflow)?;
    let sol_spent = value_before.saturating_sub(value_after);
    let tokens_received = token_amount(req.token_account)?.checked_sub(tokens_before).ok_or(HoldfastError::InvalidAccountData)?;

    require!(tokens_received >= req.min_out && tokens_received > 0, HoldfastError::SlippageExceeded);
    require!(sol_spent <= req.budget.saturating_add(DEFEND_RENT_ALLOWANCE), HoldfastError::OverspentSwap);
    Ok(BuyOutcome { sol_spent, tokens_received })
}
