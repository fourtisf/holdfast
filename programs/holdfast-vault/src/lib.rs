//! Holdfast vault: one vault per pump.fun coin. The coin's creator fees flow here and can only leave
//! as floor buybacks, holder payouts or $HOLD buy-and-burn. There is no withdraw instruction.

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;
pub mod swap;
pub mod treasury;
pub mod venue;

use instructions::*;
use state::Params;

declare_id!("8WhCTXTNjZi1fJn5uK6E4cRiGJtKt3RUsnJjCWf5ytdM");

#[program]
pub mod holdfast_vault {
    use super::*;

    // ---- admin (no instruction here can move funds) ------------------------------------------
    pub fn initialize(ctx: Context<Initialize>, keeper: Pubkey, launcher: Pubkey, params: Params) -> Result<()> {
        admin::initialize(ctx, keeper, launcher, params)
    }

    pub fn set_keeper(ctx: Context<AdminOnly>, keeper: Pubkey) -> Result<()> {
        admin::set_keeper(ctx, keeper)
    }

    pub fn set_launcher(ctx: Context<AdminOnly>, launcher: Pubkey) -> Result<()> {
        admin::set_launcher(ctx, launcher)
    }

    pub fn set_params(ctx: Context<AdminOnly>, params: Params) -> Result<()> {
        admin::set_params(ctx, params)
    }

    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        admin::set_paused(ctx, paused)
    }

    pub fn transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        admin::transfer_admin(ctx, new_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        admin::accept_admin(ctx)
    }

    pub fn set_hold_mint(ctx: Context<SetHoldMint>) -> Result<()> {
        admin::set_hold_mint(ctx)
    }

    // ---- coin lifecycle ----------------------------------------------------------------------
    pub fn init_coin(ctx: Context<InitCoin>, trigger_bps: u16) -> Result<()> {
        init_coin::init_coin(ctx, trigger_bps)
    }

    pub fn collect_fees(ctx: Context<CollectFees>) -> Result<()> {
        collect_fees::collect_fees(ctx)
    }

    pub fn update_ath(ctx: Context<UpdateAth>) -> Result<()> {
        price::update_ath(ctx)
    }

    pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
        price::graduate(ctx)
    }

    pub fn defend<'info>(ctx: Context<'_, '_, 'info, 'info, Defend<'info>>, min_tokens_out: u64) -> Result<()> {
        defend::defend(ctx, min_tokens_out)
    }

    // ---- payouts -------------------------------------------------------------------------------
    pub fn open_round(
        ctx: Context<OpenRound>,
        round_id: u64,
        sol_pot: u64,
        token_pot: u64,
        snapshot_hash: [u8; 32],
        recipient_count: u32,
    ) -> Result<()> {
        rounds::open_round(ctx, round_id, sol_pot, token_pot, snapshot_hash, recipient_count)
    }

    pub fn payout<'info>(ctx: Context<'_, '_, 'info, 'info, Payout<'info>>, round_id: u64, entries: Vec<PayoutEntry>) -> Result<()> {
        rounds::payout(ctx, round_id, entries)
    }

    pub fn close_round(ctx: Context<CloseRound>, round_id: u64) -> Result<()> {
        rounds::close_round(ctx, round_id)
    }

    pub fn burn_hold<'info>(ctx: Context<'_, '_, 'info, 'info, BurnHold<'info>>, venue: u8, min_hold_out: u64) -> Result<()> {
        burn_hold::burn_hold(ctx, venue, min_hold_out)
    }
}
