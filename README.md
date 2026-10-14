# Moatpad

<img src="brand/png/moatpad-logo-on-dark.png" alt="Moatpad" height="80">

**[moatpad.fun](https://moatpad.fun) · Every coin gets a moat.**

A memecoin launchpad on top of **pump.fun (Solana)** where coins defend their own price and pay their holders:

1. **Creator fees never reach the dev.** Every coin's pump.fun creator is a PDA of the Moatpad vault program. That program
   has no withdraw instruction.
2. **Automatic floor.** `floor = ATH × (1 − trigger)`, with trigger 15 / 25 / 35% chosen at launch and immutable. When the
   price is at or below the floor, the vault buys back with 10% of its floor bucket per step.
3. **Holders are paid by how long they hold.** Every 2 minutes, SOL plus the bought-back tokens are paid out by
   `tokens × weight`. Weight rises from 0.1× at purchase to 1.0× after 7 days.

Fee split, fixed in the program: **60% floor vault · 30% holder payouts · 10% buy & burn $MOAT · 0% dev.**

The code keeps the project's codename, **holdfast**: the `@holdfast/*` packages, the `holdfast_vault` program, the
`HOLDFAST_*` settings and the database names. Only what users see says Moatpad.

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
| `apps/indexer` | Parses pump.fun / PumpSwap / Moatpad transactions into trades, lots, balances, candles, vault mirrors |
| `apps/keeper` | Keeper crank (fees, TWAP sampling, graduation, defend, $MOAT burn) and the 2-minute payout worker |
| `apps/launcher` | Launch flow: deposit address → one atomic transaction (pump.fun `create_v2(creator = treasury)` + `init_coin` + dev buy) → refund; IPFS metadata (Pinata) |
| `apps/api` | Fastify REST + WebSocket API for the frontend ([docs/api.md](docs/api.md)) |
| `apps/notifier` | Telegram bot: payouts, floor defences, graduations and weight milestones for watched wallets and coins ([docs/notifier.md](docs/notifier.md)) |
| `apps/web` | Next.js 15 + Tailwind 4 frontend |

Test suites: 56 Rust (program unit + LiteSVM integration) and 443 TypeScript (core 60, chain 19, db 25, ops 5,
indexer 33, api 74, keeper 17 incl. end-to-end against the compiled program, launcher 93, notifier 47, web 70).

Further reading: [pump.fun integration and §8 verification](docs/pump-integration.md) ·
[payout rounds and verification](docs/payouts.md) · [security model](docs/security.md) ·
[Telegram notifier](docs/notifier.md) · [**runbook: devnet rehearsal → mainnet**](docs/runbook.md) ·
[logo and brand assets](brand/README.md).

What a user gets beyond the mechanism: graduation progress, SOL/USD display, a watchlist and filters, PnL and trade
history per wallet, leaderboards (earners, diamond hands, creators), creator pages, wallet-signed comments with holder
badges, per-round verification in the browser against the on-chain commitment, share cards, priority fees, and
open-in-wallet links on iOS.

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
pnpm --filter @holdfast/notifier start     # Telegram bot (needs TELEGRAM_BOT_TOKEN)
pnpm --filter @holdfast/web dev            # http://localhost:3000
```

No Postgres and no Solana at hand? `pnpm --filter @holdfast/api dev:pglite` serves a seeded demo dataset (embedded
Postgres, simulated trades), and the web app can point at it.

The frontend also runs with no backend at all: `NEXT_PUBLIC_USE_MOCKS=1 pnpm --filter @holdfast/web dev`.

### Telegram notifier

`apps/notifier` is a Telegram bot for holders. `/watch <wallet>` sends a message for every payout that wallet
receives ("💰 You earned 0.0123 SOL from $TICKER round #42") and when one of its positions reaches 0.5x and full
weight. `/coin <mint>` follows a coin's round results, floor defences and graduation to PumpSwap. It listens on the
`holdfast_events` channel the indexer and payout worker publish on, and records every message in `tg_sent` so a
restart never sends anything twice. Create a bot with @BotFather, set `TELEGRAM_BOT_TOKEN` and `WEB_URL`, and run
`pnpm --filter @holdfast/notifier start`. Commands, events and operations: [docs/notifier.md](docs/notifier.md).

### Deploying the program (devnet first)

1. `solana-keygen new -o target/deploy/holdfast_vault-keypair.json`, then `anchor keys sync` (updates `declare_id!` and `Anchor.toml`).
2. `anchor build -p holdfast_vault && anchor deploy --provider.cluster devnet -p holdfast_vault`.
3. Call `initialize(keeper, launcher, params)` from the upgrade authority (`pnpm --filter @holdfast/keeper admin -- init …`).
4. Start the stack and run the end-to-end proof of concept with real devnet transactions:
   `pnpm --filter @holdfast/keeper devnet-poc -- --api … --rpc … --payer …`. Then work through the remaining manual items in
   [docs/pump-integration.md](docs/pump-integration.md#devnet-poc-checklist-spec-91).
5. Mainnet (audit, verifiable build, multisig upgrade authority and admin, $MOAT, monitoring, incidents):
   [docs/runbook.md](docs/runbook.md).

## Docker

```bash
cp .env.example .env            # RPC, DEPOSIT_MASTER_SECRET, LAUNCHER_ADDRESS, NEXT_PUBLIC_*, ...
mkdir -p keys                   # keeper.json + launcher.json (Solana CLI keypairs), mounted read-only
docker compose up --build       # web http://localhost:3000, api :4000, indexer webhooks :4100
```

`docker-compose.yml` runs Postgres 16 (volume `pgdata`), a one-shot `migrate` (`pnpm db:migrate`), then `api`, `indexer`,
`keeper`, `payout`, `launcher`, `notifier` and `web`. Every backend reads `.env`; compose points `DATABASE_URL` at the `postgres`
service (`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`, all defaulting to `holdfast`), the keypair paths at
`/app/keys/keeper.json` and `/app/keys/launcher.json`, and `METADATA_STORE` at a volume shared by the api and the launcher.
`NEXT_PUBLIC_*` are build args of the web image, so run `docker compose build web` after changing them. The keeper,
payout and launcher exit and restart until the program is deployed and the keypairs match `Config.keeper` / `Config.launcher`;
the notifier does the same until `TELEGRAM_BOT_TOKEN` is set.

The root `Dockerfile` builds two images: the default `services` target holds every backend, and `--target web` holds the
Next.js app. A service is its package's start script command, run from the package directory:

| Service | `-w` (working dir) | Command |
|---|---|---|
| api (image default) | `/app/apps/api` | `tsx src/main.ts` |
| indexer | `/app/apps/indexer` | `tsx src/main.ts` |
| keeper | `/app/apps/keeper` | `tsx src/main-keeper.ts` |
| payout | `/app/apps/keeper` | `tsx src/main-payout.ts` |
| launcher | `/app/apps/launcher` | `tsx src/main.ts` |
| notifier | `/app/apps/notifier` | `tsx src/main.ts` |
| migrations | `/app` | `pnpm db:migrate` |
| web (`--target web`) | `/app/apps/web` | `next start --port 3000` |

CI (`.github/workflows/ci.yml`) builds and tests the program, runs the TypeScript typecheck and tests against the compiled
`.so` files, and builds both images.

## Acceptance criteria (SPEC §10)

| Criterion | Status |
|---|---|
| Launch by only sending SOL; fees flow to the vault PDA | Implemented and tested against an instruction-executing fake chain (`apps/launcher`), in one atomic transaction (anti-snipe) or the four-transaction fallback. `init_coin` refuses a coin unless `creator == treasury`. **0.015 SOL**, as specified ([decisions #20](docs/decisions.md)). **Devnet run pending**: `devnet-poc` automates it ([runbook](docs/runbook.md)) |
| 60/30/10 split proven on-chain | ✅ program tests `fees_split_exactly_60_30_10`, keeper e2e |
| No way to withdraw SOL except the three paths (proven by tests) | ✅ `tests/program/tests/no_withdraw.rs` (instruction set pinned, admin powers, randomised lamport conservation) |
| Price ≤ floor triggers a 10% buyback, cooldown works, tokens go to the holder pool | ✅ `ath_defend.rs`, keeper e2e |
| Payout every 2 minutes per the weight formula, snapshot re-verifiable | ✅ `packages/core` tests, keeper e2e (snapshot root = on-chain `RoundOpened` root), `verify-round` CLI |
| Dev buy and transferred tokens earn nothing | ✅ lot rules (`packages/core` lots tests, indexer tests), dev buy delivered by transfer |
| Desktop and mobile UI match the prototype | Prototype file not provided. UI built from the spec text; `pnpm --filter @holdfast/web screenshots` smoke-tests every page at desktop and mobile size in mock mode |
