//! Acceptance: "there is no way to take SOL out of the vault except the four allowed paths": floor
//! buybacks, holder payouts, $HOLD burns and the creator's claim of its own bucket.

use anchor_lang::prelude::Pubkey;
use holdfast_vault::constants::PUMP_PROGRAM_ID;
use holdfast_vault_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Every instruction the program exposes. If this list changes, the change must be reviewed against
/// the no-withdraw invariant (docs/program.md) before updating the test.
const EXPECTED_INSTRUCTIONS: &[&str] = &[
    "accept_admin",
    "burn_hold",
    "claim_creator_fees",
    "close_round",
    "collect_fees",
    "defend",
    "graduate",
    "init_coin",
    "initialize",
    "open_round",
    "payout",
    "prepare_treasury",
    "set_hold_mint",
    "set_keeper",
    "set_launcher",
    "set_params",
    "set_paused",
    "transfer_admin",
    "update_ath",
];

#[test]
fn the_instruction_set_has_no_withdraw() {
    let idl_path = format!("{}/../../target/idl/holdfast_vault.json", env!("CARGO_MANIFEST_DIR"));
    let idl: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(idl_path).expect("run anchor build first")).unwrap();
    let mut names: Vec<&str> = idl["instructions"].as_array().unwrap().iter().map(|ix| ix["name"].as_str().unwrap()).collect();
    names.sort();
    assert_eq!(names, EXPECTED_INSTRUCTIONS, "new instructions must be reviewed against the no-withdraw invariant");
}

#[test]
fn admin_and_keeper_powers_cannot_move_funds() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    env.collect(&coin, 20 * SOL).unwrap();
    let treasury_before = env.lamports(&coin.treasury);
    let admin = env.admin.insecure_clone();
    let new_keeper = Keypair::new();
    for data in [
        anchor_lang::InstructionData::data(&holdfast_vault::instruction::SetKeeper { keeper: new_keeper.pubkey() }),
        anchor_lang::InstructionData::data(&holdfast_vault::instruction::SetLauncher { launcher: admin.pubkey() }),
        anchor_lang::InstructionData::data(&holdfast_vault::instruction::SetParams { params: default_params() }),
        anchor_lang::InstructionData::data(&holdfast_vault::instruction::SetPaused { paused: true }),
        anchor_lang::InstructionData::data(&holdfast_vault::instruction::SetPaused { paused: false }),
    ] {
        let mut ix = env.admin_ix(&admin.pubkey(), holdfast_vault::instruction::SetPaused { paused: false });
        ix.data = data;
        env.send(&[ix], &[&admin]).unwrap();
    }
    assert_eq!(env.lamports(&coin.treasury), treasury_before);
}

#[test]
fn round_rent_only_returns_to_its_payer() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    env.collect(&coin, SOL).unwrap();
    env.open_round(&coin, 1, 1, 0, 1).unwrap();
    let keeper = env.keeper.insecure_clone();
    let attacker = Keypair::new().pubkey();
    let ix = env.close_round_ix(&coin, &keeper.pubkey(), 1, &attacker);
    assert!(env.send(&[ix], &[&keeper]).is_err());
    assert_eq!(env.lamports(&attacker), 0);
}

#[test]
fn payouts_cannot_reach_the_floor_or_burn_buckets() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    env.collect(&coin, 10 * SOL).unwrap();
    let v = env.vault(&coin.mint);
    // whole holder bucket, then try to keep paying in a new round
    let wallet = Keypair::new().pubkey();
    env.open_round(&coin, 1, v.holder_sol, 0, 2).unwrap();
    env.payout(&coin, 1, vec![PayoutEntry { index: 0, sol: v.holder_sol, tokens: 0 }], &[(wallet, None)]).unwrap();
    env.close_round(&coin, 1).unwrap();
    env.advance(120);
    assert_err(&env.open_round(&coin, 2, 1, 0, 1), HoldfastError::PotExceedsBucket);
    let after = env.vault(&coin.mint);
    assert_eq!((after.floor_sol, after.creator_sol, after.burn_sol, after.holder_sol), (v.floor_sol, v.creator_sol, v.burn_sol, 0));
}

