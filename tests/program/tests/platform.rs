//! The platform's 10%: booked by `collect_fees`, swept only to `Config::platform_treasury`.

use anchor_lang::prelude::Pubkey;
use holdfast_vault_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn sweeps_go_to_the_configured_treasury_only() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    env.collect(&coin, 10 * SOL).unwrap();
    // nothing can leave before the admin names the treasury
    let ix = env.sweep_platform_fees_ix(&coin, &Pubkey::default());
    let payer = env.payer.insecure_clone();
    assert_err(&env.send(&[ix], &[&payer]), HoldfastError::PlatformTreasuryNotSet);

    let platform = env.platform.pubkey();
    env.set_platform_treasury(platform).unwrap();
    assert_eq!(env.config().platform_treasury, platform);
    // any other destination is refused
    let attacker = Keypair::new().pubkey();
    let ix = env.sweep_platform_fees_ix(&coin, &attacker);
    assert!(env.send(&[ix], &[&payer]).is_err());
    assert_eq!(env.lamports(&attacker), 0);

    let before = env.vault(&coin.mint);
    let platform_before = env.lamports(&platform);
    // permissionless: the payer cranks it, the platform treasury receives exactly the bucket
    env.sweep_platform_fees(&coin).unwrap();
    let after = env.vault(&coin.mint);
    assert_eq!(env.lamports(&platform), platform_before + SOL);
    assert_eq!((after.platform_sol, after.total_platform_swept), (0, SOL));
    assert_eq!(
        (after.floor_sol, after.holder_sol, after.creator_sol, after.burn_sol),
        (before.floor_sol, before.holder_sol, before.creator_sol, before.burn_sol)
    );
    let rent = env.svm.minimum_balance_for_rent_exemption(0);
    assert_eq!(env.lamports(&coin.treasury) - rent, after.accounted_lamports().unwrap());
    assert_err(&env.sweep_platform_fees(&coin), HoldfastError::NothingToSweep);
}

#[test]
fn only_the_admin_sets_the_treasury_and_never_to_the_default_key() {
    let mut env = Env::ready();
    assert_err(&env.set_platform_treasury(Pubkey::default()), HoldfastError::PlatformTreasuryNotSet);
    let rando = Keypair::new();
    env.svm.airdrop(&rando.pubkey(), SOL).unwrap();
    let ix = env.admin_ix(&rando.pubkey(), holdfast_vault::instruction::SetPlatformTreasury { platform_treasury: rando.pubkey() });
    assert!(env.send(&[ix], &[&rando]).is_err());
    assert_eq!(env.config().platform_treasury, Pubkey::default());
}

#[test]
fn sweeps_stop_while_paused() {
    let mut env = Env::ready();
    let platform = env.platform.pubkey();
    env.set_platform_treasury(platform).unwrap();
    let coin = env.launch(2_500);
    env.collect(&coin, SOL).unwrap();
    let admin = env.admin.insecure_clone();
    let ix = env.admin_ix(&admin.pubkey(), holdfast_vault::instruction::SetPaused { paused: true });
    env.send(&[ix], &[&admin]).unwrap();
    assert_err(&env.sweep_platform_fees(&coin), HoldfastError::Paused);
}
