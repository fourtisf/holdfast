# pump.fun integration — verification of SPEC §8

Sources checked on **2026-10-13**:
- IDLs shipped in `@pump-fun/pump-sdk` **4.1.0** (`pump.json`, `pump_amm.json`, `pump_fees.json`) and `@pump-fun/pump-swap-sdk` **2.1.0**. Both packages carry the same `pump_amm.json`.
- pump.fun's public docs repo `pump-fun/pump-public-docs` (README, `docs/instructions/*`, creator-fee, PumpSwap, sweep and virtual-reserve docs).
- The SDK sources: `sdk.ts`, `onlineSdk.ts`, `bondingCurve.ts`, `pda.ts`, and `offlinePumpAmm.ts` in pump-swap-sdk.

Program ids are the same on mainnet and devnet:

| Program | Id |
|---|---|
| pump (bonding curve) | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` |
| pump_amm (PumpSwap) | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` |
| pump_fees | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` |

> These facts come from the published IDLs, docs and SDK code. **They have not been run against devnet yet**, because this
> environment cannot reach any Solana RPC. The devnet PoC checklist at the end is still step 1 of SPEC §9.

## 1. Can a coin's creator be a program PDA? **Yes.**

- `create_v2(name, symbol, uri, creator: Pubkey, is_mayhem_mode, is_cashback_enabled, creator_fee_bps, is_holder_reward)`
  takes the creator as a **plain argument**. The signing payer (`user`) is a separate account. The legacy `create` is
  deprecated and takes `creator` the same way. The docs warn: *"be careful what creator pubkey you pass … that
  pubkey will receive all the creator fees for that coin."*
- Moatpad passes `creator = treasuryPda(mint) = ["treasury", mint]` under the vault program. `init_coin` refuses a coin
  unless the bonding curve's stored `creator` (offset 49) equals that PDA.
- When the curve migrates, pump.fun copies the creator into the canonical pool's `Pool.coin_creator`.
- Do **not** set `is_holder_reward = true`. Holder-reward coins ignore `creator` and route fees to pump.fun's own holder-rewards PDA.
- Do not use mayhem mode or a non-SOL quote. `init_coin` checks the curve's `quote_mint` is the zero key or WSOL.

Why the creator is a *system-owned* PDA rather than the `CoinVault` data account: pump.fun's buys pull SOL from
`user` with a System Program transfer. That only works from an account owned by the System Program with no data. The
treasury PDA has no data, so the vault program can sign for it (`invoke_signed`) as the buyer in `defend` and
`burn_hold`, and as the source of payout transfers.

## 2. How are creator fees claimed? **All permissionless, no creator signature.**

Creator fees accrue in pump.fun-owned vaults and are claimed by instructions that **anyone** can call. The coin creator is
not a signer:

| Stage | Where fees sit | Move them | Then claim to the creator |
|---|---|---|---|
| Bonding curve, legacy trades (`buy`, `sell`, …) | creator vault PDA `["creator-vault", creator]` (pump) | — | `collect_creator_fee_v2` (SOL quote: lamport transfer vault → `creator`) |
| Bonding curve, v3 trades (fees kept on the curve) | `BondingCurve.creator_fee` | `sweep_creator_fee` (pump) | `collect_creator_fee_v2` |
| PumpSwap, v1 trades | coin-creator vault ATA (WSOL), authority `["creator_vault", coin_creator]` (pump_amm) | — | `collect_coin_creator_fee` → creator's WSOL token account |
| PumpSwap, v2 trades (fees kept in the pool) | `Pool.creator_fees` | `sweep_creator_fee` (pump_amm) | `collect_coin_creator_fee` |

What the Moatpad keeper sends in one transaction (`apps/keeper/src/pump.ts`, built with the SDKs):
`pump sweep_creator_fee` → (after graduation) `pump_amm sweep_creator_fee` → `collect_creator_fee_v2` (+ the AMM
`collect_coin_creator_fee` leg when its vault ATA exists, via `OnlinePumpSdk.collectCoinCreatorFeeV2Instructions` with the
keeper as fee payer, so the SDK never tries to close the treasury's WSOL account) → **Moatpad `collect_fees`**.
`collect_fees` unwraps the treasury's WSOL account by closing and re-creating it, then books every unaccounted lamport 50/25/15/10.
Because `collect_fees` books whatever arrived, fees claimed by anyone else, or donations, still end up split correctly.

## 3. Buy CPIs (curve and PumpSwap)

| Venue | Instruction | Data | Accounts |
|---|---|---|---|
| Curve | `buy_exact_sol_in` `[56,252,116,8,158,223,205,95]` | `spendable_sol_in u64, min_tokens_out u64, track_volume OptionBool, partial_fill OptionBool` | 16 in IDL order (same list as `buy`), plus trailing accounts the SDK appends (`bonding_curve_v2`, buyback fee recipient) |
| PumpSwap | `buy_exact_quote_in` `[198,46,21,82,180,217,232,112]` | `spendable_quote_in u64, min_base_amount_out u64, track_volume OptionBool` | 23 in IDL order (same list as `buy`), plus SDK trailing accounts |

How the vault uses them (`programs/holdfast-vault/src/venue.rs`, `swap.rs`):
- The account list is **passed through** from `remaining_accounts`, because pump.fun keeps appending accounts.
- The program **builds the instruction data itself**: the exact budget, a min-out that is never below the floor-price cap,
  `track_volume = false`, and `partial_fill = false`.
- It pins the positions that matter: mint, curve or pool, `user = treasury`, the receiving token account = the treasury ATA,
  the quote account = the treasury WSOL ATA, the pool vaults, and the program id at its slot.
- After the CPI it re-measures what really happened. SOL spent is the drop in treasury lamports plus WSOL; tokens received
  is the rise in the treasury ATA. The buy is rejected if tokens < required or SOL > budget + 0.01 SOL rent allowance.
  Tests prove this check holds even when the venue misbehaves.
- PumpSwap buys need WSOL. The program wraps exactly the budget into the treasury's WSOL account (`sync_native`), then
  unwraps any change afterwards (close + re-create).
- `init_user_volume_accumulator` (payer ≠ user, user is not a signer) pre-creates the treasury's accumulators, so buybacks
  never pay rent inside the swap. The vault's own `prepare_treasury` calls it (payer = treasury, signed by the program,
  rent from the floor bucket) for the curve before the first buyback and for PumpSwap after graduation.

## 4. Reading prices straight from reserves

| Venue | Account | Price (lamports per base unit × 1e18) |
|---|---|---|
| Curve | `BondingCurve` PDA `["bonding-curve", mint]`: `virtual_token_reserves` @8, `virtual_quote_reserves` @16, `complete` @48, `creator` @49, `quote_mint` @83 | `virtual_quote × 1e18 / virtual_token` |
| PumpSwap | canonical `Pool` PDA `["pool", 0u16, pool_authority(["pool-authority", mint] under pump), mint, WSOL]`: base/quote vaults @139/@171, `coin_creator` @211, `virtual_quote_reserves: i128` @245 | `(quote_vault.amount + virtual_quote_reserves) × 1e18 / base_vault.amount` |

pump.fun's docs say `virtual_quote_reserves` is **signed** and can be negative, because fees kept in a pool are
subtracted from it. They guarantee `amount + virtual_quote_reserves` never goes negative. Older accounts are
shorter; missing trailing fields read as 0. The vault program and `@holdfast/chain` decoders use the same offsets, and both
are tested.

## 5. Trust assumptions on pump.fun (outside our control)

- **Admin creator changes.** `set_creator` (by `Global.set_creator_authority`), `admin_cto` / `admin_cto_pool`, and
  `create_fee_sharing_config` (also callable by `admin_set_creator_authority`) let pump.fun's admins re-point a coin's
  creator fees. Moatpad can't prevent this. The indexer should alert on `SetCreatorEvent`, `AdminCtoEvent` and
  `CreateFeeSharingConfigEvent` for our mints.
- **Upgrades.** pump.fun upgrades both programs often: v2/v3 trade instructions, fee sweeps, negative virtual reserves, and
  depth-2 quote coins on 2026-10-13. Pass-through accounts plus SDK-built lists absorb most changes without a vault upgrade.
  A change to `buy_exact_sol_in`'s data layout, or to the pinned positions, would need one.
- **Fee tiers.** pump.fun fees are tiered by market cap (`pump_fees` FeeConfig). Off-chain quotes use conservative estimates.
  On-chain safety comes from the floor-price cap, not the quote.

## Devnet PoC checklist (SPEC §9.1). Do this before anything else on devnet.

`pnpm --filter @holdfast/keeper devnet-poc` (see [runbook.md](runbook.md#1-devnet-rehearsal)) automates steps 1–4 and 7
through the real services and, with `--defend`, attempts step 5. It writes every signature to a report. Steps 6
(graduation) and the PumpSwap half of 4–5 remain manual: completing a curve takes ≈ 85 SOL of buys.

1. Deploy `holdfast_vault` to devnet and run `initialize` from the upgrade authority.
2. `create_v2` with `creator = treasuryPda(mint)`. Read the bonding curve and confirm `creator` at offset 49.
3. `init_coin`. Then, once fees are collected, `prepare_treasury` with the pump volume accounts: confirm the CPI
   into `init_user_volume_accumulator` with the treasury PDA as payer succeeds.
4. Trade a few times from another wallet. Then `sweep_creator_fee` + `collect_creator_fee_v2` + `collect_fees`, and
   confirm the 50/25/15/10 buckets equal the claimed lamports.
5. Push the price below a manual floor (set short TWAP params) and run `defend` against the **real** pump program.
   Confirm the tokens land in the treasury ATA and the event values match.
6. Complete a curve (devnet), `graduate`, then repeat steps 4–5 on PumpSwap.
7. Run a payout round to two wallets and verify with `pnpm --filter @holdfast/keeper verify-round`.
