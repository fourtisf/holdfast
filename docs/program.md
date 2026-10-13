# Holdfast Vault program (`programs/holdfast-vault`)

Anchor 0.32 program. Program id (devnet placeholder, regenerate per deployment with `anchor keys sync`):
`8WhCTXTNjZi1fJn5uK6E4cRiGJtKt3RUsnJjCWf5ytdM`.

## Accounts and PDAs

| Account | Seeds | Owner | Purpose |
|---|---|---|---|
| `Config` | `["config"]` | program | admin, keeper, launcher, `hold_mint` (set once), bounded global params, `paused` |
| `CoinVault` | `["vault", mint]` | program | per-coin state: trigger, ATH/floor, buckets, TWAP observations, defend limiter, round pointer, lifetime stats |
| Treasury | `["treasury", mint]` | **System program** (0 data) | holds all of the coin's SOL; is the pump.fun `creator` of the coin, owner of its token accounts, and the `user` that signs vault buybacks |
| Treasury token account | ATA(treasury, mint, token program of mint) | token program | tokens bought back, waiting for holders (`holder_tokens`) |
| Treasury WSOL account | ATA(treasury, WSOL, SPL Token) | SPL Token | receives PumpSwap creator fees; unwrapped by `collect_fees` |
| `PayoutRound` | `["round", mint, round_id u64 le]` | program | one per open round: pot, paid so far, merkle root, paid bitmap. Rent paid by keeper, refunded on close |

Why the treasury is a separate, system-owned PDA (deviation from spec §4, which puts SOL "in" the CoinVault):
pump.fun's buy instructions pull SOL with a System Program transfer from `user`, which only works from an account
the System Program owns. A data account owned by our program cannot be that `user`, so the SOL lives in the
treasury PDA and `CoinVault` keeps the bucket accounting.

## Invariants (enforced in code, covered by tests)

1. **No withdraw.** SOL leaves the treasury only through `defend` (into the pump.fun / PumpSwap buy CPI),
   `payout` (System transfer to an on-curve, system-owned, data-less wallet) and `burn_hold` (buy CPI for $HOLD,
   then burn). Admin/keeper instructions never move funds.
2. `floor_sol + holder_sol + burn_sol ≤ treasury.lamports − rent_exempt_minimum` at all times; anything above is
   unaccounted income and is split 60/30/10 by `collect_fees`.
3. Payouts of a round never exceed the pot committed in `open_round`, and the pot can never exceed `holder_sol` /
   `holder_tokens` at open. Each recipient index can be paid once (bitmap).
4. `trigger_bps ∈ {1500, 2500, 3500}`, written once in `init_coin`, never updatable. `hold_mint` can be set once
   (from the default key) and never changed.
5. `ath` only increases; `floor = ath × (1 − trigger)` therefore never decreases.
6. A buyback never pays more than `floor × (1 + defend_price_tolerance_bps)` per token (checked on actual SOL
   spent and tokens received), only runs when the spot price ≤ floor, spends at most 10% of `floor_sol` per step,
   and respects `defend_cooldown_secs` and `max_defends_per_hour`.

## Instructions

| Instruction | Signer | Notes |
|---|---|---|
| `initialize(params)` | program upgrade authority | creates `Config` (admin = signer) |
| `set_keeper(keeper)` / `set_launcher(launcher)` | admin | rotate operational keys |
| `set_params(params)` | admin | every field range-checked (cooldown ≥ 30 s, ≤ 60 defends/h, …) |
| `set_hold_mint(hold_mint)` | admin | only while unset |
| `set_paused(bool)` | admin | pauses outflows (`defend`, `payout`, `burn_hold`, `open_round`); cannot move funds |
| `transfer_admin(new)` / `accept_admin()` | admin / new admin | two-step |
| `init_coin(trigger_bps)` | launcher | same tx as pump.fun `create_v2(creator = treasury)`. Checks the bonding curve's `creator == treasury`, SOL quote, not complete. Creates `CoinVault`, funds the treasury's rent, creates treasury token + WSOL accounts |
| `collect_fees()` | anyone | unwraps the treasury WSOL account (close + recreate), then splits all unaccounted treasury lamports 60/30/10. The keeper prepends pump.fun's permissionless `sweep_creator_fee` + `collect_creator_fee_v2` (curve) and PumpSwap `sweep_creator_fee` + `collect_coin_creator_fee` (after graduation) in the same tx |
| `update_ath()` | keeper | reads spot price from the bonding curve (virtual reserves) or the PumpSwap pool (`quote balance + virtual_quote_reserves`) / base balance, appends a TWAP observation (min spacing), recomputes the TWAP over `twap_window_secs` and raises ATH once a higher TWAP has held for `ath_confirm_secs` |
| `graduate()` | anyone | after the curve is `complete`: verifies the canonical PumpSwap pool PDA and switches the price/buy venue |
| `defend(min_tokens_out)` | anyone | see invariant 6. Buy CPI: pump `buy_exact_sol_in` or PumpSwap `buy_exact_quote_in`, account list passed through `remaining_accounts` (validated positions), instruction data built on-chain |
| `open_round(round_id, sol_pot, token_pot, snapshot_hash, recipient_count)` | keeper | `round_id = last + 1`, ≥ `min_round_interval_secs` since the last round, one open round at a time |
| `payout(round_id, entries[{index, sol, tokens}])` | keeper | remaining accounts per entry: `wallet` then (if `tokens > 0`) its token account |
| `close_round(round_id)` | keeper | closes the round PDA (rent back to the keeper); unpaid amounts stay in the buckets |
| `burn_hold(venue, min_hold_out)` | keeper | swaps all of `burn_sol` for $HOLD and burns exactly what was received, same instruction |

## Events (Anchor `emit!`, base64 in `Program data:` logs)

```rust
CoinInitialized { mint, vault, treasury, trigger_bps: u16, bonding_curve, ts: i64 }
FeesCollected   { mint, amount: u64, floor: u64, holder: u64, burn: u64, unwrapped_wsol: u64, ts: i64 }
AthUpdated      { mint, twap: u128, ath: u128, floor: u128, ts: i64 }
Graduated       { mint, pool, coin_creator, ts: i64 }
Defended        { mint, sol_spent: u64, tokens_bought: u64, spot_price: u128, floor_price: u128, venue: u8, ts: i64 }
RoundOpened     { mint, round_id: u64, sol_pot: u64, token_pot: u64, snapshot_hash: [u8; 32], recipient_count: u32, ts: i64 }
PayoutBatch     { mint, round_id: u64, recipients: u32, sol: u64, tokens: u64, ts: i64 }
RoundClosed     { mint, round_id: u64, sol_paid: u64, tokens_paid: u64, ts: i64 }
HoldBurned      { mint, sol_spent: u64, hold_burned: u64, ts: i64 }
```

Prices are `u128` fixed point: lamports per token base unit × 10^18 (`PRICE_SCALE`), identical to
`@holdfast/core` `curvePriceFixed`.
