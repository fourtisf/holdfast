# Runbook: devnet rehearsal to mainnet

How to take Holdfast from a fresh checkout to a mainnet launch, and how to operate it afterwards. Commands
assume the repository root, a filled-in `.env` (see `.env.example`) and the toolchain from the README.

Nothing in this runbook can move vault funds. The program has no withdraw path; every admin power is listed in
[program.md](program.md) and pinned by `tests/program/tests/no_withdraw.rs`. The keys below protect *liveness*
(who can crank, launch, pause, upgrade), not custody. Program upgrades are the exception: an upgrade can change
everything, which is why the upgrade authority goes to a multisig or is frozen.

## 0. Keys and accounts

| Key | Holds | Lives in | Notes |
|---|---|---|---|
| Program upgrade authority | nothing | Squads multisig after deploy (or frozen) | The most powerful key. A single hot key here undoes every guarantee. |
| Config admin | nothing | Squads multisig | `set_params` (within hard bounds), `set_keeper`, `set_launcher`, `set_hold_mint` (once), `set_paused`. |
| Keeper | ≈ 0.5 SOL working balance | server (`KEEPER_KEYPAIR`) | Pays crank and payout fees. Round rent is refunded on close. |
| Launcher | small working balance | server (`LAUNCHER_KEYPAIR`) | Signs launches, owns the lookup table. Set `LAUNCHER_ADDRESS` so it is excluded from payouts. |
| Deposit master secret | derives every deposit address | server secret (`DEPOSIT_MASTER_SECRET`) | Losing it strands deposits that were never processed; leaking it lets someone sweep pending deposits. Back it up offline. |
| Admin API token | moderation only | `ADMIN_TOKEN` (≥ 24 chars) | Hides coins and comments; cannot touch funds. |

External services: a paid RPC with archival history (payout verification reads old `open_round` transactions)
and raw transaction webhooks (Helius, `HELIUS_WEBHOOK_SECRET`), Postgres 16 with backups, Pinata for IPFS
metadata (`METADATA_STORAGE=pinata`, `PINATA_JWT`, `IPFS_GATEWAY_URL`), an image classifier for uploads
(`MODERATION_IMAGE_WEBHOOK_URL`), a Telegram bot for users (`TELEGRAM_BOT_TOKEN`) and one for operator alerts.

## 1. Devnet rehearsal

pump.fun and PumpSwap are deployed on devnet at the mainnet addresses, so the whole stack runs there unchanged.

1. Program:
   ```bash
   solana-keygen new -o target/deploy/holdfast_vault-keypair.json && anchor keys sync
   anchor build -p holdfast_vault && anchor deploy --provider.cluster devnet -p holdfast_vault
   pnpm --filter @holdfast/chain idl:sync
   pnpm --filter @holdfast/keeper admin -- init <KEEPER_PUBKEY> <LAUNCHER_PUBKEY> --rpc $SOLANA_RPC_URL --signer <upgrade-authority.json>
   ```
   Set `HOLDFAST_PROGRAM_ID` everywhere if you deployed under a new address.
2. Lookup table for atomic (anti-snipe, 0.015 SOL) launches:
   ```bash
   pnpm --filter @holdfast/launcher alt create     # prints the table address
   ```
   Put it in `LAUNCHER_LOOKUP_TABLE` (launcher **and** api, so quotes match).
3. Stack: `docker compose up --build`, or the `pnpm … start` commands from the README. Point `SOLANA_RPC_URL`
   at devnet. For the rehearsal, let tiny pots pay out: `PAYOUT_MAX_FEE_BPS=10000`.
