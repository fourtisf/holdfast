use holdfast_vault::constants::*;
use holdfast_vault_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn init_coin_registers_a_pump_coin_whose_creator_is_the_treasury() {
    let mut env = Env::ready();
    let launcher_before = env.lamports(&env.launcher.pubkey());
    let coin = env.launch_bare(2_500);
    let v = env.vault(&coin.mint);
    assert_eq!(v.mint, coin.mint);
    assert_eq!(v.trigger_bps, 2_500);
    assert_eq!(v.venue, VENUE_CURVE);
    assert_eq!(v.bonding_curve, coin.bonding_curve);
    assert_eq!(v.token_program, TOKEN_2022_PROGRAM);
    assert_eq!((v.floor_sol, v.holder_sol, v.burn_sol, v.holder_tokens), (0, 0, 0, 0));
    assert_eq!((v.ath_price, v.floor_price), (0, 0));
    // treasury exists, rent exempt, system owned
    let treasury = env.svm.get_account(&coin.treasury).unwrap();
    assert_eq!(treasury.owner, SYSTEM_PROGRAM);
    assert!(treasury.data.is_empty());
    assert_eq!(treasury.lamports, env.svm.minimum_balance_for_rent_exemption(0));
    // no treasury token accounts yet: those are paid later, out of the coin's own fees
    assert!(!env.exists(&coin.treasury_ata));
    assert!(!env.exists(&coin.treasury_wsol));
    // the launcher pays exactly the vault and the treasury's rent reserve (plus the tx fee)
    let vault_len = env.account_data(&coin.vault).len();
    assert!(vault_len <= 730, "CoinVault is {vault_len} bytes: launch rent budget is ≈ 730");
    let rent = env.svm.minimum_balance_for_rent_exemption(vault_len) + env.svm.minimum_balance_for_rent_exemption(0);
    assert_eq!(launcher_before - env.lamports(&env.launcher.pubkey()), rent + 5_000);
}

#[test]
fn first_fees_are_booked_without_treasury_token_accounts() {
    let mut env = Env::ready();
    let coin = env.launch_bare(2_500);
    env.collect(&coin, SOL).unwrap();
    let v = env.vault(&coin.mint);
    assert_eq!((v.floor_sol, v.holder_sol, v.burn_sol), (600_000_000, 300_000_000, 100_000_000));
    // a SOL-only payout round works without the treasury token account too
    env.open_round(&coin, 1, v.holder_sol, 0, 1).unwrap();
    let wallet = Keypair::new().pubkey();
    env.payout(&coin, 1, vec![PayoutEntry { index: 0, sol: v.holder_sol, tokens: 0 }], &[(wallet, None)]).unwrap();
    assert_eq!(env.lamports(&wallet), v.holder_sol);
}

#[test]
fn prepare_treasury_creates_its_accounts_out_of_the_floor_bucket() {
    let mut env = Env::ready();
    let coin = env.launch_bare(2_500);
    let accumulator = user_volume_accumulator_pda(&coin.treasury, &PUMP_PROGRAM_ID);
    let rent = |env: &Env, len: usize| env.svm.minimum_balance_for_rent_exemption(len);

    // nothing in the floor bucket yet
    assert_err(&env.prepare_treasury(&coin, Some(PUMP_PROGRAM_ID)), HoldfastError::FloorVaultTooSmall);

    // the floor bucket must still fund one minimum buyback step (10 × 0.001 SOL) after paying
    let cost = rent(&env, 170) + rent(&env, 165) + rent(&env, 137);
    let fee = (cost + 9_000_000) * 10 / 6 + 10;
    env.collect(&coin, fee).unwrap();
    assert!(env.vault(&coin.mint).floor_sol < cost + 10_000_000);
    assert_err(&env.prepare_treasury(&coin, Some(PUMP_PROGRAM_ID)), HoldfastError::FloorVaultTooSmall);

    env.collect(&coin, SOL).unwrap();
    let before = env.vault(&coin.mint);
    env.prepare_treasury(&coin, Some(PUMP_PROGRAM_ID)).unwrap();
    let after = env.vault(&coin.mint);
    assert!(env.exists(&coin.treasury_ata) && env.exists(&coin.treasury_wsol) && env.exists(&accumulator));
    assert_eq!(env.svm.get_account(&accumulator).unwrap().owner, PUMP_PROGRAM_ID);
    assert_eq!(env.token_balance(&coin.treasury_ata), 0);
    assert_eq!(before.floor_sol - after.floor_sol, cost);
    assert_eq!(after.total_treasury_rent, cost);
    assert_eq!((after.holder_sol, after.burn_sol), (before.holder_sol, before.burn_sol));
    let reserve = rent(&env, 0);
    assert_eq!(env.lamports(&coin.treasury) - reserve, after.floor_sol + after.holder_sol + after.burn_sol);

    // idempotent
    env.prepare_treasury(&coin, Some(PUMP_PROGRAM_ID)).unwrap();
    assert_eq!(env.vault(&coin.mint).floor_sol, after.floor_sol);
}

#[test]
fn prepare_treasury_rejects_foreign_volume_accounts() {
    let mut env = Env::ready();
    let coin = env.launch_bare(2_500);
    env.collect(&coin, SOL).unwrap();
    let payer = env.payer.insecure_clone();

    // a program other than pump / pump_amm
    let mut ix = env.prepare_treasury_ix(&coin, Some(PUMP_PROGRAM_ID));
    let n = ix.accounts.len();
    ix.accounts[n - 3].pubkey = SYSTEM_PROGRAM;
    assert_err(&env.send(&[ix], &[&payer]), HoldfastError::InvalidVolumeAccounts);

    // someone else's accumulator
    let mut ix = env.prepare_treasury_ix(&coin, Some(PUMP_PROGRAM_ID));
    ix.accounts[n - 2].pubkey = user_volume_accumulator_pda(&payer.pubkey(), &PUMP_PROGRAM_ID);
    assert_err(&env.send(&[ix], &[&payer]), HoldfastError::InvalidVolumeAccounts);

    // not the treasury's ATA
    let mut ix = env.prepare_treasury_ix(&coin, None);
    ix.accounts[3].pubkey = Keypair::new().pubkey();
    assert!(env.send(&[ix], &[&payer]).is_err());
    assert_eq!(env.vault(&coin.mint).total_treasury_rent, 0);
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
