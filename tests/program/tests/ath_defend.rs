use anchor_lang::solana_program::instruction::AccountMeta;
use holdfast_vault::constants::*;
use holdfast_vault::state::Params;
use holdfast_vault_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

fn funded_coin(env: &mut Env, trigger: u16) -> Coin {
    let coin = env.launch(trigger);
    env.collect(&coin, 10 * SOL).unwrap(); // floor 6 SOL, holder 3, burn 1
    coin
}

// ---- ATH / floor ---------------------------------------------------------------------------------

#[test]
fn ath_comes_from_a_twap_and_floor_follows() {
    for trigger in [1_500u16, 2_500, 3_500] {
        let mut env = Env::ready();
        let coin = env.launch(trigger);
        let spot = env.spot_price(&coin);
        // not enough history: no ATH yet
        env.sample_for(&coin, None, 300);
        assert_eq!(env.vault(&coin.mint).ath_price, 0);
        env.sample_for(&coin, None, 330);
        let v = env.vault(&coin.mint);
        assert_eq!(v.ath_price, spot);
        assert_eq!(v.floor_price, spot * (10_000 - trigger as u128) / 10_000);
    }
}

#[test]
fn update_ath_is_keeper_only_and_rate_limited() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    let rando = Keypair::new();
    env.svm.airdrop(&rando.pubkey(), SOL).unwrap();
    let ix = env.update_ath_ix(&coin, &rando.pubkey(), None);
    assert!(env.send(&[ix], &[&rando]).is_err());

    env.update_ath(&coin, None).unwrap();
    env.advance(30);
    assert_err(&env.update_ath(&coin, None), HoldfastError::ObservationTooSoon);
    env.advance(10);
    env.update_ath(&coin, None).unwrap();

    // wrong price account
    let keeper = env.keeper.insecure_clone();
    let mut ix = env.update_ath_ix(&coin, &keeper.pubkey(), None);
    ix.accounts[3] = AccountMeta::new_readonly(env.pump_global, false);
    env.advance(40);
    assert_err(&env.send(&[ix], &[&keeper]), HoldfastError::WrongPriceAccount);
}

#[test]
fn a_short_pump_barely_moves_the_ath() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    env.establish_ath(&coin);
    let base_ath = env.vault(&coin.mint).ath_price;
    let (vtok, vsol) = env.curve_reserves(&coin.mint);

    // attacker pumps 5× for a single 40s sample, then dumps back
    env.set_curve_reserves(&coin.mint, vtok, vsol * 5);
    env.update_ath(&coin, None).unwrap();
    env.advance(40);
    env.set_curve_reserves(&coin.mint, vtok, vsol);
    env.sample_for(&coin, None, 120);

    let ath = env.vault(&coin.mint).ath_price;
    // one 40s sample of 5× inside a 600s window lifts the TWAP by at most 4 × 40/600 ≈ 27%, not 400%
    assert!(ath <= base_ath * 127 / 100, "ath {ath} vs base {base_ath}");
}

#[test]
fn ath_never_decreases() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    env.establish_ath(&coin);
    let ath = env.vault(&coin.mint).ath_price;
    env.dump_price(&coin, 5_000);
    env.sample_for(&coin, None, 900);
    let v = env.vault(&coin.mint);
    assert_eq!(v.ath_price, ath);
    assert_eq!(v.floor_price, ath * 7_500 / 10_000);
}

#[test]
fn new_ath_must_persist_for_the_confirmation_period() {
    let mut env = Env::new();
    env.initialize(Params { ath_confirm_secs: 300, ..default_params() }).unwrap();
    let coin = env.launch(2_500);
    env.sample_for(&coin, None, 630);
    // with confirmation the first ATH also needs to persist
    env.sample_for(&coin, None, 300);
    let first = env.vault(&coin.mint).ath_price;
    assert!(first > 0);

    let (vtok, vsol) = env.curve_reserves(&coin.mint);
    env.set_curve_reserves(&coin.mint, vtok, vsol * 2);
    env.sample_for(&coin, None, 600); // TWAP now fully at 2×, but only just
    let mid = env.vault(&coin.mint).ath_price;
    env.sample_for(&coin, None, 330);
    let confirmed = env.vault(&coin.mint).ath_price;
    assert!(mid < confirmed, "ATH should only rise after the confirmation period");
    assert!(confirmed > first);
}

