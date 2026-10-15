//! The launcher needs no SOL of its own: the deposit reimburses the vault's rent inside the launch
//! transaction, before `init_coin` spends it (apps/launcher/src/tx.ts, transaction B / L).

use anchor_lang::{solana_program::system_instruction, Space};
use holdfast_vault::state::CoinVault;
use holdfast_vault_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn a_launcher_with_no_sol_launches_when_the_deposit_reimburses_it() {
    let mut env = Env::ready();
    let launcher = env.launcher.insecure_clone();
    env.svm
        .set_account(launcher.pubkey(), Default::default())
        .unwrap();
    assert_eq!(env.lamports(&launcher.pubkey()), 0);

    let deposit = Keypair::new();
    env.svm.airdrop(&deposit.pubkey(), SOL).unwrap();
    let coin = env.prepare_coin(2_500);
    // What `initReimbursement` pays: the vault's rent plus the rent-exempt minimum `init_coin` gives the treasury.
    let rent = env
        .svm
        .minimum_balance_for_rent_exemption(8 + CoinVault::INIT_SPACE)
        + env.svm.minimum_balance_for_rent_exemption(0);
    let reimburse = system_instruction::transfer(&deposit.pubkey(), &launcher.pubkey(), rent);
    let init = env.init_coin_ix(&coin, &launcher.pubkey());
    env.send(&[reimburse, init], &[&deposit, &launcher])
        .expect("launch with an empty launcher");

    assert!(env.exists(&coin.vault));
    assert_eq!(env.lamports(&launcher.pubkey()), 0);
}