4. Proof of concept, with real transactions:
   ```bash
   solana airdrop 2 --url devnet --keypair ~/.config/solana/devnet.json
   pnpm --filter @holdfast/keeper devnet-poc -- --api http://localhost:4000 --rpc $SOLANA_RPC_URL \
     --payer ~/.config/solana/devnet.json --seed-fees 0.02 --defend --out poc-report.json
   ```
   It launches a coin through the deposit flow, buys with two wallets, seeds creator fees through the coin's
   pump.fun creator vault (collected exactly like trading fees), waits for a closed payout round, verifies it
   against its inputs and the root committed on-chain, and with `--defend` dumps the holders' tokens to make the
   vault buy back at the floor (reported, not required: whether the floor is reached depends on curve depth and
   the TWAP-based ATH). Every signature lands in the report. Then work through the manual items in
   [pump-integration.md](pump-integration.md#devnet-poc-checklist-spec-91) (graduation, PumpSwap fees and
   buybacks, `burn_hold`).
5. Soak for at least 48 hours with alerts wired (section 4). Watch `/metrics` for crank errors, payout latency and
   indexer lag. Kill and restart each service once and confirm nothing double-pays or double-sends.

## 2. Audit gate

Do not deploy to mainnet without an external audit of `programs/holdfast-vault`. Hand auditors
[security.md](security.md) (invariants, SPEC §7 risks, trust assumptions, the audit focus list),
[program.md](program.md) and the LiteSVM suites. After fixes, freeze the code and record a verifiable build hash
(`solana-verify build` / `anchor build --verifiable`) so anyone can match the deployed bytecode to the source.

## 3. Mainnet deployment

1. **Program.** Deploy from a clean machine with the audited commit:
   ```bash
   anchor build --verifiable -p holdfast_vault
   solana program deploy target/verifiable/holdfast_vault.so --program-id target/deploy/holdfast_vault-keypair.json \
     --url mainnet-beta --with-compute-unit-price 50000
   ```