// ---- defend ---------------------------------------------------------------------------------------

#[test]
fn defend_needs_a_floor() {
    let mut env = Env::ready();
    let coin = funded_coin(&mut env, 2_500);
    assert_err(&env.defend(&coin, None), HoldfastError::NoFloor);
}

#[test]
fn defend_only_at_or_below_the_floor() {
    let mut env = Env::ready();
    let coin = funded_coin(&mut env, 2_500);
    env.establish_ath(&coin);
    env.dump_price(&coin, 8_000); // −20%, floor is −25%
    assert_err(&env.defend(&coin, None), HoldfastError::PriceAboveFloor);
}

#[test]
fn defend_spends_ten_percent_of_the_floor_vault_and_tokens_go_to_holders() {
    let mut env = Env::ready();
    let coin = funded_coin(&mut env, 2_500);
    env.establish_ath(&coin);
    env.dump_price(&coin, 7_000);

    let before = env.vault(&coin.mint);
    let treasury_before = env.lamports(&coin.treasury);
    env.defend(&coin, None).expect("defend");
    let after = env.vault(&coin.mint);

    let budget = before.floor_sol / 10;
    assert_eq!(before.floor_sol - after.floor_sol, budget);
    assert_eq!(treasury_before - env.lamports(&coin.treasury), budget);
    let bought = env.token_balance(&coin.treasury_ata);
    assert!(bought > 0);
    assert_eq!(after.holder_tokens, bought);
    assert_eq!(after.defend_count, 1);
    assert_eq!(after.last_defend_ts, env.now());
    // holder SOL, creator and burn buckets untouched
    assert_eq!(
        (after.holder_sol, after.creator_sol, after.platform_sol, after.burn_sol),
        (before.holder_sol, before.creator_sol, before.platform_sol, before.burn_sol)
    );
    // effective price ≤ floor × (1 + tolerance)
    let paid_price = budget as u128 * PRICE_SCALE / bought as u128;
    assert!(paid_price <= after.floor_price * 10_300 / 10_000);
}

#[test]
fn defend_cooldown_and_hourly_limit() {
    let mut env = Env::ready();
    let coin = funded_coin(&mut env, 2_500);
    env.establish_ath(&coin);
    env.dump_price(&coin, 4_000);

    env.defend(&coin, None).unwrap();
    assert_err(&env.defend(&coin, None), HoldfastError::DefendCooldown);
    env.advance(59);
    assert_err(&env.defend(&coin, None), HoldfastError::DefendCooldown);
    env.advance(1);
    env.defend(&coin, None).unwrap();
    for _ in 0..4 {
        env.advance(60);
        env.defend(&coin, None).unwrap();
    }
    assert_eq!(env.vault(&coin.mint).defend_count, 6);
    env.advance(60);
    assert_err(&env.defend(&coin, None), HoldfastError::DefendHourlyLimit);
    // the window resets after an hour
    env.advance(3_600);
    env.defend(&coin, None).unwrap();
    assert_eq!(env.vault(&coin.mint).defend_count, 7);
}

