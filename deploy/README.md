# Deploying on one server

Runs the whole stack from `docker-compose.yml` on a single Ubuntu server, behind Caddy for HTTPS:

| URL | Goes to |
|---|---|
| `https://<SITE_DOMAIN>` | web (Next.js) |
| `https://www.<SITE_DOMAIN>` | redirect to the site |
| `https://<API_DOMAIN>` | api: REST, `/ws`, `/metadata` (`/metrics` is blocked) |
| `https://<API_DOMAIN>/webhooks/helius` | indexer (Helius raw webhooks) |

Every other port is bound to 127.0.0.1; only 80 and 443 are public.

## First deployment

DNS first: A records for `@`, `www` and `api` pointing at the server. Caddy requests the certificates on its
first start and retries until the records resolve.

```bash
# as root on the server
apt-get update && apt-get -y upgrade
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443 && ufw --force enable

git clone https://github.com/fourtisf/holdfast.git /opt/moatpad
cd /opt/moatpad
bash deploy/init.sh moatpad.fun          # .env with fresh secrets + keeper/launcher keypairs
docker compose up -d --build postgres migrate api indexer web caddy
```

`deploy/init.sh` writes `.env` (production URLs, random `POSTGRES_PASSWORD`, `DEPOSIT_MASTER_SECRET`,
`ADMIN_TOKEN`, `REPORT_SALT`, and `COMPOSE_FILE` so plain `docker compose` also loads
`deploy/docker-compose.prod.yml`) and creates `keys/keeper.json` and `keys/launcher.json`. It never overwrites
either. Copy `.env` and `keys/` somewhere safe off the server: `DEPOSIT_MASTER_SECRET` derives every launch
deposit address.

The cluster stays devnet until you change `SOLANA_*` and `NEXT_PUBLIC_SOLANA_*` in `.env` (then rebuild web).

## The on-chain services

`keeper`, `payout`, `launcher` and `notifier` need the program deployed and initialized with the keeper and
launcher addresses that `init.sh` printed (`keys/*.address`), plus `TELEGRAM_BOT_TOKEN` for the notifier. Follow
[docs/runbook.md](../docs/runbook.md) section 1, fund the two wallets, then:

```bash
docker compose up -d keeper payout launcher notifier
```

Do not announce the site before this: until the launcher runs, launch deposits are not processed.

## Updating and operating

```bash
cd /opt/moatpad && git pull && docker compose up -d --build   # deploy the latest commit
docker compose ps                                             # status and health
docker compose logs -f --tail=100 api                         # logs of one service
docker compose restart web                                    # restart one service
docker compose exec postgres pg_dump -U holdfast holdfast > backup-$(date +%F).sql
```

`NEXT_PUBLIC_*` values are baked into the web bundle, so changing them needs `docker compose up -d --build web`.
