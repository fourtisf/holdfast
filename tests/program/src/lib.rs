//! LiteSVM harness for the Holdfast vault program.
//!
//! Loads the compiled `holdfast_vault.so` as an upgradeable program (so `initialize`'s upgrade-authority
//! check is real) and the pump.fun / PumpSwap stand-ins from `tests/mocks` at the real pump program ids.
//! Pump accounts (bonding curve, pool) are written byte-for-byte in their real layouts.
//!
//! Build the programs first: `anchor build -p holdfast_vault` and
//! `cargo build-sbf --manifest-path tests/mocks/<mock>/Cargo.toml --sbf-out-dir target/deploy`.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::bpf_loader_upgradeable::{self, UpgradeableLoaderState};
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address_with_program_id as ata;
use anchor_spl::token::spl_token;
use anchor_spl::token_2022::spl_token_2022;
use holdfast_vault::constants::*;
use holdfast_vault::state::{CoinVault, Config, Params, PayoutRound};
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_program_option::COption;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub use holdfast_vault::errors::HoldfastError;
pub use holdfast_vault::instructions::PayoutEntry;

pub const SOL: u64 = 1_000_000_000;
pub const START_TS: i64 = 1_760_000_000;
pub const TOKEN_DECIMALS: u8 = 6;

pub const TOKEN_PROGRAM: Pubkey = spl_token::ID;
pub const TOKEN_2022_PROGRAM: Pubkey = spl_token_2022::ID;
pub const SYSTEM_PROGRAM: Pubkey = anchor_lang::system_program::ID;
pub const ATA_PROGRAM: Pubkey = anchor_spl::associated_token::ID;

pub fn default_params() -> Params {
    Params {
        defend_cooldown_secs: 60,
        max_defends_per_hour: 6,
        defend_price_tolerance_bps: 300,
        twap_window_secs: 600,
        twap_min_sample_interval_secs: 40,
        twap_max_gap_secs: 120,
        ath_confirm_secs: 0,
        max_burn_slippage_bps: 500,
        min_round_interval_secs: 60,
    }
}

fn so_path(name: &str) -> String {
    format!("{}/../../target/deploy/{name}.so", env!("CARGO_MANIFEST_DIR"))
}

pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

/// Anchor custom error code for a Holdfast error.
pub fn code(e: HoldfastError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

pub fn assert_err(res: &TxResult, expected: HoldfastError) {
    let want = code(expected);
    match res {
        Ok(_) => panic!("expected {expected:?} ({want}) but transaction succeeded"),
        Err(e) => {
            let logs = e.meta.logs.join("\n");
            assert!(
                logs.contains(&format!("Error Number: {want}")) || format!("{:?}", e.err).contains(&format!("Custom({want})")),
                "expected {expected:?} ({want}), got {:?}\n{logs}",
                e.err
            );
        }
    }
}

pub struct Coin {
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub treasury: Pubkey,
    pub treasury_ata: Pubkey,
    pub treasury_wsol: Pubkey,
    pub bonding_curve: Pubkey,
    pub curve_ata: Pubkey,
    pub trigger_bps: u16,
}

pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub keeper: Keypair,
    pub launcher: Keypair,
    pub payer: Keypair,
    /// Mock pump "global" account (byte 0 = misbehaviour mode).
    pub pump_global: Pubkey,
    pub amm_global_config: Pubkey,
    pub fee_recipient: Pubkey,
    now: i64,
}

impl Env {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let admin = Keypair::new();
        let keeper = Keypair::new();
        let launcher = Keypair::new();
        let payer = Keypair::new();
        for kp in [&admin, &keeper, &launcher, &payer] {
            svm.airdrop(&kp.pubkey(), 1_000 * SOL).unwrap();
        }

        deploy_upgradeable(&mut svm, holdfast_vault::ID, &std::fs::read(so_path("holdfast_vault")).expect("build holdfast_vault first"), admin.pubkey());
        svm.add_program(PUMP_PROGRAM_ID, &std::fs::read(so_path("mock_pump")).expect("build mock_pump first")).unwrap();
        svm.add_program(PUMP_AMM_PROGRAM_ID, &std::fs::read(so_path("mock_pump_amm")).expect("build mock_pump_amm first")).unwrap();