#[test]
fn defend_rejects_tampered_venue_accounts() {
    let mut env = Env::ready();
    let coin = funded_coin(&mut env, 2_500);
    env.establish_ath(&coin);
    env.dump_price(&coin, 7_000);
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 10 * SOL).unwrap();
    let attacker_ata = env.set_ata(&attacker.pubkey(), &coin.mint, TOKEN_2022_PROGRAM, 0);

    // tokens delivered to the attacker instead of the treasury (associated_user = index 5 of the venue list)
    let mut ix = env.defend_ix(&coin, &attacker.pubkey(), 0, None);
    let venue_start = ix.accounts.len() - 18;
    ix.accounts[venue_start + 5] = AccountMeta::new(attacker_ata, false);
    assert_err(&env.send(&[ix], &[&attacker]), HoldfastError::InvalidVenueAccounts);

    // attacker as the paying user
    let mut ix = env.defend_ix(&coin, &attacker.pubkey(), 0, None);
    ix.accounts[venue_start + 6] = AccountMeta::new(attacker.pubkey(), true);
    assert_err(&env.send(&[ix], &[&attacker]), HoldfastError::InvalidVenueAccounts);

    // a different program behind the venue list
    let mut ix = env.defend_ix(&coin, &attacker.pubkey(), 0, None);
    ix.accounts[venue_start + 11] = AccountMeta::new_readonly(PUMP_AMM_PROGRAM_ID, false);
    assert_err(&env.send(&[ix], &[&attacker]), HoldfastError::InvalidVenueAccounts);

    // truncated list
    let mut ix = env.defend_ix(&coin, &attacker.pubkey(), 0, None);
    ix.accounts.truncate(venue_start + 10);
    assert_err(&env.send(&[ix], &[&attacker]), HoldfastError::InvalidVenueAccounts);

    assert_eq!(env.vault(&coin.mint).defend_count, 0);
    assert_eq!(env.token_balance(&attacker_ata), 0);
}

#[test]
fn defend_survives_a_misbehaving_venue() {
    let mut env = Env::ready();
    let coin = funded_coin(&mut env, 2_500);
    env.establish_ath(&coin);
    env.dump_price(&coin, 7_000);
    let before = env.vault(&coin.mint).floor_sol;

    // venue delivers half the tokens (ignoring min_out) → vault's own check rejects
    env.set_raw(env.pump_global, PUMP_PROGRAM_ID, vec![1u8; 8]);
    assert_err(&env.defend(&coin, None), HoldfastError::SlippageExceeded);
    // venue takes 2× the SOL → rejected
    env.set_raw(env.pump_global, PUMP_PROGRAM_ID, vec![2u8; 8]);
    assert_err(&env.defend(&coin, None), HoldfastError::OverspentSwap);

    assert_eq!(env.vault(&coin.mint).floor_sol, before);
    env.set_raw(env.pump_global, PUMP_PROGRAM_ID, vec![0u8; 8]);
    env.defend(&coin, None).unwrap();
}

#[test]
fn caller_min_out_is_respected() {
    let mut env = Env::ready();
    let coin = funded_coin(&mut env, 2_500);
    env.establish_ath(&coin);
    env.dump_price(&coin, 7_000);
    let caller = Keypair::new();
    env.svm.airdrop(&caller.pubkey(), SOL).unwrap();
    let ix = env.defend_ix(&coin, &caller.pubkey(), u64::MAX / 2, None);
    assert!(env.send(&[ix], &[&caller]).is_err());
    assert_eq!(env.vault(&coin.mint).defend_count, 0);
}

#[test]
fn paused_blocks_defend() {
    let mut env = Env::ready();
    let coin = funded_coin(&mut env, 2_500);
    env.establish_ath(&coin);
    env.dump_price(&coin, 7_000);
    let admin = env.admin.insecure_clone();
    let ix = env.admin_ix(&admin.pubkey(), holdfast_vault::instruction::SetPaused { paused: true });
    env.send(&[ix], &[&admin]).unwrap();
    assert_err(&env.defend(&coin, None), HoldfastError::Paused);
}

// ---- graduation / PumpSwap -------------------------------------------------------------------------

