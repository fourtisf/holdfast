#!/usr/bin/env bash
# First-time setup on a server, run from the repository root:
#   bash deploy/init.sh moatpad.fun            # API on api.moatpad.fun
#   bash deploy/init.sh moatpad.fun api.example.com
#
# Writes .env from .env.example with production URLs and fresh secrets, and creates the keeper and
# launcher keypairs in keys/. Both steps skip what already exists, so re-running is safe. Back up .env
# and keys/ off the server: DEPOSIT_MASTER_SECRET derives every launch deposit address.
set -euo pipefail

SITE="${1:?usage: bash deploy/init.sh <site-domain> [api-domain]}"
API="${2:-api.$SITE}"
ENV_FILE=.env
NODE_IMAGE=node:22-bookworm-slim

[ -f .env.example ] && [ -f deploy/docker-compose.prod.yml ] || { echo "run this from the repository root" >&2; exit 1; }

set_var() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}

if [ -f "$ENV_FILE" ]; then
  echo ".env exists, leaving it as is"
else
  cp .env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  pg_password="$(openssl rand -hex 24)"
  printf '\n# ---- deployment (deploy/init.sh) ------------------------------------------\n' >> "$ENV_FILE"
  set_var COMPOSE_FILE "docker-compose.yml:deploy/docker-compose.prod.yml"
  set_var SITE_DOMAIN "$SITE"
  set_var API_DOMAIN "$API"
  set_var POSTGRES_PASSWORD "$pg_password"
  set_var DATABASE_URL "postgres://holdfast:$pg_password@postgres:5432/holdfast"
  set_var DEPOSIT_MASTER_SECRET "$(openssl rand -hex 32)"
  set_var ADMIN_TOKEN "$(openssl rand -hex 24)"
  set_var REPORT_SALT "$(openssl rand -hex 16)"
  set_var PUBLIC_METADATA_BASE_URL "https://$API/metadata"
  set_var PUBLIC_SITE_URL "https://$SITE"
  set_var CORS_ORIGIN "https://$SITE"
  set_var WEB_URL "https://$SITE"
  set_var NEXT_PUBLIC_API_URL "https://$API"
  set_var NEXT_PUBLIC_WS_URL "wss://$API/ws"
  set_var NEXT_PUBLIC_SITE_URL "https://$SITE"
  echo "wrote .env for https://$SITE (API https://$API, cluster: devnet)"
fi

# The services run as the image's `node` user (uid 1000) and mount keys/ read-only.
mkdir -p keys
if [ ! -f keys/keeper.json ] || [ ! -f keys/launcher.json ]; then
  docker pull -q "$NODE_IMAGE" > /dev/null
fi
for name in keeper launcher; do
  file="keys/$name.json"
  if [ -f "$file" ]; then
    echo "$file exists, leaving it as is"
    continue
  fi
  docker run --rm -v "$PWD/deploy:/d:ro" "$NODE_IMAGE" node /d/keygen.mjs > "$file.tmp" 2> "keys/$name.address"
  mv "$file.tmp" "$file"
  chown 1000:1000 "$file"
  chmod 600 "$file"
  echo "created $file: $(cat "keys/$name.address")"
done

launcher="$(cat keys/launcher.address 2>/dev/null || true)"
if [ -n "$launcher" ] && grep -q "^LAUNCHER_ADDRESS=$" "$ENV_FILE"; then
  set_var LAUNCHER_ADDRESS "$launcher"
fi

cat <<NEXT

Next:
  1. DNS: A records for $SITE, www.$SITE and $API pointing at this server.
  2. docker compose up -d --build postgres migrate api indexer web caddy
  3. Open https://$SITE and https://$API/healthz
Keeper address:   $(cat keys/keeper.address 2>/dev/null || echo "?")
Launcher address: ${launcher:-?}
The keeper, payout, launcher and notifier services need the program deployed and initialized with these
two addresses first (docs/runbook.md, section 1).
NEXT