        let mut env = Env {
            svm,
            admin,
            keeper,
            launcher,
            payer,
            pump_global: Pubkey::new_unique(),
            amm_global_config: Pubkey::new_unique(),
            fee_recipient: Pubkey::new_unique(),
            now: START_TS,
        };
        env.set_time(START_TS);
        env.set_raw(env.pump_global, PUMP_PROGRAM_ID, vec![0u8; 8]);
        env.set_raw(env.amm_global_config, PUMP_AMM_PROGRAM_ID, vec![0u8; 8]);
        env.svm.airdrop(&env.fee_recipient, SOL).unwrap();
        // native mint
        env.set_mint_at(WSOL_MINT, TOKEN_PROGRAM, 9, None, 0);
        env
    }

    /// `Env::new()` + `initialize` with default params.
    pub fn ready() -> Self {
        let mut env = Self::new();
        env.initialize(default_params()).expect("initialize");
        env
    }

    // ---- low level ---------------------------------------------------------------------------
    pub fn now(&self) -> i64 {
        self.now
    }

    pub fn set_time(&mut self, ts: i64) {
        self.now = ts;
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = ts;
        clock.slot += 1;
        self.svm.set_sysvar(&clock);
        self.svm.expire_blockhash();
    }

    pub fn advance(&mut self, secs: i64) {
        self.set_time(self.now + secs);
    }

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        let payer = signers.first().map(|k| k.pubkey()).unwrap_or(self.payer.pubkey());
        let mut all: Vec<Instruction> = vec![compute_budget(1_400_000)];
        all.extend_from_slice(ixs);
        let msg = Message::new(&all, Some(&payer));
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res
    }

    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_balance(key).unwrap_or(0)
    }

    pub fn set_raw(&mut self, key: Pubkey, owner: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len()).max(1);
        self.svm.set_account(key, Account { lamports, data, owner, executable: false, rent_epoch: 0 }).unwrap();
    }

    pub fn account_data(&self, key: &Pubkey) -> Vec<u8> {
        self.svm.get_account(key).map(|a| a.data).unwrap_or_default()
    }

    pub fn vault(&self, mint: &Pubkey) -> CoinVault {
        let data = self.account_data(&vault_pda(mint));
        CoinVault::try_deserialize(&mut data.as_slice()).expect("vault")
    }

    pub fn config(&self) -> Config {
        let data = self.account_data(&config_pda());
        Config::try_deserialize(&mut data.as_slice()).expect("config")
    }

    pub fn round(&self, mint: &Pubkey, round_id: u64) -> Option<PayoutRound> {
        let acc = self.svm.get_account(&round_pda(mint, round_id))?;
        PayoutRound::try_deserialize(&mut acc.data.as_slice()).ok()
    }

    // ---- SPL state ---------------------------------------------------------------------------
    pub fn set_mint_at(&mut self, key: Pubkey, token_program: Pubkey, decimals: u8, authority: Option<Pubkey>, supply: u64) {
        let mut data = vec![0u8; spl_token_2022::state::Mint::LEN];
        spl_token_2022::state::Mint {
            mint_authority: authority.map(COption::Some).unwrap_or(COption::None),
            supply,
            decimals,
            is_initialized: true,
            freeze_authority: COption::None,
        }
        .pack_into_slice(&mut data);
        self.set_raw(key, token_program, data);
    }

    pub fn create_mint(&mut self, token_program: Pubkey, supply: u64) -> Pubkey {
        let key = Pubkey::new_unique();
        self.set_mint_at(key, token_program, TOKEN_DECIMALS, None, supply);
        key
    }

    pub fn set_token_account(&mut self, key: Pubkey, mint: Pubkey, owner: Pubkey, token_program: Pubkey, amount: u64) {
        let mut data = vec![0u8; spl_token_2022::state::Account::LEN];
        let native = mint == WSOL_MINT;
        let rent = self.svm.minimum_balance_for_rent_exemption(data.len());
        spl_token_2022::state::Account {
            mint,
            owner,
            amount,
            delegate: COption::None,
            state: spl_token_2022::state::AccountState::Initialized,
            is_native: if native { COption::Some(rent) } else { COption::None },
            delegated_amount: 0,
            close_authority: COption::None,
        }
        .pack_into_slice(&mut data);
        let lamports = if native { rent + amount } else { rent };
        self.svm.set_account(key, Account { lamports, data, owner: token_program, executable: false, rent_epoch: 0 }).unwrap();
    }

    /// Creates (or overwrites) `owner`'s ATA for `mint`.
    pub fn set_ata(&mut self, owner: &Pubkey, mint: &Pubkey, token_program: Pubkey, amount: u64) -> Pubkey {
        let key = ata(owner, mint, &token_program);
        self.set_token_account(key, *mint, *owner, token_program, amount);
        key
    }

    pub fn token_balance(&self, key: &Pubkey) -> u64 {
        let data = self.account_data(key);
        if data.len() < 72 {
            return 0;
        }
        u64::from_le_bytes(data[64..72].try_into().unwrap())
    }

    pub fn mint_supply(&self, mint: &Pubkey) -> u64 {
        let data = self.account_data(mint);
        u64::from_le_bytes(data[36..44].try_into().unwrap())
    }

    // ---- pump.fun state ------------------------------------------------------------------------
    /// Writes a pump `BondingCurve` (166 bytes, real layout) and funds its token account.
    pub fn set_curve(&mut self, mint: &Pubkey, creator: &Pubkey, vtok: u64, vsol: u64, rtok: u64, complete: bool) {
        let curve = bonding_curve_pda(mint);
        let mut d = vec![0u8; 166];
        d[..8].copy_from_slice(&PUMP_BONDING_CURVE_DISCRIMINATOR);
        d[8..16].copy_from_slice(&vtok.to_le_bytes());
        d[16..24].copy_from_slice(&vsol.to_le_bytes());
        d[24..32].copy_from_slice(&rtok.to_le_bytes());
        d[32..40].copy_from_slice(&0u64.to_le_bytes());
        d[40..48].copy_from_slice(&1_000_000_000_000_000u64.to_le_bytes());
        d[48] = complete as u8;
        d[49..81].copy_from_slice(creator.as_ref());
        self.set_raw(curve, PUMP_PROGRAM_ID, d);
        let curve_ata = ata(&curve, mint, &TOKEN_2022_PROGRAM);
        self.set_token_account(curve_ata, *mint, curve, TOKEN_2022_PROGRAM, rtok);
    }

    /// Moves the curve's virtual reserves (simulates other traders pumping or dumping).
    pub fn set_curve_reserves(&mut self, mint: &Pubkey, vtok: u64, vsol: u64) {
        let curve = bonding_curve_pda(mint);
        let mut acc = self.svm.get_account(&curve).unwrap();
        acc.data[8..16].copy_from_slice(&vtok.to_le_bytes());
        acc.data[16..24].copy_from_slice(&vsol.to_le_bytes());
        self.svm.set_account(curve, acc).unwrap();
    }

    pub fn set_curve_complete(&mut self, mint: &Pubkey) {
        let curve = bonding_curve_pda(mint);
        let mut acc = self.svm.get_account(&curve).unwrap();
        acc.data[48] = 1;
        self.svm.set_account(curve, acc).unwrap();
    }

    pub fn curve_reserves(&self, mint: &Pubkey) -> (u64, u64) {
        let d = self.account_data(&bonding_curve_pda(mint));
        (u64::from_le_bytes(d[8..16].try_into().unwrap()), u64::from_le_bytes(d[16..24].try_into().unwrap()))
    }

    /// Creates the canonical PumpSwap pool for `mint` with the given reserves.
    pub fn set_pool(&mut self, mint: &Pubkey, coin_creator: &Pubkey, base: u64, quote: u64, virtual_quote: i128) -> Pool {
        let authority = pool_authority_pda(mint);
        let pool = canonical_pool_pda(mint);
        let pool_base = ata(&pool, mint, &TOKEN_2022_PROGRAM);
        let pool_quote = ata(&pool, &WSOL_MINT, &TOKEN_PROGRAM);
        let mut d = vec![0u8; 300];
        d[..8].copy_from_slice(&PUMP_AMM_POOL_DISCRIMINATOR);
        d[9..11].copy_from_slice(&0u16.to_le_bytes());
        d[11..43].copy_from_slice(authority.as_ref());
        d[43..75].copy_from_slice(mint.as_ref());
        d[75..107].copy_from_slice(WSOL_MINT.as_ref());
        d[139..171].copy_from_slice(pool_base.as_ref());
        d[171..203].copy_from_slice(pool_quote.as_ref());
        d[211..243].copy_from_slice(coin_creator.as_ref());
        d[245..261].copy_from_slice(&virtual_quote.to_le_bytes());
        self.set_raw(pool, PUMP_AMM_PROGRAM_ID, d);
        self.set_token_account(pool_base, *mint, pool, TOKEN_2022_PROGRAM, base);
        self.set_token_account(pool_quote, WSOL_MINT, pool, TOKEN_PROGRAM, quote);
        let protocol_fee_recipient = Pubkey::new_unique();
        let protocol_fee_ta = self.set_ata(&protocol_fee_recipient, &WSOL_MINT, TOKEN_PROGRAM, 0);
        let creator_vault_authority = Pubkey::find_program_address(&[b"creator_vault", coin_creator.as_ref()], &PUMP_AMM_PROGRAM_ID).0;
        let creator_vault_ata = self.set_ata(&creator_vault_authority, &WSOL_MINT, TOKEN_PROGRAM, 0);
        Pool { address: pool, base: pool_base, quote: pool_quote, protocol_fee_recipient, protocol_fee_ta, creator_vault_authority, creator_vault_ata }
    }

    pub fn set_pool_quote(&mut self, pool: &Pool, quote: u64) {
        self.set_token_account(pool.quote, WSOL_MINT, pool.address, TOKEN_PROGRAM, quote);
    }

    // ---- holdfast instructions -------------------------------------------------------------------
    pub fn initialize(&mut self, params: Params) -> TxResult {
        let admin = self.admin.insecure_clone();
        let ix = self.initialize_ix(&admin.pubkey(), params);
        self.send(&[ix], &[&admin])
    }

    pub fn initialize_ix(&self, authority: &Pubkey, params: Params) -> Instruction {
        let program_data = Pubkey::find_program_address(&[holdfast_vault::ID.as_ref()], &bpf_loader_upgradeable::ID).0;
        ix(
            holdfast_vault::accounts::Initialize {
                authority: *authority,
                config: config_pda(),
                program: holdfast_vault::ID,
                program_data,
                system_program: SYSTEM_PROGRAM,
            },
            holdfast_vault::instruction::Initialize { keeper: self.keeper.pubkey(), launcher: self.launcher.pubkey(), params },
        )
    }

    pub fn admin_ix(&self, admin: &Pubkey, data: impl InstructionData) -> Instruction {
        ix(holdfast_vault::accounts::AdminOnly { admin: *admin, config: config_pda() }, data)
    }

    pub fn set_hold_mint_ix(&self, admin: &Pubkey, hold_mint: &Pubkey) -> Instruction {
        ix(
            holdfast_vault::accounts::SetHoldMint { admin: *admin, config: config_pda(), hold_mint: *hold_mint },
            holdfast_vault::instruction::SetHoldMint {},
        )
    }

    /// Simulates pump.fun `create_v2(creator = treasury)`, registers the coin, and gives the treasury
    /// the accounts `prepare_treasury` would create (written directly, so the buckets stay untouched).
    pub fn launch(&mut self, trigger_bps: u16) -> Coin {
        let coin = self.launch_bare(trigger_bps);
        self.provision_treasury(&coin);
        coin
    }

    /// Launch exactly as the launcher does it: `init_coin` only, no treasury token accounts yet.
    pub fn launch_bare(&mut self, trigger_bps: u16) -> Coin {
        let coin = self.prepare_coin(trigger_bps);
        let launcher = self.launcher.insecure_clone();
        let ix = self.init_coin_ix(&coin, &launcher.pubkey());
        self.send(&[ix], &[&launcher]).expect("init_coin");
        coin
    }

    /// Writes the treasury's token account, WSOL account and pump volume accumulator.
    pub fn provision_treasury(&mut self, coin: &Coin) {
        self.set_ata(&coin.treasury, &coin.mint, TOKEN_2022_PROGRAM, 0);
        self.set_ata(&coin.treasury, &WSOL_MINT, TOKEN_PROGRAM, 0);
        self.set_raw(user_volume_accumulator_pda(&coin.treasury, &PUMP_PROGRAM_ID), PUMP_PROGRAM_ID, vec![0u8; 137]);
    }

    pub fn exists(&self, key: &Pubkey) -> bool {
        self.svm.get_account(key).is_some_and(|a| a.lamports > 0)
    }

    /// `volume_program`: also create the treasury's volume accumulator of pump (curve) or pump_amm.
    pub fn prepare_treasury_ix(&self, coin: &Coin, volume_program: Option<Pubkey>) -> Instruction {
        ix(
            holdfast_vault::accounts::PrepareTreasury {
                vault: coin.vault,
                treasury: coin.treasury,
                mint: coin.mint,
                treasury_token_account: coin.treasury_ata,
                treasury_wsol_account: coin.treasury_wsol,
                wsol_mint: WSOL_MINT,
                token_program: TOKEN_2022_PROGRAM,
                wsol_token_program: TOKEN_PROGRAM,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM_PROGRAM,
                volume_program,
                user_volume_accumulator: volume_program.map(|p| user_volume_accumulator_pda(&coin.treasury, &p)),
                volume_event_authority: volume_program.map(|p| Pubkey::find_program_address(&[b"__event_authority"], &p).0),
            },
            holdfast_vault::instruction::PrepareTreasury {},
        )
    }

    pub fn prepare_treasury(&mut self, coin: &Coin, volume_program: Option<Pubkey>) -> TxResult {
        let payer = self.payer.insecure_clone();
        let ix = self.prepare_treasury_ix(coin, volume_program);
        self.send(&[ix], &[&payer])
    }

    /// Mint + bonding curve (creator = treasury) at the standard pump.fun starting reserves.
    pub fn prepare_coin(&mut self, trigger_bps: u16) -> Coin {
        let mint = self.create_mint(TOKEN_2022_PROGRAM, 1_000_000_000_000_000);
        let treasury = treasury_pda(&mint);
        self.set_curve(&mint, &treasury, 1_073_000_000_000_000, 30 * SOL, 793_100_000_000_000, false);
        // Pre-create the treasury's pump creator vault so fee transfers into it are rent-safe.
        self.svm.airdrop(&creator_vault_pda(&treasury), SOL).unwrap();
        Coin {
            mint,
            vault: vault_pda(&mint),
            treasury,
            treasury_ata: ata(&treasury, &mint, &TOKEN_2022_PROGRAM),
            treasury_wsol: ata(&treasury, &WSOL_MINT, &TOKEN_PROGRAM),
            bonding_curve: bonding_curve_pda(&mint),
            curve_ata: ata(&bonding_curve_pda(&mint), &mint, &TOKEN_2022_PROGRAM),
            trigger_bps,
        }
    }

    pub fn init_coin_ix(&self, coin: &Coin, launcher: &Pubkey) -> Instruction {
        ix(
            holdfast_vault::accounts::InitCoin {
                launcher: *launcher,
                config: config_pda(),
                mint: coin.mint,
                vault: coin.vault,
                treasury: coin.treasury,
                bonding_curve: coin.bonding_curve,
                token_program: TOKEN_2022_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            },
            holdfast_vault::instruction::InitCoin { trigger_bps: coin.trigger_bps },
        )
    }

    pub fn collect_fees_ix(&self, coin: &Coin) -> Instruction {
        ix(
            holdfast_vault::accounts::CollectFees {
                vault: coin.vault,
                treasury: coin.treasury,
                treasury_wsol_account: self.exists(&coin.treasury_wsol).then_some(coin.treasury_wsol),
                mint: coin.mint,
                treasury_token_account: self.exists(&coin.treasury_ata).then_some(coin.treasury_ata),
                token_program: TOKEN_2022_PROGRAM,
                wsol_mint: WSOL_MINT,
                wsol_token_program: TOKEN_PROGRAM,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            },
            holdfast_vault::instruction::CollectFees {},
        )
    }

    /// Sends creator fees to the treasury (what pump.fun's `collect_creator_fee_v2` does) and books them.
    pub fn collect(&mut self, coin: &Coin, fee_lamports: u64) -> TxResult {
        if fee_lamports > 0 {
            self.svm.airdrop(&coin.treasury, fee_lamports).unwrap();
        }
        let payer = self.payer.insecure_clone();
        let ix = self.collect_fees_ix(coin);
        self.send(&[ix], &[&payer])
    }

    fn price_accounts(&self, coin: &Coin, pool: Option<&Pool>) -> (Pubkey, Option<Pubkey>, Option<Pubkey>) {
        match pool {
            None => (coin.bonding_curve, None, None),
            Some(p) => (p.address, Some(p.base), Some(p.quote)),
        }
    }

    pub fn update_ath_ix(&self, coin: &Coin, keeper: &Pubkey, pool: Option<&Pool>) -> Instruction {
        let (price_account, pool_base_account, pool_quote_account) = self.price_accounts(coin, pool);
        ix(
            holdfast_vault::accounts::UpdateAth { keeper: *keeper, config: config_pda(), vault: coin.vault, price_account, pool_base_account, pool_quote_account },
            holdfast_vault::instruction::UpdateAth {},
        )
    }

    pub fn update_ath(&mut self, coin: &Coin, pool: Option<&Pool>) -> TxResult {
        let keeper = self.keeper.insecure_clone();
        let ix = self.update_ath_ix(coin, &keeper.pubkey(), pool);
        self.send(&[ix], &[&keeper])
    }

    /// Samples the price every `twap_min_sample_interval_secs` for `secs` (keeper cadence), letting the TWAP settle.
    pub fn sample_for(&mut self, coin: &Coin, pool: Option<&Pool>, secs: i64) {
        let step = self.config().params.twap_min_sample_interval_secs as i64;
        let mut elapsed = 0;
        while elapsed <= secs {
            self.update_ath(coin, pool).expect("update_ath");
            self.advance(step);
            elapsed += step;
        }
    }

    pub fn graduate_ix(&self, coin: &Coin, pool: &Pool) -> Instruction {
        ix(
            holdfast_vault::accounts::Graduate { vault: coin.vault, bonding_curve: coin.bonding_curve, pool: pool.address },
            holdfast_vault::instruction::Graduate {},
        )
    }

    /// pump `buy_exact_sol_in` account list (IDL order + the two trailing accounts the SDK appends).
    pub fn curve_buy_accounts(&self, mint: &Pubkey, user: &Pubkey, user_ata: &Pubkey) -> Vec<AccountMeta> {
        let curve = bonding_curve_pda(mint);
        let d = self.account_data(&curve);
        let creator = d.get(49..81).map(|b| Pubkey::new_from_array(b.try_into().unwrap())).unwrap_or_default();
        vec![
            AccountMeta::new_readonly(self.pump_global, false),
            AccountMeta::new(self.fee_recipient, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(curve, false),
            AccountMeta::new(ata(&curve, mint, &TOKEN_2022_PROGRAM), false),
            AccountMeta::new(*user_ata, false),
            AccountMeta::new(*user, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM, false),
            AccountMeta::new(creator_vault_pda(&creator), false),
            AccountMeta::new_readonly(Pubkey::find_program_address(&[b"__event_authority"], &PUMP_PROGRAM_ID).0, false),
            AccountMeta::new_readonly(PUMP_PROGRAM_ID, false),
            AccountMeta::new_readonly(Pubkey::find_program_address(&[b"global_volume_accumulator"], &PUMP_PROGRAM_ID).0, false),
            AccountMeta::new(Pubkey::find_program_address(&[b"user_volume_accumulator", user.as_ref()], &PUMP_PROGRAM_ID).0, false),
            AccountMeta::new_readonly(Pubkey::new_unique(), false), // fee_config
            AccountMeta::new_readonly(Pubkey::new_unique(), false), // fee_program
            AccountMeta::new_readonly(Pubkey::find_program_address(&[b"bonding-curve-v2", mint.as_ref()], &PUMP_PROGRAM_ID).0, false),
            AccountMeta::new(self.fee_recipient, false), // buyback fee recipient
        ]
    }

    /// PumpSwap `buy_exact_quote_in` account list (IDL order).
    pub fn amm_buy_accounts(&self, mint: &Pubkey, pool: &Pool, user: &Pubkey, user_base: &Pubkey, user_quote: &Pubkey) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(pool.address, false),
            AccountMeta::new(*user, false),
            AccountMeta::new_readonly(self.amm_global_config, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(WSOL_MINT, false),
            AccountMeta::new(*user_base, false),
            AccountMeta::new(*user_quote, false),
            AccountMeta::new(pool.base, false),
            AccountMeta::new(pool.quote, false),
            AccountMeta::new_readonly(pool.protocol_fee_recipient, false),
            AccountMeta::new(pool.protocol_fee_ta, false),
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            AccountMeta::new_readonly(ATA_PROGRAM, false),
            AccountMeta::new_readonly(Pubkey::find_program_address(&[b"__event_authority"], &PUMP_AMM_PROGRAM_ID).0, false),
            AccountMeta::new_readonly(PUMP_AMM_PROGRAM_ID, false),
            AccountMeta::new(pool.creator_vault_ata, false),
            AccountMeta::new_readonly(pool.creator_vault_authority, false),
            AccountMeta::new_readonly(Pubkey::find_program_address(&[b"global_volume_accumulator"], &PUMP_AMM_PROGRAM_ID).0, false),
            AccountMeta::new(Pubkey::find_program_address(&[b"user_volume_accumulator", user.as_ref()], &PUMP_AMM_PROGRAM_ID).0, false),
            AccountMeta::new_readonly(Pubkey::new_unique(), false),
            AccountMeta::new_readonly(Pubkey::new_unique(), false),
        ]
    }

    pub fn defend_ix(&self, coin: &Coin, caller: &Pubkey, min_tokens_out: u64, pool: Option<&Pool>) -> Instruction {
        let (price_account, pool_base_account, pool_quote_account) = self.price_accounts(coin, pool);
        let mut ixn = ix(
            holdfast_vault::accounts::Defend {
                caller: *caller,
                config: config_pda(),
                vault: coin.vault,
                treasury: coin.treasury,
                mint: coin.mint,
                treasury_token_account: coin.treasury_ata,
                treasury_wsol_account: coin.treasury_wsol,
                price_account,
                pool_base_account,
                pool_quote_account,
                wsol_mint: WSOL_MINT,
                token_program: TOKEN_2022_PROGRAM,
                wsol_token_program: TOKEN_PROGRAM,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            },
            holdfast_vault::instruction::Defend { min_tokens_out },
        );
        ixn.accounts.extend(match pool {
            None => self.curve_buy_accounts(&coin.mint, &coin.treasury, &coin.treasury_ata),
            Some(p) => self.amm_buy_accounts(&coin.mint, p, &coin.treasury, &coin.treasury_ata, &coin.treasury_wsol),
        });
        ixn
    }

    pub fn defend(&mut self, coin: &Coin, pool: Option<&Pool>) -> TxResult {
        let caller = Keypair::new();
        self.svm.airdrop(&caller.pubkey(), SOL).unwrap();
        let ix = self.defend_ix(coin, &caller.pubkey(), 0, pool);
        self.send(&[ix], &[&caller])
    }

    pub fn open_round_ix(&self, coin: &Coin, keeper: &Pubkey, round_id: u64, sol_pot: u64, token_pot: u64, recipients: u32) -> Instruction {
        ix(
            holdfast_vault::accounts::OpenRound {
                keeper: *keeper,
                config: config_pda(),
                vault: coin.vault,
                round: round_pda(&coin.mint, round_id),
                system_program: SYSTEM_PROGRAM,
            },
            holdfast_vault::instruction::OpenRound { round_id, sol_pot, token_pot, snapshot_hash: [7u8; 32], recipient_count: recipients },
        )
    }

    pub fn open_round(&mut self, coin: &Coin, round_id: u64, sol_pot: u64, token_pot: u64, recipients: u32) -> TxResult {
        let keeper = self.keeper.insecure_clone();
        let ix = self.open_round_ix(coin, &keeper.pubkey(), round_id, sol_pot, token_pot, recipients);
        self.send(&[ix], &[&keeper])
    }

    /// `recipients[i]` = (wallet, token account if tokens > 0) for `entries[i]`.
    pub fn payout_ix(&self, coin: &Coin, keeper: &Pubkey, round_id: u64, entries: Vec<PayoutEntry>, recipients: &[(Pubkey, Option<Pubkey>)]) -> Instruction {
        let mut ixn = ix(
            holdfast_vault::accounts::Payout {
                keeper: *keeper,
                config: config_pda(),
                vault: coin.vault,
                round: round_pda(&coin.mint, round_id),
                treasury: coin.treasury,
                mint: coin.mint,
                treasury_token_account: self.exists(&coin.treasury_ata).then_some(coin.treasury_ata),
                token_program: TOKEN_2022_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            },
            holdfast_vault::instruction::Payout { round_id, entries },
        );
        for (wallet, token_account) in recipients {
            ixn.accounts.push(AccountMeta::new(*wallet, false));
            if let Some(ta) = token_account {
                ixn.accounts.push(AccountMeta::new(*ta, false));
            }
        }
        ixn
    }

    pub fn payout(&mut self, coin: &Coin, round_id: u64, entries: Vec<PayoutEntry>, recipients: &[(Pubkey, Option<Pubkey>)]) -> TxResult {
        let keeper = self.keeper.insecure_clone();
        let ix = self.payout_ix(coin, &keeper.pubkey(), round_id, entries, recipients);
        self.send(&[ix], &[&keeper])
    }

    pub fn close_round_ix(&self, coin: &Coin, keeper: &Pubkey, round_id: u64, rent_receiver: &Pubkey) -> Instruction {
        ix(
            holdfast_vault::accounts::CloseRound {
                keeper: *keeper,
                config: config_pda(),
                vault: coin.vault,
                round: round_pda(&coin.mint, round_id),
                rent_receiver: *rent_receiver,
            },
            holdfast_vault::instruction::CloseRound { round_id },
        )
    }

    pub fn close_round(&mut self, coin: &Coin, round_id: u64) -> TxResult {
        let keeper = self.keeper.insecure_clone();
        let ix = self.close_round_ix(coin, &keeper.pubkey(), round_id, &keeper.pubkey());
        self.send(&[ix], &[&keeper])
    }

    pub fn burn_hold_ix(&self, coin: &Coin, keeper: &Pubkey, hold_mint: &Pubkey, min_hold_out: u64) -> Instruction {
        let hold_curve = bonding_curve_pda(hold_mint);
        let treasury_hold = ata(&coin.treasury, hold_mint, &TOKEN_2022_PROGRAM);
        let mut ixn = ix(
            holdfast_vault::accounts::BurnHold {
                keeper: *keeper,
                config: config_pda(),
                vault: coin.vault,
                treasury: coin.treasury,
                hold_mint: *hold_mint,
                treasury_hold_account: treasury_hold,
                treasury_wsol_account: coin.treasury_wsol,
                hold_price_account: hold_curve,
                pool_base_account: None,
                pool_quote_account: None,
                wsol_mint: WSOL_MINT,
                hold_token_program: TOKEN_2022_PROGRAM,
                wsol_token_program: TOKEN_PROGRAM,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            },
            holdfast_vault::instruction::BurnHold { venue: VENUE_CURVE, min_hold_out },
        );
        ixn.accounts.extend(self.curve_buy_accounts(hold_mint, &coin.treasury, &treasury_hold));
        ixn
    }

    /// Establishes ATH at the current price via TWAP sampling.
    pub fn establish_ath(&mut self, coin: &Coin) {
        let params = self.config().params;
        self.sample_for(coin, None, (params.twap_window_secs + params.twap_min_sample_interval_secs) as i64);
        assert!(self.vault(&coin.mint).ath_price > 0, "ATH should be set");
    }

    /// Dumps the curve price to `fraction_bps` of the current price (other traders selling).
    pub fn dump_price(&mut self, coin: &Coin, fraction_bps: u64) {
        let (vtok, vsol) = self.curve_reserves(&coin.mint);
        self.set_curve_reserves(&coin.mint, vtok, (vsol as u128 * fraction_bps as u128 / 10_000) as u64);
    }

    pub fn spot_price(&self, coin: &Coin) -> u128 {
        let (vtok, vsol) = self.curve_reserves(&coin.mint);
        vsol as u128 * PRICE_SCALE / vtok as u128
    }
}

