use anchor_lang::prelude::Pubkey;
use holdfast_vault_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

struct Holder {
    wallet: Pubkey,
    token_account: Pubkey,
}

fn holder(env: &mut Env, coin: &Coin) -> Holder {
    let wallet = Keypair::new().pubkey();
    env.svm.airdrop(&wallet, SOL).unwrap();
    let token_account = env.set_ata(&wallet, &coin.mint, TOKEN_2022_PROGRAM, 1_000);
    Holder { wallet, token_account }
}

fn entry(index: u32, sol: u64, tokens: u64) -> PayoutEntry {
    PayoutEntry { index, sol, tokens }
}

/// Coin with 3 SOL in the holder bucket and bought-back tokens in the holder pool.
fn coin_with_pots(env: &mut Env) -> Coin {
    let coin = env.launch(2_500);
    env.collect(&coin, 10 * SOL).unwrap();
    env.establish_ath(&coin);
    env.dump_price(&coin, 7_000);
    env.defend(&coin, None).unwrap();
    coin
}

#[test]
fn a_round_pays_sol_and_tokens_to_wallets() {
    let mut env = Env::ready();
    let coin = coin_with_pots(&mut env);
    let v = env.vault(&coin.mint);
    let token_pot = v.holder_tokens;
    let (a, b) = (holder(&mut env, &coin), holder(&mut env, &coin));

    env.open_round(&coin, 1, 2 * SOL, token_pot, 2).unwrap();
    let r = env.round(&coin.mint, 1).unwrap();
    assert_eq!((r.sol_pot, r.token_pot, r.recipient_count, r.snapshot_hash), (2 * SOL, token_pot, 2, [7u8; 32]));

    let a_before = env.lamports(&a.wallet);
    env.payout(
        &coin,
        1,
        vec![entry(0, 1_500_000_000, token_pot / 2), entry(1, 500_000_000, token_pot - token_pot / 2)],
        &[(a.wallet, Some(a.token_account)), (b.wallet, Some(b.token_account))],
    )
    .unwrap();
    assert_eq!(env.lamports(&a.wallet) - a_before, 1_500_000_000);
    assert_eq!(env.token_balance(&a.token_account), 1_000 + token_pot / 2);
    assert_eq!(env.token_balance(&b.token_account), 1_000 + token_pot - token_pot / 2);

    let after = env.vault(&coin.mint);
    assert_eq!(after.holder_sol, v.holder_sol - 2 * SOL);
    assert_eq!(after.holder_tokens, 0);
    assert_eq!(after.total_paid_sol, 2 * SOL);
    assert_eq!(env.token_balance(&coin.treasury_ata), 0);

    let keeper_before = env.lamports(&env.keeper.pubkey());
    env.close_round(&coin, 1).unwrap();
    assert!(env.round(&coin.mint, 1).is_none());
    assert!(env.lamports(&env.keeper.pubkey()) > keeper_before, "round rent refunded");
    assert!(!env.vault(&coin.mint).round_open);
}

#[test]
fn payouts_can_never_exceed_the_committed_pot() {
    let mut env = Env::ready();
    let coin = coin_with_pots(&mut env);
    let (a, b) = (holder(&mut env, &coin), holder(&mut env, &coin));
    env.open_round(&coin, 1, SOL, 0, 2).unwrap();
    let res = env.payout(&coin, 1, vec![entry(0, 700_000_000, 0), entry(1, 400_000_000, 0)], &[(a.wallet, None), (b.wallet, None)]);
    assert_err(&res, HoldfastError::PotExceeded);
    // split across batches the cap still holds
    env.payout(&coin, 1, vec![entry(0, 700_000_000, 0)], &[(a.wallet, None)]).unwrap();
    let res = env.payout(&coin, 1, vec![entry(1, 300_000_001, 0)], &[(b.wallet, None)]);
    assert_err(&res, HoldfastError::PotExceeded);
    env.payout(&coin, 1, vec![entry(1, 300_000_000, 0)], &[(b.wallet, None)]).unwrap();
}