#[test]
fn graduation_switches_to_the_canonical_pool_and_defends_there() {
    let mut env = Env::ready();
    let coin = funded_coin(&mut env, 2_500);
    let pool = env.set_pool(&coin.mint, &coin.treasury, 200_000_000_000_000, 85 * SOL, 0);

    // not complete yet
    let payer = env.payer.insecure_clone();
    let ix = env.graduate_ix(&coin, &pool);
    assert_err(&env.send(&[ix], &[&payer]), HoldfastError::CurveNotComplete);

    env.set_curve_complete(&coin.mint);
    // a non-canonical pool is rejected
    let fake = Pool { address: env.pump_global, ..env.set_pool(&coin.mint, &coin.treasury, 1, 1, 0) };
    let pool = env.set_pool(&coin.mint, &coin.treasury, 200_000_000_000_000, 85 * SOL, 0);
    let ix = env.graduate_ix(&coin, &fake);
    assert_err(&env.send(&[ix], &[&payer]), HoldfastError::NotCanonicalPool);

    let ix = env.graduate_ix(&coin, &pool);
    env.send(&[ix], &[&payer]).unwrap();
    let v = env.vault(&coin.mint);
    assert_eq!(v.venue, VENUE_AMM);
    assert_eq!(v.market, pool.address);

    // curve accounts no longer price the coin
    assert_err(&env.update_ath(&coin, None), HoldfastError::WrongPriceAccount);
    env.sample_for(&coin, Some(&pool), 630);
    let ath = env.vault(&coin.mint).ath_price;
    assert_eq!(ath, 85 * SOL as u128 * PRICE_SCALE / 200_000_000_000_000);

    // dump on the pool and defend through PumpSwap
    env.set_pool_quote(&pool, 60 * SOL);
    let before = env.vault(&coin.mint);
    env.defend(&coin, Some(&pool)).expect("amm defend");
    let after = env.vault(&coin.mint);
    assert_eq!(before.floor_sol - after.floor_sol, before.floor_sol / 10);
    assert!(after.holder_tokens > 0);
    assert_eq!(env.token_balance(&coin.treasury_ata), after.holder_tokens);
    assert_eq!(env.token_balance(&coin.treasury_wsol), 0, "no WSOL left behind");
}

#[test]
fn pool_price_uses_signed_virtual_quote_reserves() {
    let mut env = Env::ready();
    let coin = funded_coin(&mut env, 2_500);
    env.set_curve_complete(&coin.mint);
    let pool = env.set_pool(&coin.mint, &coin.treasury, 100_000_000_000_000, 50 * SOL, -(10 * SOL as i128));
    let payer = env.payer.insecure_clone();
    let ix = env.graduate_ix(&coin, &pool);
    env.send(&[ix], &[&payer]).unwrap();
    env.sample_for(&coin, Some(&pool), 630);
    assert_eq!(env.vault(&coin.mint).ath_price, 40 * SOL as u128 * PRICE_SCALE / 100_000_000_000_000);
}

#[test]
fn a_lazily_prepared_treasury_defends_on_the_curve_and_after_graduation() {
    let mut env = Env::ready();
    let coin = env.launch_bare(2_500);
    env.collect(&coin, 10 * SOL).unwrap();
    env.establish_ath(&coin);
    env.dump_price(&coin, 7_000);
    // the treasury has no token accounts yet: defend cannot run
    assert!(env.defend(&coin, None).is_err());

    env.prepare_treasury(&coin, Some(PUMP_PROGRAM_ID)).unwrap();
    let before = env.vault(&coin.mint);
    env.defend(&coin, None).expect("curve defend");
    let after = env.vault(&coin.mint);
    assert_eq!(before.floor_sol - after.floor_sol, before.floor_sol / 10, "no rent inside the buyback");
    assert!(after.holder_tokens > 0);

    // graduation: PumpSwap needs its own accumulator, prepared the same way
    env.set_curve_complete(&coin.mint);
    let pool = env.set_pool(&coin.mint, &coin.treasury, 200_000_000_000_000, 85 * SOL, 0);
    let payer = env.payer.insecure_clone();
    let ix = env.graduate_ix(&coin, &pool);
    env.send(&[ix], &[&payer]).unwrap();
    let amm_accumulator = user_volume_accumulator_pda(&coin.treasury, &PUMP_AMM_PROGRAM_ID);
    assert!(!env.exists(&amm_accumulator));
    let before = env.vault(&coin.mint);
    env.prepare_treasury(&coin, Some(PUMP_AMM_PROGRAM_ID)).unwrap();
    let after = env.vault(&coin.mint);
    assert_eq!(env.svm.get_account(&amm_accumulator).unwrap().owner, PUMP_AMM_PROGRAM_ID);
    assert_eq!(before.floor_sol - after.floor_sol, env.svm.minimum_balance_for_rent_exemption(137));
}
