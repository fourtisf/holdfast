# Holdfast

A memecoin launchpad on top of **pump.fun (Solana)** where coins defend their own price and pay their holders:

1. **Creator fees never reach the dev.** Every coin's pump.fun creator is a PDA of the Holdfast vault program. That program
   has no withdraw instruction.
2. **Automatic floor.** `floor = ATH × (1 − trigger)`, with trigger 15 / 25 / 35% chosen at launch and immutable. When the
   price is at or below the floor, the vault buys back with 10% of its floor bucket per step.
3. **Holders are paid by how long they hold.** Every 2 minutes, SOL plus the bought-back tokens are paid out by
   `tokens × weight`. Weight rises from 0.1× at purchase to 1.0× after 7 days.

Fee split, fixed in the program: **60% floor vault · 30% holder payouts · 10% buy & burn $HOLD · 0% dev.**

The product spec is [`docs/SPEC.md`](docs/SPEC.md) (Indonesian). Choices made where the spec left room, and the questions
for the owner, are in [`docs/decisions.md`](docs/decisions.md).

## Repository

| Path | What |
|---|---|
| `programs/holdfast-vault` | Anchor 0.32 vault program: `CoinVault` + system-owned treasury PDA, fee split, on-chain TWAP ATH, permissionless `defend`, payout rounds with merkle commitment, `burn_hold`. [docs/program.md](docs/program.md) |
| `tests/program` | LiteSVM integration tests for the compiled program, against pump.fun / PumpSwap stand-ins at their real ids (`tests/mocks`) |
| `packages/core` | Pure mechanism logic shared by every service and the web app: weights, FIFO lots, payout rounds, snapshot merkle tree and verifier, price/schedule helpers, API types |
| `packages/chain` | Solana glue: PDAs, IDL-driven vault client, pump.fun / PumpSwap event and account decoders, deposit key derivation |
| `packages/db` | Postgres schema and migrations, repositories, PGlite for tests/local dev |
| `apps/indexer` | Parses pump.fun / PumpSwap / Holdfast transactions into trades, lots, balances, candles, vault mirrors |
| `apps/keeper` | Keeper crank (fees, TWAP sampling, graduation, defend, $HOLD burn) and the 2-minute payout worker |
| `apps/launcher` | Launch flow: deposit address → pump.fun `create_v2(creator = treasury)` → `init_coin` → dev buy → refund |
| `apps/api` | Fastify REST + WebSocket API for the frontend ([docs/api.md](docs/api.md)) |
| `apps/web` | Next.js 15 + Tailwind 4 frontend |

Test suites: 52 Rust (program unit + LiteSVM integration) and 317 TypeScript (core 49, chain 17, db 19, indexer 32,
api 52, keeper 10 incl. end-to-end against the compiled program, launcher 77, web 61).

Further reading: [pump.fun integration and §8 verification](docs/pump-integration.md) ·
[payout rounds and verification](docs/payouts.md) · [security model](docs/security.md).

## Prerequisites

- Node 22, pnpm 10
- Rust (stable), Solana CLI **2.3.x** (Agave), Anchor CLI **0.32.1**. `anchor build` fetches platform-tools v1.48 on first use.
- Postgres 15+ for running the services (tests use PGlite, so they don't need it)

## Build and test

```bash
pnpm install
pnpm --filter @holdfast/core --filter @holdfast/chain --filter @holdfast/db build

# on-chain program + test stand-ins
anchor build -p holdfast_vault
cargo build-sbf --manifest-path tests/mocks/mock-pump/Cargo.toml --sbf-out-dir target/deploy
cargo build-sbf --manifest-path tests/mocks/mock-pump-amm/Cargo.toml --sbf-out-dir target/deploy
cargo test -p holdfast-vault -p holdfast-vault-tests     # unit + LiteSVM integration tests

pnpm -r test                                             # every TypeScript package (keeper e2e uses the built .so files)
pnpm -r typecheck
```

After changing the program, run `pnpm --filter @holdfast/chain idl:sync` to copy the IDL into the TS client.

## Running locally

```bash
cp .env.example .env            # fill in RPC, keypairs, DATABASE_URL, DEPOSIT_MASTER_SECRET
pnpm db:migrate
pnpm --filter @holdfast/api dev            # REST + WS on :4000
pnpm --filter @holdfast/indexer start
pnpm --filter @holdfast/keeper start:keeper
pnpm --filter @holdfast/keeper start:payout
pnpm --filter @holdfast/launcher start
pnpm --filter @holdfast/web dev            # http://localhost:3000
```

No Postgres and no Solana at hand? `pnpm --filter @holdfast/api dev:pglite` serves a seeded demo dataset (embedded
Postgres, simulated trades), and the web app can point at it.

The frontend also runs with no backend at all: `NEXT_PUBLIC_USE_MOCKS=1 pnpm --filter @holdfast/web dev`.

### Deploying the program (devnet first)

1. `solana-keygen new -o target/deploy/holdfast_vault-keypair.json`, then `anchor keys sync` (updates `declare_id!` and `Anchor.toml`).
2. `anchor build -p holdfast_vault && anchor deploy --provider.cluster devnet -p holdfast_vault`.
3. Call `initialize(keeper, launcher, params)` from the upgrade authority.
4. Work through the devnet PoC checklist in [docs/pump-integration.md](docs/pump-integration.md#devnet-poc-checklist-spec-91) before building anything else on top.
5. Before mainnet: external audit, upgrade authority moved to a multisig or timelock (or frozen), admin moved to a multisig.

## Acceptance criteria (SPEC §10)

| Criterion | Status |
|---|---|
| Launch by only sending SOL; fees flow to the vault PDA | Implemented and tested against an instruction-executing fake chain (`apps/launcher`, 77 tests). `init_coin` refuses a coin unless `creator == treasury`. **Devnet run pending.** Real cost ≈ 0.0244 SOL, see [decisions #20](docs/decisions.md) |
| 60/30/10 split proven on-chain | ✅ program tests `fees_split_exactly_60_30_10`, keeper e2e |
| No way to withdraw SOL except the three paths (proven by tests) | ✅ `tests/program/tests/no_withdraw.rs` (instruction set pinned, admin powers, randomised lamport conservation) |
| Price ≤ floor triggers a 10% buyback, cooldown works, tokens go to the holder pool | ✅ `ath_defend.rs`, keeper e2e |
| Payout every 2 minutes per the weight formula, snapshot re-verifiable | ✅ `packages/core` tests, keeper e2e (snapshot root = on-chain `RoundOpened` root), `verify-round` CLI |
| Dev buy and transferred tokens earn nothing | ✅ lot rules (`packages/core` lots tests, indexer tests), dev buy delivered by transfer |
| Desktop and mobile UI match the prototype | Prototype file not provided. UI built from the spec text, with screenshots in `apps/web/screenshots/` |
