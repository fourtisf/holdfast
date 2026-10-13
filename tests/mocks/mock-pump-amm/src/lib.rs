//! TEST ONLY. Minimal stand-in for PumpSwap (pump_amm) deployed at its real id inside LiteSVM.
//! Implements `buy_exact_quote_in` with the real account order and the real `Pool` layout
//! (effective quote = quote vault balance + virtual_quote_reserves). Never deploy this anywhere.
//!
//! Test hook: byte 0 of `global_config` = 1 makes the pool deliver half the tokens (ignoring min_out).

#![allow(unexpected_cfgs)]

use anchor_lang::solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, program::invoke, program::invoke_signed, program_error::ProgramError,
    pubkey::Pubkey,
};
use anchor_spl::token_2022::spl_token_2022;

anchor_lang::declare_id!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

pub const BUY_EXACT_QUOTE_IN: [u8; 8] = [198, 46, 21, 82, 180, 217, 232, 112];
pub const POOL_DISCRIMINATOR: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
pub const LP_FEE_BPS: u64 = 20;
pub const PROTOCOL_FEE_BPS: u64 = 5;
pub const CREATOR_FEE_BPS: u64 = 5;

#[cfg(not(feature = "no-entrypoint"))]
anchor_lang::solana_program::entrypoint!(process_instruction);

fn pk(d: &[u8], o: usize) -> Pubkey {
    Pubkey::new_from_array(d[o..o + 32].try_into().unwrap())
}

fn amount(info: &AccountInfo) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(info.try_borrow_data()?[64..72].try_into().unwrap()))
}

pub fn quote_buy(spendable: u64, base_reserve: u64, effective_quote: u64) -> (u64, u64, u64, u64, u64) {
    let total = LP_FEE_BPS + PROTOCOL_FEE_BPS + CREATOR_FEE_BPS;
    let net = (spendable as u128 * 10_000 / (10_000 + total) as u128) as u64;
    let lp = net * LP_FEE_BPS / 10_000;
    let protocol = net * PROTOCOL_FEE_BPS / 10_000;
    let creator = spendable - net - lp - protocol;
    let base_out = (net as u128 * base_reserve as u128 / (effective_quote as u128 + net as u128)) as u64;
    (net, lp, protocol, creator, base_out)
}

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 8 || data[..8] != BUY_EXACT_QUOTE_IN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let spendable = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let min_base_out = u64::from_le_bytes(data[16..24].try_into().unwrap());
    if accounts.len() < 23 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let pool = &accounts[0];
    let user = &accounts[1];
    let global_config = &accounts[2];
    let base_mint = &accounts[3];
    let quote_mint = &accounts[4];
    let user_base = &accounts[5];
    let user_quote = &accounts[6];
    let pool_base = &accounts[7];
    let pool_quote = &accounts[8];
    let protocol_fee_ta = &accounts[10];
    let base_token_program = &accounts[11];
    let quote_token_program = &accounts[12];
    let creator_vault_ata = &accounts[17];

    if !user.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if pool.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (index, creator, vqr) = {
        let d = pool.try_borrow_data()?;
        if d[..8] != POOL_DISCRIMINATOR || pk(&d, 43) != *base_mint.key || pk(&d, 75) != *quote_mint.key || pk(&d, 139) != *pool_base.key || pk(&d, 171) != *pool_quote.key {
            return Err(ProgramError::InvalidAccountData);
        }
        let vqr = if d.len() >= 261 { i128::from_le_bytes(d[245..261].try_into().unwrap()) } else { 0 };
        (u16::from_le_bytes(d[9..11].try_into().unwrap()), pk(&d, 11), vqr)
    };
    let mode = if global_config.owner == program_id { global_config.try_borrow_data()?.first().copied().unwrap_or(0) } else { 0 };

    let base_reserve = amount(pool_base)?;
    let effective_quote = (amount(pool_quote)? as i128 + vqr) as u64;
    let (net, lp, protocol, creator_fee, mut base_out) = quote_buy(spendable, base_reserve, effective_quote);
    if base_out < min_base_out && mode == 0 {
        return Err(ProgramError::Custom(6004));
    }
    if mode == 1 {
        base_out /= 2;
    }

    let quote_decimals = quote_mint.try_borrow_data()?[44];
    let base_decimals = base_mint.try_borrow_data()?[44];
    for (to, amt) in [(pool_quote, net + lp), (protocol_fee_ta, protocol), (creator_vault_ata, creator_fee)] {
        invoke(
            &spl_token_2022::instruction::transfer_checked(quote_token_program.key, user_quote.key, quote_mint.key, to.key, user.key, &[], amt, quote_decimals)?,
            &[user_quote.clone(), quote_mint.clone(), to.clone(), user.clone()],
        )?;
    }
    let (_, bump) = Pubkey::find_program_address(&[b"pool", &index.to_le_bytes(), creator.as_ref(), base_mint.key.as_ref(), quote_mint.key.as_ref()], program_id);
    invoke_signed(
        &spl_token_2022::instruction::transfer_checked(base_token_program.key, pool_base.key, base_mint.key, user_base.key, pool.key, &[], base_out, base_decimals)?,
        &[pool_base.clone(), base_mint.clone(), user_base.clone(), pool.clone()],
        &[&[b"pool", &index.to_le_bytes(), creator.as_ref(), base_mint.key.as_ref(), quote_mint.key.as_ref(), &[bump]]],
    )?;
    Ok(())
}