#[test]
fn the_creator_claim_cannot_reach_the_other_buckets() {
    let mut env = Env::ready();
    let coin = env.launch(2_500);
    env.collect(&coin, 10 * SOL).unwrap();
    let v = env.vault(&coin.mint);
    env.claim_creator_fees(&coin).unwrap();
    assert_err(&env.claim_creator_fees(&coin), HoldfastError::NothingToClaim);
    let after = env.vault(&coin.mint);
    assert_eq!((after.floor_sol, after.holder_sol, after.burn_sol, after.creator_sol), (v.floor_sol, v.holder_sol, v.burn_sol, 0));
}

/// Randomised lifecycle: fees, price moves, defends, rounds, creator claims. After every step the
/// treasury's lamports are fully explained by fees in minus the four allowed outflows.
#[test]
fn lamports_are_conserved_across_a_random_lifecycle() {
    let mut env = Env::ready();
    let coin = env.launch_bare(2_500);
    let rent = env.svm.minimum_balance_for_rent_exemption(0);
    let mut seed: u64 = 0x5eed;
    let mut rand = move |n: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % n
    };
    let wallets: Vec<Pubkey> = (0..4).map(|_| Keypair::new().pubkey()).collect();
    for w in &wallets {
        env.svm.airdrop(w, SOL).unwrap();
    }
    let mut round_id = 0u64;

    env.collect(&coin, 5 * SOL).unwrap();
    env.prepare_treasury(&coin, Some(PUMP_PROGRAM_ID)).unwrap();
    env.establish_ath(&coin);
    for step in 0..120 {
        match rand(6) {
            0 => {
                env.collect(&coin, rand(3 * SOL) + 1).unwrap();
            }
            1 => {
                let f = 6_000 + rand(5_000);
                env.dump_price(&coin, f);
            }
            2 => {
                let _ = env.defend(&coin, None);
            }
            3 => {
                let v = env.vault(&coin.mint);
                if !v.round_open && v.holder_sol > 10_000_000 {
                    round_id += 1;
                    let pot = v.holder_sol / 2;
                    if env.open_round(&coin, round_id, pot, v.holder_tokens, 4).is_ok() {
                        let w = wallets[rand(4) as usize];
                        let ta = env.set_ata(&w, &coin.mint, TOKEN_2022_PROGRAM, env.token_balance(&anchor_spl::associated_token::get_associated_token_address_with_program_id(&w, &coin.mint, &TOKEN_2022_PROGRAM)));
                        let tokens = v.holder_tokens;
                        let entries = vec![PayoutEntry { index: 0, sol: pot, tokens }];
                        env.payout(&coin, round_id, entries, &[(w, if tokens > 0 { Some(ta) } else { None })]).unwrap();
                        env.close_round(&coin, round_id).unwrap();
                    } else {
                        round_id -= 1;
                    }
                }
            }
            4 => {
                let _ = env.update_ath(&coin, None);
            }
            _ => {
                if env.vault(&coin.mint).creator_sol > 0 {
                    env.claim_creator_fees(&coin).unwrap();
                }
            }
        }
        env.advance(30 + rand(90) as i64);

        let v = env.vault(&coin.mint);
        let treasury = env.lamports(&coin.treasury);
        assert!(treasury - rent >= v.accounted_lamports().unwrap(), "step {step}: buckets exceed treasury");
        assert_eq!(
            treasury - rent,
            v.total_fees - v.total_defended_sol - v.total_paid_sol - v.total_burn_sol - v.total_treasury_rent - v.total_creator_claimed,
            "step {step}: lamports not explained by fees − allowed outflows"
        );
        assert_eq!(env.token_balance(&coin.treasury_ata), v.holder_tokens, "step {step}: token pool mismatch");
    }
    let v = env.vault(&coin.mint);
    assert!(v.defend_count > 0 && v.total_paid_sol > 0 && v.total_creator_claimed > 0, "lifecycle should exercise defends, payouts and claims");
}