#[test]
fn the_pot_cannot_exceed_the_holder_bucket() {
    let mut env = Env::ready();
    let coin = coin_with_pots(&mut env);
    let v = env.vault(&coin.mint);
    assert_err(&env.open_round(&coin, 1, v.holder_sol + 1, 0, 1), HoldfastError::PotExceedsBucket);
    assert_err(&env.open_round(&coin, 1, 0, v.holder_tokens + 1, 1), HoldfastError::PotExceedsBucket);
    // the floor bucket is not reachable through payouts
    assert_err(&env.open_round(&coin, 1, v.holder_sol + v.floor_sol, 0, 1), HoldfastError::PotExceedsBucket);
}

#[test]
fn each_recipient_index_is_paid_once() {
    let mut env = Env::ready();
    let coin = coin_with_pots(&mut env);
    let a = holder(&mut env, &coin);
    env.open_round(&coin, 1, SOL, 0, 3).unwrap();
    env.payout(&coin, 1, vec![entry(0, 100_000_000, 0)], &[(a.wallet, None)]).unwrap();
    let res = env.payout(&coin, 1, vec![entry(0, 100_000_000, 0)], &[(a.wallet, None)]);
    assert_err(&res, HoldfastError::AlreadyPaid);
    let res = env.payout(&coin, 1, vec![entry(3, 100_000_000, 0)], &[(a.wallet, None)]);
    assert_err(&res, HoldfastError::RecipientIndexOutOfRange);
}

#[test]
fn only_regular_wallets_receive_payouts() {
    let mut env = Env::ready();
    let coin = coin_with_pots(&mut env);
    env.open_round(&coin, 1, SOL, 0, 8).unwrap();

    // a PDA (off-curve), e.g. a pool or another program's vault
    let pda = Pubkey::find_program_address(&[b"anything"], &holdfast_vault::ID).0;
    env.svm.airdrop(&pda, SOL).unwrap();
    assert_err(&env.payout(&coin, 1, vec![entry(0, 1_000_000, 0)], &[(pda, None)]), HoldfastError::NotAWallet);
    // the coin's own bonding curve (program-owned)
    assert_err(&env.payout(&coin, 1, vec![entry(1, 1_000_000, 0)], &[(coin.bonding_curve, None)]), HoldfastError::NotAWallet);
    // the treasury itself
    assert_err(&env.payout(&coin, 1, vec![entry(2, 1_000_000, 0)], &[(coin.treasury, None)]), HoldfastError::NotAWallet);
    // a token account
    let a = holder(&mut env, &coin);
    assert_err(&env.payout(&coin, 1, vec![entry(3, 1_000_000, 0)], &[(a.token_account, None)]), HoldfastError::NotAWallet);
    // an executable account
    assert_err(&env.payout(&coin, 1, vec![entry(4, 1_000_000, 0)], &[(PUMP_PROGRAM, None)]), HoldfastError::NotAWallet);
    // a normal wallet works
    env.payout(&coin, 1, vec![entry(5, 1_000_000, 0)], &[(a.wallet, None)]).unwrap();
}

const PUMP_PROGRAM: Pubkey = holdfast_vault::constants::PUMP_PROGRAM_ID;

#[test]
fn token_payouts_go_to_the_wallets_own_token_account() {
    let mut env = Env::ready();
    let coin = coin_with_pots(&mut env);
    let tokens = env.vault(&coin.mint).holder_tokens;
    let (a, b) = (holder(&mut env, &coin), holder(&mut env, &coin));
    env.open_round(&coin, 1, 0, tokens, 2).unwrap();
    // a's entry pointing at b's token account
    let res = env.payout(&coin, 1, vec![entry(0, 0, 10)], &[(a.wallet, Some(b.token_account))]);
    assert_err(&res, HoldfastError::InvalidRecipientTokenAccount);
    // missing token account
    let res = env.payout(&coin, 1, vec![entry(0, 0, 10)], &[(a.wallet, None)]);
    assert_err(&res, HoldfastError::RemainingAccountsMismatch);
    // extra unexpected accounts
    let res = env.payout(&coin, 1, vec![entry(0, 1, 0)], &[(a.wallet, Some(a.token_account))]);
    assert_err(&res, HoldfastError::RemainingAccountsMismatch);
    env.payout(&coin, 1, vec![entry(0, 0, 10)], &[(a.wallet, Some(a.token_account))]).unwrap();
}

