use anchor_lang::prelude::Pubkey;
use anchor_spl::associated_token::get_associated_token_address_with_program_id as ata;
use holdfast_vault_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// A $HOLD coin on its own bonding curve + config.hold_mint set.
fn setup_hold(env: &mut Env) -> Pubkey {
    let hold = env.create_mint(TOKEN_2022_PROGRAM, 1_000_000_000_000_000);
    let hold_creator = Keypair::new().pubkey();
    env.set_curve(&hold, &hold_creator, 1_073_000_000_000_000, 30 * SOL, 793_100_000_000_000, false);
    env.svm.airdrop(&creator_vault_pda(&hold_creator), SOL).unwrap();
    let admin = env.admin.insecure_clone();
    let ix = env.set_hold_mint_ix(&admin.pubkey(), &hold);
    env.send(&[ix], &[&admin]).unwrap();
    hold
}

#[test]
fn burn_buys_hold_with_the_burn_bucket_and_burns_it() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    env.collect(&coin, 10 * SOL).unwrap(); // burn bucket = 1 SOL
    let hold = setup_hold(&mut env);
    let supply_before = env.mint_supply(&hold);
    let v_before = env.vault(&coin.mint);

    let keeper = env.keeper.insecure_clone();
    let ix = env.burn_hold_ix(&coin, &keeper.pubkey(), &hold, 1);
    env.send(&[ix], &[&keeper]).expect("burn_hold");

    let v = env.vault(&coin.mint);
    assert_eq!(v.burn_sol, 0);
    assert_eq!(v.total_burn_sol, SOL);
    assert!(v.total_hold_burned > 0);
    assert_eq!(env.mint_supply(&hold), supply_before - v.total_hold_burned, "bought $HOLD is burned in the same instruction");
    assert_eq!(env.token_balance(&ata(&coin.treasury, &hold, &TOKEN_2022_PROGRAM)), 0);
    // other buckets untouched
    assert_eq!((v.floor_sol, v.holder_sol), (v_before.floor_sol, v_before.holder_sol));
}

#[test]
fn burn_requires_keeper_hold_mint_and_a_minimum() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    env.collect(&coin, 10 * SOL).unwrap();
    let keeper = env.keeper.insecure_clone();

    // hold mint not set → config has_one fails
    let some_mint = env.create_mint(TOKEN_2022_PROGRAM, 1);
    let ix = env.burn_hold_ix(&coin, &keeper.pubkey(), &some_mint, 1);
    assert!(env.send(&[ix], &[&keeper]).is_err());

    let hold = setup_hold(&mut env);
    let rando = Keypair::new();
    env.svm.airdrop(&rando.pubkey(), SOL).unwrap();
    let ix = env.burn_hold_ix(&coin, &rando.pubkey(), &hold, 1);
    assert!(env.send(&[ix], &[&rando]).is_err());

    // keeper's min_out above what the market gives
    let ix = env.burn_hold_ix(&coin, &keeper.pubkey(), &hold, u64::MAX / 2);
    assert!(env.send(&[ix], &[&keeper]).is_err());

    // empty bucket
    let empty = env.launch(2_500);
    let ix = env.burn_hold_ix(&empty, &keeper.pubkey(), &hold, 1);
    assert_err(&env.send(&[ix], &[&keeper]), HoldfastError::BurnBucketTooSmall);
}