2. **Initialize** while the deployer is still the upgrade authority (only the upgrade authority may call
   `initialize`). Use mainnet parameters, notably `athConfirmSecs: 300` ([decisions #7](decisions.md)):
   ```bash
   echo '{ "athConfirmSecs": 300 }' > params.mainnet.json
   pnpm --filter @holdfast/keeper admin -- init <KEEPER> <LAUNCHER> params.mainnet.json --rpc $RPC --signer deployer.json
   pnpm --filter @holdfast/keeper admin -- show --rpc $RPC
   ```
3. **Hand the keys to the multisig.** Create a Squads vault, then:
   ```bash
   pnpm --filter @holdfast/keeper admin -- transfer-admin <SQUADS_VAULT> --rpc $RPC --signer deployer.json
   # the instruction for a Squads proposal (no signer needed); execute it in Squads
   pnpm --filter @holdfast/keeper admin -- accept-admin --print --as <SQUADS_VAULT> --rpc $RPC
   solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <SQUADS_VAULT> \
     --skip-new-upgrade-authority-signer-check --url mainnet-beta --keypair deployer.json
   ```
   Or freeze the program for good with `solana program set-upgrade-authority <PROGRAM_ID> --final`. That removes
   the upgrade risk, and also any way to adapt when pump.fun changes its instructions
   ([pump-integration.md §5](pump-integration.md)).
   Decide on the emergency pause ([decisions #15](decisions.md)): it can freeze outflows, so it is only acceptable
   behind the multisig.
4. **$HOLD.** Launch $HOLD (through Holdfast itself, or on pump.fun), then set it once from the multisig:
   `pnpm --filter @holdfast/keeper admin -- set-hold-mint <HOLD_MINT> --print --as <SQUADS_VAULT> --rpc $RPC`
   gives the instruction to propose. Until then each coin's burn bucket accrues and nothing is lost.
5. **Lookup table.** `pnpm --filter @holdfast/launcher alt create` against mainnet; set `LAUNCHER_LOOKUP_TABLE`.
6. **Services.** Fill `.env` for mainnet: `SOLANA_RPC_URL`, `HELIUS_WEBHOOK_SECRET`, `DEPOSIT_MASTER_SECRET`,
   `LAUNCHER_ADDRESS`, `METADATA_STORAGE=pinata` and its keys, `ADMIN_TOKEN`, `REPORT_SALT`,
   `MODERATION_BLOCKLIST_FILE`, `MODERATION_IMAGE_WEBHOOK_URL` with `MODERATION_IMAGE_FAIL_CLOSED=true`,
   `KEEPER_MIN_BALANCE_LAMPORTS`, the alert sinks, `CORS_ORIGIN`, and the web build args (`NEXT_PUBLIC_API_URL`,
   `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_SOLANA_RPC_URL`, `NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta`,
   `NEXT_PUBLIC_SITE_URL`). Keep `PAYOUT_MAX_FEE_BPS` at its default (200) so rounds never cost more than they pay.
   Register the indexer's webhook URL (`/webhooks/helius`, raw transactions) for the program and the launcher.
7. **Fund** the keeper and launcher wallets. Run `pnpm --filter @holdfast/launcher cost -- --atomic --ipfs` and
   check the quote is 0.015 SOL.
8. **Smoke test on mainnet** with a small real launch from a team wallet: deposit, go live, buy, fees collected,
   first payout round, verify page green (`/coin/<mint>/round/<id>`). Only then announce.
9. **Legal sign-off** on holder revenue sharing (SPEC §7.6, [decisions #22](decisions.md)) before the public launch.

## 4. Monitoring

Each backend serves `/healthz` and Prometheus `/metrics`: api on its own port, indexer 9101, keeper 9102,
payout 9103, notifier 9104 (`*_OPS_PORT`). Alerts go to Telegram and/or a webhook (`ALERT_*` in `.env.example`),
throttled, with a message when the condition clears.

| Alert | Meaning | Action |
|---|---|---|
| `keeper_balance` warning/critical | keeper wallet is running out | top it up; payouts pause rather than fail while it is low |
| `creator:<mint>` critical | pump.fun's admin re-pointed a coin's creator: its fees stop reaching the vault | nothing on-chain can force it back; publish it, contact pump.fun, hide the coin if it becomes a trap. Vault funds already collected stay safe. |
| crank / payout failure streaks | the same action failed 3 times in a row | read the service log; common causes are RPC limits, a pump.fun upgrade (run `alt sync`, bump the SDKs) or an empty keeper |
| `launches_stuck`, `launch_failed:<id>` | a launch is not progressing, or failed and was refunded | `/admin` → Launches; `retry` re-runs a stuck one (the in-flight guard still applies) |
| indexer lag (add a Prometheus rule on `indexer_last_processed_timestamp_seconds`; no built-in alert) | no new transactions indexed | check the webhook delivery and the poller; restarts re-scan from the saved cursors |
| `telegram_poll` | bot token rejected or a second poller | fix the token; run one notifier per bot |

## 5. Incidents

- **pump.fun upgrade changes accounts or instructions.** Builds fail at `defend`/`collect_fees` with account
  errors. Bump `@pump-fun/pump-sdk` / `pump-swap-sdk`, re-check [pump-integration.md](pump-integration.md), run
  `alt sync`, redeploy services. If the program must change, it goes through the multisig upgrade.
- **RPC outage.** Services retry; payouts resume on the next round with nothing lost (the pot stays on-chain).
  Switch `SOLANA_RPC_URL` to the standby provider.
- **Database loss.** Restore the latest backup, then let the indexer re-scan (it resumes from its cursors and is
  idempotent). Payout rounds are committed on-chain, so a round is never paid twice: `open_round` / `payout`
  refuse duplicates.
- **Compromised keeper or launcher key.** Neither can move vault funds. Rotate with `set_keeper` /
  `set_launcher` from the multisig (`admin -- set-keeper <NEW> --print --as <SQUADS_VAULT>`), then update the
  services.
- **Compromised admin token.** Rotate `ADMIN_TOKEN`; review `/admin/log`; unhide anything hidden by the attacker.