#[test]
fn rounds_are_sequential_spaced_and_keeper_only() {
    let mut env = Env::ready();
    let coin = coin_with_pots(&mut env);
    assert_err(&env.open_round(&coin, 2, 1, 0, 1), HoldfastError::InvalidRoundId);
    assert_err(&env.open_round(&coin, 1, 1, 0, 0), HoldfastError::InvalidRecipientCount);
    assert_err(&env.open_round(&coin, 1, 1, 0, 8_193), HoldfastError::InvalidRecipientCount);

    let rando = Keypair::new();
    env.svm.airdrop(&rando.pubkey(), SOL).unwrap();
    let ix = env.open_round_ix(&coin, &rando.pubkey(), 1, 1, 0, 1);
    assert!(env.send(&[ix], &[&rando]).is_err());

    env.open_round(&coin, 1, 1, 0, 1).unwrap();
    // one open round at a time (fails on the round PDA / RoundAlreadyOpen)
    assert!(env.open_round(&coin, 2, 1, 0, 1).is_err());
    env.close_round(&coin, 1).unwrap();
    assert_err(&env.open_round(&coin, 2, 1, 0, 1), HoldfastError::RoundTooSoon);
    env.advance(60);
    env.open_round(&coin, 2, 1, 0, 1).unwrap();
}

#[test]
fn unpaid_amounts_stay_in_the_bucket_for_the_next_round() {
    let mut env = Env::ready();
    let coin = coin_with_pots(&mut env);
    let a = holder(&mut env, &coin);
    let before = env.vault(&coin.mint).holder_sol;
    env.open_round(&coin, 1, SOL, 0, 2).unwrap();
    env.payout(&coin, 1, vec![entry(0, 400_000_000, 0)], &[(a.wallet, None)]).unwrap();
    env.close_round(&coin, 1).unwrap();
    assert_eq!(env.vault(&coin.mint).holder_sol, before - 400_000_000);
}

#[test]
fn first_payout_to_an_empty_wallet_must_cover_rent() {
    let mut env = Env::ready();
    let coin = coin_with_pots(&mut env);
    let empty = Keypair::new().pubkey();
    env.open_round(&coin, 1, SOL, 0, 2).unwrap();
    // below the rent-exempt minimum: refused, the off-chain worker carries it instead
    assert_err(&env.payout(&coin, 1, vec![entry(0, 100_000, 0)], &[(empty, None)]), HoldfastError::RecipientBelowRent);
    env.payout(&coin, 1, vec![entry(1, 1_000_000, 0)], &[(empty, None)]).unwrap();
    assert_eq!(env.lamports(&empty), 1_000_000);
}

#[test]
fn paused_blocks_rounds_and_payouts() {
    let mut env = Env::ready();
    let coin = coin_with_pots(&mut env);
    let a = holder(&mut env, &coin);
    env.open_round(&coin, 1, SOL, 0, 1).unwrap();
    let admin = env.admin.insecure_clone();
    let ix = env.admin_ix(&admin.pubkey(), holdfast_vault::instruction::SetPaused { paused: true });
    env.send(&[ix], &[&admin]).unwrap();
    assert_err(&env.payout(&coin, 1, vec![entry(0, 1_000_000, 0)], &[(a.wallet, None)]), HoldfastError::Paused);
    // closing (no funds move) still works
    env.close_round(&coin, 1).unwrap();
    env.advance(120);
    assert_err(&env.open_round(&coin, 2, 1, 0, 1), HoldfastError::Paused);
}