impl Default for Env {
    fn default() -> Self {
        Self::new()
    }
}

pub struct Pool {
    pub address: Pubkey,
    pub base: Pubkey,
    pub quote: Pubkey,
    pub protocol_fee_recipient: Pubkey,
    pub protocol_fee_ta: Pubkey,
    pub creator_vault_authority: Pubkey,
    pub creator_vault_ata: Pubkey,
}

pub fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction { program_id: holdfast_vault::ID, accounts: accounts.to_account_metas(None), data: data.data() }
}

pub fn compute_budget(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction { program_id: anchor_lang::prelude::pubkey!("ComputeBudget111111111111111111111111111111"), accounts: vec![], data }
}

pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &holdfast_vault::ID).0
}
pub fn vault_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[VAULT_SEED, mint.as_ref()], &holdfast_vault::ID).0
}
pub fn treasury_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[TREASURY_SEED, mint.as_ref()], &holdfast_vault::ID).0
}
pub fn round_pda(mint: &Pubkey, round_id: u64) -> Pubkey {
    Pubkey::find_program_address(&[ROUND_SEED, mint.as_ref(), &round_id.to_le_bytes()], &holdfast_vault::ID).0
}
pub fn bonding_curve_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"bonding-curve", mint.as_ref()], &PUMP_PROGRAM_ID).0
}
pub fn user_volume_accumulator_pda(user: &Pubkey, program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"user_volume_accumulator", user.as_ref()], program).0
}
pub fn creator_vault_pda(creator: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"creator-vault", creator.as_ref()], &PUMP_PROGRAM_ID).0
}
pub fn pool_authority_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"pool-authority", mint.as_ref()], &PUMP_PROGRAM_ID).0
}
pub fn canonical_pool_pda(mint: &Pubkey) -> Pubkey {
    let authority = pool_authority_pda(mint);
    Pubkey::find_program_address(&[b"pool", &0u16.to_le_bytes(), authority.as_ref(), mint.as_ref(), WSOL_MINT.as_ref()], &PUMP_AMM_PROGRAM_ID).0
}

/// Deploys `elf` behind the upgradeable loader with `authority` as upgrade authority.
fn deploy_upgradeable(svm: &mut LiteSVM, program_id: Pubkey, elf: &[u8], authority: Pubkey) {
    let programdata_address = Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::ID).0;
    let mut programdata = bincode::serialize(&UpgradeableLoaderState::ProgramData { slot: 0, upgrade_authority_address: Some(authority) }).unwrap();
    programdata.resize(UpgradeableLoaderState::size_of_programdata_metadata(), 0);
    programdata.extend_from_slice(elf);
    let lamports = svm.minimum_balance_for_rent_exemption(programdata.len());
    svm.set_account(programdata_address, Account { lamports, data: programdata, owner: bpf_loader_upgradeable::ID, executable: false, rent_epoch: 0 })
        .unwrap();
    let program = bincode::serialize(&UpgradeableLoaderState::Program { programdata_address }).unwrap();
    let lamports = svm.minimum_balance_for_rent_exemption(program.len());
    svm.set_account(program_id, Account { lamports, data: program, owner: bpf_loader_upgradeable::ID, executable: true, rent_epoch: 0 }).unwrap();
}
