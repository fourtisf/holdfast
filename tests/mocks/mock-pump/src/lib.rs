//! TEST ONLY. A minimal stand-in for pump.fun's bonding curve program, deployed at the real program id
//! inside LiteSVM. Implements `buy_exact_sol_in` with the real account order, instruction layout and
//! `BondingCurve` layout, using the documented quote formula. Never deploy this anywhere.
//!
//! Test hook: byte 0 of the `global` account selects a misbehaviour mode, to prove the vault's own
//! post-swap checks hold even if the venue misbehaves:
//!   0 = honest, 1 = deliver half the tokens (ignores min_out), 2 = take 2× the SOL.

#![allow(unexpected_cfgs)]

use anchor_lang::solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
};
use anchor_lang::solana_program::sysvar::Sysvar;
use anchor_spl::token_2022::spl_token_2022;

anchor_lang::declare_id!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

pub const BUY_EXACT_SOL_IN: [u8; 8] = [56, 252, 116, 8, 158, 223, 205, 95];
pub const BONDING_CURVE_DISCRIMINATOR: [u8; 8] = [23, 183, 248, 55, 96, 216, 172, 96];
pub const PROTOCOL_FEE_BPS: u64 = 95;
pub const CREATOR_FEE_BPS: u64 = 30;

#[cfg(not(feature = "no-entrypoint"))]
anchor_lang::solana_program::entrypoint!(process_instruction);

fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}

fn ceil_div(a: u64, b: u64) -> u64 {
    a.div_ceil(b)
}

/// Quote from the pump.fun IDL docs for `buy_exact_sol_in`.
pub fn quote_buy(spendable: u64, virtual_sol: u64, virtual_token: u64) -> (u64, u64, u64, u64) {
    let total_fee_bps = PROTOCOL_FEE_BPS + CREATOR_FEE_BPS;
    let mut net_sol = (spendable as u128 * 10_000 / (10_000 + total_fee_bps) as u128) as u64;
    let protocol_fee = ceil_div(net_sol * PROTOCOL_FEE_BPS, 10_000);
    let creator_fee = ceil_div(net_sol * CREATOR_FEE_BPS, 10_000);
    if net_sol + protocol_fee + creator_fee > spendable {
        net_sol -= net_sol + protocol_fee + creator_fee - spendable;
    }
    let tokens = ((net_sol as u128 - 1) * virtual_token as u128 / (virtual_sol as u128 + net_sol as u128 - 1)) as u64;
    (net_sol, protocol_fee, creator_fee, tokens)
}

pub const INIT_USER_VOLUME_ACCUMULATOR: [u8; 8] = [94, 6, 202, 115, 255, 96, 232, 183];
pub const USER_VOLUME_ACCUMULATOR_SIZE: u64 = 137;

/// `init_user_volume_accumulator`: payer (signer), user, user_volume_accumulator, system_program,
/// event_authority, program. Creates the 137-byte PDA `["user_volume_accumulator", user]`, paid by `payer`.
fn init_user_volume_accumulator(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (payer, user, accumulator, system_program) = (&accounts[0], &accounts[1], &accounts[2], &accounts[3]);
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (expected, bump) = Pubkey::find_program_address(&[b"user_volume_accumulator", user.key.as_ref()], program_id);
    if *accumulator.key != expected {
        return Err(ProgramError::InvalidSeeds);
    }
    if accumulator.owner == program_id {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    let lamports = anchor_lang::solana_program::rent::Rent::get()?.minimum_balance(USER_VOLUME_ACCUMULATOR_SIZE as usize);
    invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(payer.key, accumulator.key, lamports, USER_VOLUME_ACCUMULATOR_SIZE, program_id),
        &[payer.clone(), accumulator.clone(), system_program.clone()],
        &[&[b"user_volume_accumulator", user.key.as_ref(), &[bump]]],
    )
}

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() >= 8 && data[..8] == INIT_USER_VOLUME_ACCUMULATOR {
        return init_user_volume_accumulator(program_id, accounts);
    }
    if data.len() < 8 || data[..8] != BUY_EXACT_SOL_IN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let spendable = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let min_tokens_out = u64::from_le_bytes(data[16..24].try_into().unwrap());

    let it = &mut accounts.iter();
    let global = next_account_info(it)?;
    let fee_recipient = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let bonding_curve = next_account_info(it)?;
    let associated_bonding_curve = next_account_info(it)?;
    let associated_user = next_account_info(it)?;
    let user = next_account_info(it)?;
    let _system_program = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let creator_vault = next_account_info(it)?;

    if !user.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if bonding_curve.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (expected_curve, curve_bump) = Pubkey::find_program_address(&[b"bonding-curve", mint.key.as_ref()], program_id);
    if *bonding_curve.key != expected_curve {
        return Err(ProgramError::InvalidSeeds);
    }
    let mode = if global.owner == program_id { global.try_borrow_data()?.first().copied().unwrap_or(0) } else { 0 };

    let (vtok, vsol, rtok, rsol, creator) = {
        let d = bonding_curve.try_borrow_data()?;
        if d[..8] != BONDING_CURVE_DISCRIMINATOR || d[48] != 0 {
            return Err(ProgramError::InvalidAccountData);
        }
        (u64_at(&d, 8), u64_at(&d, 16), u64_at(&d, 24), u64_at(&d, 32), Pubkey::new_from_array(d[49..81].try_into().unwrap()))
    };
    let (expected_vault, _) = Pubkey::find_program_address(&[b"creator-vault", creator.as_ref()], program_id);
    if *creator_vault.key != expected_vault {
        return Err(ProgramError::InvalidSeeds);
    }

    let (net_sol, protocol_fee, creator_fee, mut tokens) = quote_buy(spendable, vsol, vtok);
    if tokens < min_tokens_out && mode == 0 {
        return Err(ProgramError::Custom(6002)); // slippage
    }
    if tokens > rtok {
        return Err(ProgramError::Custom(6003));
    }
    let mut charged_net = net_sol;
    match mode {
        1 => tokens /= 2,
        2 => charged_net = net_sol * 2,
        _ => {}
    }

    invoke(&system_instruction::transfer(user.key, bonding_curve.key, charged_net), &[user.clone(), bonding_curve.clone()])?;
    invoke(&system_instruction::transfer(user.key, fee_recipient.key, protocol_fee), &[user.clone(), fee_recipient.clone()])?;
    invoke(&system_instruction::transfer(user.key, creator_vault.key, creator_fee), &[user.clone(), creator_vault.clone()])?;

    let decimals = mint.try_borrow_data()?[44];
    invoke_signed(
        &spl_token_2022::instruction::transfer_checked(
            token_program.key,
            associated_bonding_curve.key,
            mint.key,
            associated_user.key,
            bonding_curve.key,
            &[],
            tokens,
            decimals,
        )?,
        &[associated_bonding_curve.clone(), mint.clone(), associated_user.clone(), bonding_curve.clone()],
        &[&[b"bonding-curve", mint.key.as_ref(), &[curve_bump]]],
    )?;

    let mut d = bonding_curve.try_borrow_mut_data()?;
    d[8..16].copy_from_slice(&(vtok - tokens).to_le_bytes());
    d[16..24].copy_from_slice(&(vsol + net_sol).to_le_bytes());
    d[24..32].copy_from_slice(&(rtok - tokens).to_le_bytes());
    d[32..40].copy_from_slice(&(rsol + net_sol).to_le_bytes());
    Ok(())
}
