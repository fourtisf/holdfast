# Decisions and open questions for the owner

Items marked **⚑ needs confirmation** are implemented with the default shown but are the owner's call.

## Mechanism

| # | Topic | Implemented | Notes |
|---|---|---|---|
| 1 | **⚑ Lot reduction order (FIFO vs LIFO)** | **FIFO** (oldest lot reduced first), as SPEC §2 says. `LOT_REDUCTION_ORDER=lifo` switches the indexer, and `applyDecrease(..., "lifo")` supports it. | The spec itself asks for confirmation. LIFO favours long-term holders: selling recent buys keeps old lots at 1.0×. |
| 2 | **⚑ What a sell consumes first when a wallet holds tokens without lots** (e.g. received by transfer, or the creator's dev-buy tokens) | Those **untracked tokens first**, then lots in FIFO order. | Holder-friendly. Selling transferred tokens doesn't destroy earned age. It cannot be gamed, because lots only ever come from buys. The alternative (lots first) is a one-line change in `packages/core/src/lots.ts`. |
| 3 | Hold time resolution | Weight uses **seconds**: `0.1 + 0.9 × min(seconds, 604800)/604800`. | Same curve as the spec's hours formula, continuous instead of stepping each hour. |
| 4 | **⚑ Dust and carries** | Owed amounts below the minimum (default 0.00002 SOL / 0.001 token), or that would leave an empty wallet below rent-exempt, are carried per wallet. Carries of wallets that **stopped holding** expire after **30 days** and return to the pot. | SPEC §5.3–5.4. The expiry stops an ever-growing tail of dust liabilities. Set `PAYOUT_CARRY_EXPIRY_MS=0` to never expire. |
| 5 | Recipients per round | Up to **1024** (program limit 8192). The largest owed amounts are paid first; the rest are carried whole. | Bounds keeper cost per 2-minute round. Every recipient costs ≈ 1/10 of a transaction fee. |
| 6 | **⚑ Who pays transaction fees** | The keeper wallet pays every crank and payout fee. Round account rent is refunded on close. Nothing is deducted from vaults. | Roughly 0.000005 SOL per 8–12 payouts. Taking an operator fee from the pot would contradict the spec's 0% dev share. |
| 7 | TWAP / ATH defaults | Window 600 s, sample ≥ 30 s, max gap 120 s, `ath_confirm_secs = 0` (SPEC calls confirmation optional). | **Recommend `ath_confirm_secs = 300` on mainnet** (see docs/security.md). All admin-tunable within hard bounds. |
| 8 | Defend price tolerance | Buyback may pay up to **floor × 1.03** per token, fees included. | Without tolerance a defend at spot = floor would always fail, because pump.fun fees push the effective price above spot. |
| 9 | Defend cadence | Cooldown 60 s, max 6 steps per hour (10% of the floor bucket each). | Bounds: cooldown ≥ 30 s, ≤ 60 steps per hour. |
| 10 | $HOLD burns | Keeper burns a coin's whole burn bucket once it holds ≥ 0.1 SOL, at most hourly, 4% slippage on the quote (on-chain cap 5%). | `hold_mint` can be set once. Until then the burn bucket accumulates. |
| 11 | Payout start time | Rounds align to wall-clock multiples of 120 s. The API, frontend countdown and worker share `nextRoundAt`. | Satisfies the "countdown synced with the server schedule" requirement. |

## Architecture

| # | Topic | Decision |
|---|---|---|
| 12 | SOL custody | A **system-owned treasury PDA** `["treasury", mint]` holds the SOL, is the pump.fun creator and is the buyback `user`. `CoinVault` keeps the bucket accounting. This is required by pump.fun's System-transfer payment path. See docs/program.md. |
| 13 | pump.fun account lists | Passed through `remaining_accounts` and built off-chain with the official SDKs. The program pins the security-relevant positions and builds the instruction data. |
| 14 | Fee claiming | Done by the keeper with pump.fun's permissionless sweep and claim instructions, followed by Holdfast `collect_fees` (also permissionless). |
| 15 | **⚑ Emergency pause** | Admin `set_paused` stops `defend` / `payout` / `open_round` / `burn_hold`. It cannot move funds. | A compromised admin could freeze outflows forever. Keep it behind a multisig, or remove it before mainnet if "unstoppable" matters more than an emergency brake. |
| 16 | Snapshot commitment | The merkle root of each round's entries is committed on-chain in `open_round`, and full inputs are published. Claim-based on-chain verification is a later step (SPEC §7.3). |
| 17 | Database | Postgres (PGlite in tests and local dev). Amounts are stored as exact integers (`numeric(20,0)`). |
| 18 | Program framework | Anchor 0.32 / Solana 2.3 toolchain (platform-tools v1.48). Some transitive crates are pinned in `Cargo.lock` so the SBF toolchain (rustc 1.84) builds. |

## Product

| # | Topic | Status |
|---|---|---|
| 19 | **⚑ UI prototype** | `holdfast-launchpad.html` was **not included** with the spec. The frontend follows the spec text, with theme tokens and layout isolated so it can be matched to the prototype once it's shared. |
| 20 | **⚑ Launch cost** | The spec says 0.015 SOL. The real cost is **≈ 0.0244 SOL** of rent and fees (pump.fun ≈ 0.0081, Holdfast ≈ 0.0163; breakdown in `apps/launcher/README.md`), so the deposit needed is 0.025329 SOL plus any dev buy. The API quotes it (`GET /launch/quote`), the UI shows it, and unused SOL is refunded. Options: subsidise ≈ 0.01 SOL per launch, or shrink the vault account (TWAP ring) and create treasury accounts lazily (≈ 0.0145 SOL). |
| 21 | Dev buy | Bought by the deposit address, then **transferred** to the depositor, so it never creates a lot and never earns, as the spec requires. The dev-buy transaction is also recorded as `launch_sig`, which the indexer skips. |
| 22 | Legal | Holder revenue sharing may be regulated (SPEC §7.6). Not a code decision. |
