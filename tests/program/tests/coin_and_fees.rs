use holdfast_vault::constants::*;
use holdfast_vault_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn init_coin_registers_a_pump_coin_whose_creator_is_the_treasury() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    let v = env.vault(&coin.mint);
    assert_eq!(v.mint, coin.mint);
    assert_eq!(v.trigger_bps, 2_500);
    assert_eq!(v.venue, VENUE_CURVE);
    assert_eq!(v.bonding_curve, coin.bonding_curve);
    assert_eq!(v.token_program, TOKEN_2022_PROGRAM);
    assert_eq!((v.floor_sol, v.holder_sol, v.burn_sol, v.holder_tokens), (0, 0, 0, 0));
    assert_eq!((v.ath_price, v.floor_price), (0, 0));
    // treasury exists, rent exempt, system owned; token + WSOL accounts exist
    let treasury = env.svm.get_account(&coin.treasury).unwrap();
    assert_eq!(treasury.owner, SYSTEM_PROGRAM);
    assert!(treasury.data.is_empty());
    assert_eq!(treasury.lamports, env.svm.minimum_balance_for_rent_exemption(0));
    assert!(env.svm.get_account(&coin.treasury_ata).is_some());
    assert!(env.svm.get_account(&coin.treasury_wsol).is_some());
}

#[test]
fn every_trigger_option_and_nothing_else() {
    let mut env = Env::ready();
    for trigger in [1_500u16, 2_500, 3_500] {
        let coin = env.launch(trigger);
        assert_eq!(env.vault(&coin.mint).trigger_bps, trigger);
    }
    for trigger in [0u16, 1_000, 2_000, 5_000, 10_000] {
        let coin = env.prepare_coin(trigger);
        let launcher = env.launcher.insecure_clone();
        let ix = env.init_coin_ix(&coin, &launcher.pubkey());
        assert_err(&env.send(&[ix], &[&launcher]), HoldfastError::InvalidTrigger);
    }
}

#[test]
fn trigger_and_vault_cannot_be_reinitialized() {
    let mut env = Env::ready();
    let coin = env.launch(1_500);
    let mint = coin.mint;
    let launcher = env.launcher.insecure_clone();
    // same mint, different trigger: the vault PDA already exists, so init fails
    let again = Coin { trigger_bps: 3_500, ..coin };
    let ix = env.init_coin_ix(&again, &launcher.pubkey());
    assert!(env.send(&[ix], &[&launcher]).is_err());
    assert_eq!(env.vault(&mint).trigger_bps, 1_500);
}

#[test]
fn init_coin_rejects_foreign_creators_and_non_launchers() {
    let mut env = Env::ready();
    // creator is some dev wallet, not the treasury → fees would not reach the vault
    let coin = env.prepare_coin(2_500);
    let dev = Keypair::new();
    env.set_curve(&coin.mint, &dev.pubkey(), 1_073_000_000_000_000, 30 * SOL, 793_100_000_000_000, false);
    let launcher = env.launcher.insecure_clone();
    let ix = env.init_coin_ix(&coin, &launcher.pubkey());
    assert_err(&env.send(&[ix], &[&launcher]), HoldfastError::CreatorMismatch);

    // completed curve
    let coin = env.prepare_coin(2_500);
    env.set_curve_complete(&coin.mint);
    let ix = env.init_coin_ix(&coin, &launcher.pubkey());
    assert_err(&env.send(&[ix], &[&launcher]), HoldfastError::CurveComplete);

    // not the configured launcher
    let coin = env.prepare_coin(2_500);
    let rando = Keypair::new();
    env.svm.airdrop(&rando.pubkey(), 10 * SOL).unwrap();
    let ix = env.init_coin_ix(&coin, &rando.pubkey());
    assert!(env.send(&[ix], &[&rando]).is_err());
}

#[test]
fn fees_split_exactly_60_30_10() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    env.collect(&coin, 10 * SOL).unwrap();
    let v = env.vault(&coin.mint);
    assert_eq!(v.floor_sol, 6 * SOL);
    assert_eq!(v.holder_sol, 3 * SOL);
    assert_eq!(v.burn_sol, SOL);
    assert_eq!(v.total_fees, 10 * SOL);

    // odd amount: parts still sum exactly, rounding dust lands in the floor
    env.collect(&coin, 1_234_567_891).unwrap();
    let v = env.vault(&coin.mint);
    assert_eq!(v.holder_sol, 3 * SOL + 370_370_367);
    assert_eq!(v.burn_sol, SOL + 123_456_789);
    assert_eq!(v.floor_sol + v.holder_sol + v.burn_sol, 10 * SOL + 1_234_567_891);

    // nothing new → no change
    env.collect(&coin, 0).unwrap();
    assert_eq!(env.vault(&coin.mint).total_fees, 10 * SOL + 1_234_567_891);
    // buckets equal the treasury's spendable lamports
    let rent = env.svm.minimum_balance_for_rent_exemption(0);
    let v = env.vault(&coin.mint);
    assert_eq!(env.lamports(&coin.treasury) - rent, v.floor_sol + v.holder_sol + v.burn_sol);
}

#[test]
fn pumpswap_creator_fees_in_wsol_are_unwrapped_and_split() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    // what PumpSwap's collect_coin_creator_fee does: WSOL lands in the treasury's WSOL account
    env.set_token_account(coin.treasury_wsol, WSOL_MINT, coin.treasury, TOKEN_PROGRAM, 2 * SOL);
    let wsol_rent = env.svm.minimum_balance_for_rent_exemption(165);
    env.collect(&coin, 0).unwrap();
    let v = env.vault(&coin.mint);
    assert_eq!(v.floor_sol + v.holder_sol + v.burn_sol, 2 * SOL);
    assert_eq!((v.floor_sol, v.holder_sol, v.burn_sol), (1_200_000_000, 600_000_000, 200_000_000));
    // WSOL account re-created, empty, still owned by the treasury
    assert_eq!(env.token_balance(&coin.treasury_wsol), 0);
    assert_eq!(env.lamports(&coin.treasury_wsol), wsol_rent);
}

#[test]
fn collect_fees_is_permissionless_and_creator_has_no_share() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    let launcher_before = env.lamports(&env.launcher.pubkey());
    let anyone = Keypair::new();
    env.svm.airdrop(&anyone.pubkey(), SOL).unwrap();
    env.svm.airdrop(&coin.treasury, 5 * SOL).unwrap();
    let ix = env.collect_fees_ix(&coin);
    env.send(&[ix], &[&anyone]).unwrap();
    let v = env.vault(&coin.mint);
    assert_eq!(v.floor_sol + v.holder_sol + v.burn_sol, 5 * SOL);
    assert_eq!(env.lamports(&env.launcher.pubkey()), launcher_before);
}

#[test]
fn tokens_sent_to_the_treasury_join_the_holder_pool() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    env.set_token_account(coin.treasury_ata, coin.mint, coin.treasury, TOKEN_2022_PROGRAM, 12_345);
    env.collect(&coin, 0).unwrap();
    let v = env.vault(&coin.mint);
    assert_eq!(v.holder_tokens, 12_345);
    assert_eq!(v.total_fees, 0);
}
