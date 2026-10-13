use holdfast_vault_tests::*;
use holdfast_vault::state::Params;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn only_the_upgrade_authority_can_initialize() {
    let mut env = Env::new();
    let intruder = Keypair::new();
    env.svm.airdrop(&intruder.pubkey(), 10 * SOL).unwrap();
    let ix = env.initialize_ix(&intruder.pubkey(), default_params());
    let res = env.send(&[ix], &[&intruder]);
    assert_err(&res, HoldfastError::InvalidOwner);

    env.initialize(default_params()).expect("upgrade authority initializes");
    let config = env.config();
    assert_eq!(config.admin, env.admin.pubkey());
    assert_eq!(config.keeper, env.keeper.pubkey());
    assert_eq!(config.launcher, env.launcher.pubkey());
    assert_eq!(config.hold_mint, Default::default());
    // cannot initialize twice
    assert!(env.initialize(default_params()).is_err());
}

#[test]
fn params_are_range_checked() {
    let mut env = Env::new();
    let bad = [
        Params { defend_cooldown_secs: 0, ..default_params() },
        Params { max_defends_per_hour: 0, ..default_params() },
        Params { max_defends_per_hour: 61, ..default_params() },
        Params { defend_price_tolerance_bps: 1_001, ..default_params() },
        Params { twap_window_secs: 60, ..default_params() },
        // 31 observations × 10s cannot cover a 600s window
        Params { twap_min_sample_interval_secs: 10, ..default_params() },
        Params { twap_max_gap_secs: 10, ..default_params() },
        Params { ath_confirm_secs: 7_200, ..default_params() },
        Params { max_burn_slippage_bps: 5_000, ..default_params() },
        Params { min_round_interval_secs: 10, ..default_params() },
    ];
    for params in bad {
        assert_err(&env.initialize(params), HoldfastError::InvalidParams);
    }
    env.initialize(default_params()).unwrap();

    let admin = env.admin.insecure_clone();
    let ix = env.admin_ix(&admin.pubkey(), holdfast_vault::instruction::SetParams { params: Params { defend_cooldown_secs: 5, ..default_params() } });
    assert_err(&env.send(&[ix], &[&admin]), HoldfastError::InvalidParams);
    let ix = env.admin_ix(&admin.pubkey(), holdfast_vault::instruction::SetParams { params: Params { defend_cooldown_secs: 120, ..default_params() } });
    env.send(&[ix], &[&admin]).unwrap();
    assert_eq!(env.config().params.defend_cooldown_secs, 120);
}

#[test]
fn admin_instructions_require_the_admin() {
    let mut env = Env::ready();
    let intruder = Keypair::new();
    env.svm.airdrop(&intruder.pubkey(), 10 * SOL).unwrap();
    for data in [
        holdfast_vault::instruction::SetKeeper { keeper: intruder.pubkey() }.into_data(),
        holdfast_vault::instruction::SetLauncher { launcher: intruder.pubkey() }.into_data(),
        holdfast_vault::instruction::SetPaused { paused: true }.into_data(),
        holdfast_vault::instruction::TransferAdmin { new_admin: intruder.pubkey() }.into_data(),
    ] {
        let mut ix = env.admin_ix(&intruder.pubkey(), holdfast_vault::instruction::SetPaused { paused: true });
        ix.data = data;
        assert!(env.send(&[ix], &[&intruder]).is_err());
    }
    assert_eq!(env.config().keeper, env.keeper.pubkey());
    assert!(!env.config().paused);
}

#[test]
fn admin_transfer_is_two_step() {
    let mut env = Env::ready();
    let admin = env.admin.insecure_clone();
    let next = Keypair::new();
    env.svm.airdrop(&next.pubkey(), SOL).unwrap();
    let transfer = env.admin_ix(&admin.pubkey(), holdfast_vault::instruction::TransferAdmin { new_admin: next.pubkey() });
    env.send(&[transfer], &[&admin]).unwrap();
    assert_eq!(env.config().admin, admin.pubkey());

    let accept = ix(
        holdfast_vault::accounts::AcceptAdmin { new_admin: next.pubkey(), config: config_pda() },
        holdfast_vault::instruction::AcceptAdmin {},
    );
    env.send(&[accept], &[&next]).unwrap();
    assert_eq!(env.config().admin, next.pubkey());
}

#[test]
fn hold_mint_can_be_set_only_once() {
    let mut env = Env::ready();
    let admin = env.admin.insecure_clone();
    let hold = env.create_mint(TOKEN_2022_PROGRAM, 1_000);
    let other = env.create_mint(TOKEN_2022_PROGRAM, 1_000);
    let ix = env.set_hold_mint_ix(&admin.pubkey(), &hold);
    env.send(&[ix], &[&admin]).unwrap();
    assert_eq!(env.config().hold_mint, hold);
    let ix = env.set_hold_mint_ix(&admin.pubkey(), &other);
    assert_err(&env.send(&[ix], &[&admin]), HoldfastError::HoldMintAlreadySet);
    assert_eq!(env.config().hold_mint, hold);
}

trait IntoData {
    fn into_data(self) -> Vec<u8>;
}
impl<T: anchor_lang::InstructionData> IntoData for T {
    fn into_data(self) -> Vec<u8> {
        self.data()
    }
}
