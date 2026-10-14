//! The creator's 15%: booked by `collect_fees`, claimed only by the creator recorded at `init_coin`.

use anchor_lang::prelude::Pubkey;
use holdfast_vault_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn the_creator_claims_exactly_its_bucket() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    env.collect(&coin, 10 * SOL).unwrap();
    let before = env.vault(&coin.mint);
    assert_eq!(before.creator_sol, 1_500_000_000);
    let wallet_before = env.lamports(&coin.creator);

    env.claim_creator_fees(&coin).unwrap();
    let after = env.vault(&coin.mint);
    // the creator signs and pays the transaction fee
    assert_eq!(env.lamports(&coin.creator), wallet_before + 1_500_000_000 - 5_000);
    assert_eq!((after.creator_sol, after.total_creator_claimed), (0, 1_500_000_000));
    assert_eq!((after.floor_sol, after.holder_sol, after.burn_sol), (before.floor_sol, before.holder_sol, before.burn_sol));
    let rent = env.svm.minimum_balance_for_rent_exemption(0);
    assert_eq!(env.lamports(&coin.treasury) - rent, after.accounted_lamports().unwrap());

    // nothing left until new fees arrive
    assert_err(&env.claim_creator_fees(&coin), HoldfastError::NothingToClaim);
    env.collect(&coin, SOL).unwrap();
    env.claim_creator_fees(&coin).unwrap();
    assert_eq!(env.vault(&coin.mint).total_creator_claimed, 1_650_000_000);
}

#[test]
fn nobody_else_can_claim() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    env.collect(&coin, 10 * SOL).unwrap();
    let rando = Keypair::new();
    env.svm.airdrop(&rando.pubkey(), SOL).unwrap();
    for signer in [env.admin.insecure_clone(), env.keeper.insecure_clone(), env.launcher.insecure_clone(), rando] {
        let ix = env.claim_creator_fees_ix(&coin, &signer.pubkey());
        assert!(env.send(&[ix], &[&signer]).is_err(), "{} must not claim", signer.pubkey());
    }
    assert_eq!(env.vault(&coin.mint).creator_sol, 1_500_000_000);
}

#[test]
fn claims_stop_while_paused() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    env.collect(&coin, SOL).unwrap();
    let admin = env.admin.insecure_clone();
    for paused in [true, false] {
        let ix = env.admin_ix(&admin.pubkey(), holdfast_vault::instruction::SetPaused { paused });
        env.send(&[ix], &[&admin]).unwrap();
        if paused {
            assert_err(&env.claim_creator_fees(&coin), HoldfastError::Paused);
        }
    }
    env.claim_creator_fees(&coin).unwrap();
}

#[test]
fn init_coin_needs_a_creator_wallet() {
    let mut env = Env::ready();
    let launcher = env.launcher.insecure_clone();
    for pick in 0..3 {
        let mut coin = env.prepare_coin(2_500);
        coin.creator = [Pubkey::default(), coin.treasury, coin.vault][pick];
        let ix = env.init_coin_ix(&coin, &launcher.pubkey());
        assert_err(&env.send(&[ix], &[&launcher]), HoldfastError::InvalidCreator);
    }
}
