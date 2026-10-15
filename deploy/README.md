# Deploying on one server

Runs the whole stack from `docker-compose.yml` on a single Ubuntu server, behind Caddy for HTTPS, on one
domain:

| URL | Goes to |
|---|---|
| `https://<SITE_DOMAIN>` | web (Next.js) |
| `https://www.<SITE_DOMAIN>` | redirect to the site |
| `https://<SITE_DOMAIN>/api/...` | api: REST, `/api/ws`, `/api/metadata` (prefix stripped; `/api/metrics` is blocked) |
| `https://<SITE_DOMAIN>/webhooks/helius` | indexer (Helius raw webhooks) |

Only Caddy publishes ports (80 and 443); the other services are reachable inside the compose network only.

## First deployment

DNS first: A records for `@` and `www` pointing at the server. Caddy requests the certificates on its
first start and retries until the records resolve.

```bash
# as root on the server
apt-get update && apt-get -y upgrade
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443 && ufw --force enable

git clone https://github.com/fourtisf/holdfast.git /opt/moatpad
cd /opt/moatpad
bash deploy/init.sh moatpad.fun mainnet-beta   # .env with fresh secrets + keeper/launcher keypairs
docker compose up -d --build postgres migrate api indexer web caddy
```

`deploy/init.sh` writes `.env` (production URLs, random `POSTGRES_PASSWORD`, `DEPOSIT_MASTER_SECRET`,
`ADMIN_TOKEN`, `REPORT_SALT`, and `COMPOSE_FILE` so plain `docker compose` also loads
`deploy/docker-compose.prod.yml`) and creates `keys/keeper.json` and `keys/launcher.json`. It never overwrites
either. Copy `.env` and `keys/` somewhere safe off the server: `DEPOSIT_MASTER_SECRET` derives every launch
deposit address.

The second argument picks the cluster (`devnet` by default). On mainnet, replace the public RPC in `SOLANA_RPC_URL`,
`SOLANA_WS_URL` and `NEXT_PUBLIC_SOLANA_RPC_URL` with a paid endpoint (Helius, Triton, QuickNode): the public one is
rate limited. `NEXT_PUBLIC_*` changes need a web rebuild.

Launches start paused (`LAUNCHES_PAUSED=true`): the API hands out no deposit addresses and the create page shows
"Launches open soon". `NEXT_PUBLIC_MOAT_CA` fills the $MOAT contract address in the announcement bar ("Coming soon"
while empty); `NEXT_PUBLIC_X_URL` overrides the X link (default https://x.com/moatpad).

## The program and the on-chain services

`keeper`, `payout`, `launcher` and `notifier` need the vault program deployed and initialized with the keeper and
launcher addresses that `init.sh` printed (`keys/*.address`), plus `TELEGRAM_BOT_TOKEN` for the notifier.
`deploy/program.sh` does the on-chain part from the server. It keeps the deployer keypair (fee payer, upgrade
authority, Config admin) and the program keypair in `~/moatpad-admin`, outside the repository and every container:

```bash
bash deploy/program.sh keys       # installs the Solana CLI, creates both keypairs, prints their addresses
```

The program address is compiled into the program, so the binary is built for it on a machine with the toolchain:
`bash deploy/build-program.sh <PROGRAM_ADDRESS>` writes `deploy/program/` (binary, sha256, address), which is
committed. Then, with the deployer funded (about 4.7 SOL: rent for the 653 KB program, kept for as long as the program
exists, plus fees; send 5) and the keeper and launcher funded (0.5 and 0.1 SOL):

```bash
git pull
bash deploy/program.sh deploy     # checks the hash, the address and the balance; sets HOLDFAST_PROGRAM_ID in .env
bash deploy/program.sh init       # Config with the keeper, the launcher and the mainnet parameters
bash deploy/program.sh admin set-platform-treasury <TREASURY_WALLET>
bash deploy/program.sh alt        # the launcher's lookup table, written to LAUNCHER_LOOKUP_TABLE
docker compose up -d --build      # every service, launches still paused
bash deploy/program.sh status     # addresses, balances, the program, the pause flag
bash deploy/program.sh launches open    # `launches pause` closes them again
```

Right after opening, before announcing, run a small launch from a team wallet through the site (deposit, live, a
buy, fees collected, a payout round, the verify page green), and pause again if anything is off.

`deploy` also upgrades a deployed program from a newer `deploy/program/`. Moving the upgrade authority and the
admin to a multisig, and $MOAT, are in [docs/runbook.md](../docs/runbook.md) section 3.

## Updating and operating

```bash
cd /opt/moatpad && git pull && docker compose up -d --build   # deploy the latest commit
docker compose ps                                             # status and health
docker compose logs -f --tail=100 api                         # logs of one service
docker compose restart web                                    # restart one service
docker compose exec postgres pg_dump -U holdfast holdfast > backup-$(date +%F).sql
```

`NEXT_PUBLIC_*` values are baked into the web bundle, so changing them needs `docker compose up -d --build web`.
