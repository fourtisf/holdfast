# Security model (SPEC §7)

## On-chain invariants and where they are enforced

| Invariant | Enforced in | Test |
|---|---|---|
| No withdraw: SOL leaves only via `defend` / `payout` / `burn_hold` / `claim_creator_fees` / `sweep_platform_fees` | instruction set (no other transfer out of the treasury); IDL instruction list pinned | `no_withdraw.rs::the_instruction_set_has_no_withdraw`, `admin_and_keeper_powers_cannot_move_funds`, `lamports_are_conserved_across_a_random_lifecycle` |
| The creator claim moves only `creator_sol`, only to the recorded creator, signed by it | `claim_creator_fees` (`has_one = creator`, post-check), `init_coin` (creator is a wallet, written once) | `creator.rs`, `no_withdraw.rs::the_creator_claim_cannot_reach_the_other_buckets` |
| The platform sweep moves only `platform_sol`, only to the configured platform treasury | `sweep_platform_fees` (`has_one = platform_treasury`, post-check); `set_platform_treasury` (admin, never the default key) | `platform.rs`, `no_withdraw.rs::the_platform_sweep_cannot_reach_the_other_buckets` |
| Buckets ≤ treasury lamports − rent; fees split exactly 40/25/15/10/10 | `collect_fees`, post-checks in `defend` / `payout` / `burn_hold` | `coin_and_fees.rs`, conservation test |
| Payout ≤ committed pot ≤ holder bucket; each index paid once | `open_round`, `payout` (bitmap) | `payouts.rs` |
| Payouts only to regular wallets (system-owned, no data, on-curve) | `treasury::is_regular_wallet` (ed25519 point check via `sol_curve_validate_point`) | `only_regular_wallets_receive_payouts` |
| `trigger_bps ∈ {15, 25, 35}%`, immutable; `hold_mint` set once | `init_coin`, `set_hold_mint`; no setter exists | `every_trigger_option_and_nothing_else`, `hold_mint_can_be_set_only_once` |
| ATH only rises; floor = ATH × (1 − trigger) | `math::next_ath`, `update_ath` | `ath_never_decreases`, `ath_comes_from_a_twap_and_floor_follows` |
| Buyback pays ≤ floor × (1 + tolerance) per token, only at spot ≤ floor, ≤ 10% of the floor bucket, with cooldown and hourly cap | `defend` + `swap::execute_buy` balance deltas | `ath_defend.rs` incl. misbehaving-venue and tampered-account tests |
| Config can only be initialised by the upgrade authority | `Initialize` constraints on `ProgramData` | `only_the_upgrade_authority_can_initialize` |

## SPEC §7 risks

1. **ATH manipulation to drain the vault.**
   - The ATH comes from an on-chain **TWAP** over `twap_window_secs`, default 600 s.
   - Observations are read straight from reserves by the program, at least `twap_min_sample_interval_secs` apart (30 s).
   - A TWAP is valid only if the window is fully covered with gaps ≤ `twap_max_gap_secs`.
   - Optional `ath_confirm_secs`: a higher TWAP must hold this long, and the *lowest* TWAP seen during that time becomes the ATH.
   - A one-sample 5× pump moves the ATH by ≤ 20%. Test: `a_short_pump_barely_moves_the_ath`.
   - Defends are rate-limited (cooldown ≥ 30 s, ≤ 60 per hour, configurable lower) and spend 10% of the floor bucket per step,
     so a successful manipulation can drain at most `max_defends_per_hour × 10%` (compounding) per hour, at prices ≤ the manipulated floor.
   - **Residual risk:** an attacker who sandwiches the keeper's `update_ath` transactions every 30 s for 10 minutes can lift the TWAP.
     It costs round-trip fees on every sample. Mitigations: send `update_ath` through private / Jito submission at randomised times,
     and enable `ath_confirm_secs` on mainnet.
2. **Sandwiching buybacks.**
   - The program sets `min_out` to at least `budget / (floor × (1 + tolerance))`, so the vault never overpays even if the caller
     passes `min_tokens_out = 0`.
   - The keeper also passes a quote-based `min_tokens_out` with 3% slippage and adds a random 0–4 s delay.
   - Use Jito bundles in production (`JITO_BLOCK_ENGINE_URL` hook).
   - `defend` is permissionless, so anyone can defend if the keeper is down.
3. **Trust in off-chain payout selection.**
   - The keeper chooses recipients and amounts. The program caps the damage: the pot comes from the holder bucket only, never the
     floor or burn bucket; recipients must be regular wallets; each index pays once.
   - Every round's inputs and outputs are public, and the merkle root is committed on-chain before any payment (`docs/payouts.md`).
   - Next step: claim-based payouts that verify merkle proofs on-chain.
4. **Sybil / wash trading.**
   - Weight only rises with time, and transfers never create lots, so moving tokens between wallets cannot launder age.
   - Splitting across wallets does not change total weight.
   - Wash trades pay real fees (30% of which go back to holders).
   - The indexer still records everything for monitoring.
5. **Audit before mainnet.** Required. The scope is `programs/holdfast-vault` plus the keeper's transaction building.
   Points to focus on are listed below.
6. **Regulatory.** Holder revenue sharing may be regulated in some jurisdictions. Get legal advice before launch (product decision, not code).

## Trust assumptions

- **Upgrade authority** can replace the program, and with it every guarantee above. Before mainnet, move it to a multisig with a
  timelock, or freeze it (`solana program set-upgrade-authority --final`) once audited.
- **Admin** can rotate keeper/launcher, tune parameters inside hard bounds, set `hold_mint` once, and pause outflows.
  The admin cannot move funds, change a trigger, or re-point `hold_mint`. A compromised admin *could* pause forever. The funds
  would stay in the vaults, unspendable but never extractable. Use a multisig, or drop `set_paused` if the owner prefers no
  emergency stop (see `docs/decisions.md`).
- **Keeper key** can sample prices (only on schedule; values are read on-chain), open rounds with any recipient set within the
  holder bucket, and burn the burn bucket into $MOAT with a min-out. Keep it on a dedicated, monitored host. It pays the
  transaction fees and round rent, which it gets back.
- **pump.fun** admins can re-point a coin's creator (CTO, `set_creator`, fee-sharing config). See `docs/pump-integration.md` §5.

## Audit focus list

- `venue.rs` / `swap.rs`: pass-through CPI with treasury signer. Account pinning, the writable/signer flags derived from the
  caller's list, and the balance-delta accounting, including the WSOL close/re-create path.
- `rounds.rs`: remaining-accounts cursor, bitmap, rent check, pot accounting across batches.
- `collect_fees`: unaccounted-lamport accounting when the WSOL account is re-created inside the same instruction.
- TWAP math (`math::twap`): coverage, gap and ordering checks; behaviour at ring-buffer wrap-around.
- Overflow: every `u128` mul path is checked and returns `MathOverflow`.
- `init_coin`: the bonding-curve creator check and `init_if_needed` ATAs.
