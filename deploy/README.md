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

## The on-chain services

`keeper`, `payout`, `launcher` and `notifier` need the program deployed and initialized with the keeper and
launcher addresses that `init.sh` printed (`keys/*.address`), plus `TELEGRAM_BOT_TOKEN` for the notifier. Follow
[docs/runbook.md](../docs/runbook.md) section 1, fund the two wallets, then:

```bash
docker compose up -d keeper payout launcher notifier
```

Then open launches: set `LAUNCHES_PAUSED=false` in `.env` and `docker compose up -d api`.

## Updating and operating

```bash
cd /opt/moatpad && git pull && docker compose up -d --build   # deploy the latest commit
docker compose ps                                             # status and health
docker compose logs -f --tail=100 api                         # logs of one service
docker compose restart web                                    # restart one service
docker compose exec postgres pg_dump -U holdfast holdfast > backup-$(date +%F).sql
```

`NEXT_PUBLIC_*` values are baked into the web bundle, so changing them needs `docker compose up -d --build web`.
