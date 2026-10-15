#!/usr/bin/env bash
# Deploys and sets up the vault program from the server, run from the repository root after deploy/init.sh:
#
#   bash deploy/program.sh keys          install the Solana CLI, create the deployer and program keypairs
#   bash deploy/program.sh deploy        deploy deploy/program/holdfast_vault.so, or upgrade it (checks the hash,
#                                        the address it was built for and the deployer's balance)
#   bash deploy/program.sh init          create the on-chain Config with the keeper and launcher from keys/, and give
#                                        the keeper its starting 0.02 SOL from the deployer
#   bash deploy/program.sh alt           create the launcher's lookup table (paid by the deployer) and put it in .env
#   bash deploy/program.sh admin <cmd>   any command of apps/keeper/src/admin.ts, signed by the deployer
#   bash deploy/program.sh revenue <wallet>   the keeper becomes the platform treasury: the 10% share pays for its
#                                        transactions and the rest is forwarded to <wallet>
#   bash deploy/program.sh launches open|pause
#   bash deploy/program.sh status        addresses and balances
#
# Only the deployer needs SOL: about 4.75, the program's rent (it stays in the program account) plus a little for
# the lookup table and the keeper's start. The launcher runs empty, since every launch reimburses it in the same
# transaction, and the keeper then lives off the platform share (`revenue`). The deployer is also the program's
# upgrade authority and the Config admin until both move to a multisig (docs/runbook.md, section 3). Its keypair
# and the program keypair live in $ADMIN_DIR (default ~/moatpad-admin), outside the repository and every
# container. Back that folder up offline, and never paste or screenshot the files in it.
set -euo pipefail

SOLANA_VERSION=2.3.13
ADMIN_DIR="${ADMIN_DIR:-$HOME/moatpad-admin}"
DEPLOYER="$ADMIN_DIR/deployer.json"
PROGRAM="$ADMIN_DIR/program.json"
SO=deploy/program/holdfast_vault.so
PRIORITY="${PRIORITY:-20000}" # micro-lamports per compute unit on the deploy's write transactions
KEEPER_SEED_LAMPORTS=20000000 # the keeper's start; the platform share refills it
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

[ -f .env ] && [ -f deploy/docker-compose.prod.yml ] || { echo "run this from the repository root, after deploy/init.sh" >&2; exit 1; }

env_get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
set_var() {
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
need() { [ -f "$1" ] || { echo "$1 is missing: run \`bash deploy/program.sh keys\` first" >&2; exit 1; }; }
sol_amount() { awk -v l="$1" 'BEGIN { printf "%.4f", l / 1e9 }'; }
RPC="$(env_get SOLANA_RPC_URL)"
sol() { solana --url "$RPC" --keypair "$DEPLOYER" "$@"; }
admin_cli() {
  docker compose run --rm --no-deps --user root -v "$ADMIN_DIR:/admin:ro" -w /app/apps/keeper keeper \
    tsx src/admin.ts "$@" --rpc "$RPC" --signer /admin/deployer.json
}

case "${1:-}" in
  keys)
    if ! command -v solana > /dev/null; then
      sh -c "$(curl -sSfL "https://release.anza.xyz/v$SOLANA_VERSION/install")"
    fi
    mkdir -p "$ADMIN_DIR"
    chmod 700 "$ADMIN_DIR"
    for name in deployer program; do
      file="$ADMIN_DIR/$name.json"
      if [ -f "$file" ]; then
        echo "$file exists, leaving it as is"
      else
        solana-keygen new --no-bip39-passphrase --silent --outfile "$file" > /dev/null
        chmod 600 "$file"
      fi
    done
    # Mainnet parameters (decisions #7: an ATH must hold for 5 minutes); everything else is the default.
    [ -f "$ADMIN_DIR/params.json" ] || echo '{ "athConfirmSecs": 300 }' > "$ADMIN_DIR/params.json"
    cat <<NEXT

Deployer (pays the deploy, upgrade authority, admin): $(solana address -k "$DEPLOYER")
Program address (gets built into the program):       $(solana address -k "$PROGRAM")

Back up $ADMIN_DIR off this server. Next: send the program address so the program is built for it,
send 4.75 SOL to the deployer (no other wallet needs SOL), then git pull and run: bash deploy/program.sh deploy
NEXT
    ;;

  deploy)
    need "$DEPLOYER"
    need "$PROGRAM"
    [ -f "$SO" ] || { echo "$SO is not in the repository yet: send the program address, then git pull" >&2; exit 1; }
    (cd deploy/program && sha256sum --check --quiet holdfast_vault.so.sha256) || { echo "$SO does not match its hash" >&2; exit 1; }
    program_id="$(solana address -k "$PROGRAM")"
    built_for="$(cat deploy/program/program-id)"
    [ "$built_for" = "$program_id" ] || { echo "$SO was built for $built_for, but $PROGRAM is $program_id" >&2; exit 1; }
    # Rent for the program data account (the buffer it is written to first is refunded), plus fees, the
    # lookup table and the keeper's start.
    size="$(stat -c %s "$SO")"
    needed=$(((size + 45 + 128) * 6960 + 50000000))
    balance="$(sol balance --lamports | awk '{ print $1 }')"
    if [ "$balance" -lt "$needed" ]; then
      echo "the deployer $(solana address -k "$DEPLOYER") has $(sol_amount "$balance") SOL and needs about $(sol_amount "$needed") SOL" >&2
      exit 1
    fi
    # The public endpoint rate-limits sends, so writes go straight to the leaders there; a paid RPC takes them.
    send=(--use-rpc)
    case "$RPC" in *api.mainnet-beta.solana.com* | *api.devnet.solana.com*) send=() ;; esac
    echo "deploying $program_id ($((size / 1024)) KB) to $(env_get SOLANA_CLUSTER) from $(solana address -k "$DEPLOYER")"
    if ! sol program deploy "$SO" --program-id "$PROGRAM" --with-compute-unit-price "$PRIORITY" --max-sign-attempts 50 ${send[@]+"${send[@]}"}; then
      echo "the deploy did not finish; run this command again (the SOL in the unfinished buffer comes back after it succeeds)" >&2
      exit 1
    fi
    sol program close --buffers > /dev/null 2>&1 || true
    set_var HOLDFAST_PROGRAM_ID "$program_id"
    sol program show "$program_id"
    echo "HOLDFAST_PROGRAM_ID=$program_id is in .env. Next: bash deploy/program.sh init"
    ;;

  init)
    need "$DEPLOYER"
    keeper="$(cat keys/keeper.address)"
    launcher="$(cat keys/launcher.address)"
    docker compose build keeper
    admin_cli init "$keeper" "$launcher" /admin/params.json
    admin_cli show
    # Running costs: collect only after trading, refill from the platform share (decisions #29, #30).
    set_var KEEPER_COLLECT_EVERY_SECS 600
    set_var KEEPER_MIN_BALANCE_LAMPORTS 5000000
    keeper_balance="$(solana balance --url "$RPC" --lamports "$keeper" | awk '{ print $1 }')"
    if [ "$keeper_balance" -lt "$KEEPER_SEED_LAMPORTS" ]; then
      sol transfer --allow-unfunded-recipient "$keeper" "$(sol_amount $((KEEPER_SEED_LAMPORTS - keeper_balance)))"
    fi
    echo "keeper $keeper: $(solana balance --url "$RPC" "$keeper")"
    ;;

  alt)
    need "$DEPLOYER"
    docker compose build launcher
    out="$(docker compose run --rm --no-deps -T --user root -v "$ADMIN_DIR:/admin:ro" -e ALT_PAYER_KEYPAIR=/admin/deployer.json \
      -w /app/apps/launcher launcher tsx src/cli/alt.ts create)"
    echo "$out"
    table="$(printf '%s\n' "$out" | sed -n 's/^LAUNCHER_LOOKUP_TABLE=//p' | tail -1)"
    [ -n "$table" ] || { echo "no lookup table address in the output" >&2; exit 1; }
    set_var LAUNCHER_LOOKUP_TABLE "$table"
    echo "LAUNCHER_LOOKUP_TABLE=$table is in .env"
    ;;

  admin)
    need "$DEPLOYER"
    shift
    admin_cli "$@"
    ;;

  revenue)
    need "$DEPLOYER"
    wallet="${2:?usage: bash deploy/program.sh revenue <your wallet address>}"
    [[ "$wallet" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]] || { echo "not a wallet address: $wallet" >&2; exit 1; }
    admin_cli set-platform-treasury "$(cat keys/keeper.address)"
    set_var KEEPER_PROFIT_WALLET "$wallet"
    docker compose up -d keeper
    reserve="$(env_get KEEPER_RESERVE_LAMPORTS)"
    echo "platform treasury: the keeper; it keeps $(sol_amount "${reserve:-300000000}") SOL for fees and forwards the rest to $wallet"
    ;;

  launches)
    case "${2:-}" in
      open) set_var LAUNCHES_PAUSED false ;;
      pause) set_var LAUNCHES_PAUSED true ;;
      *) echo "usage: bash deploy/program.sh launches open|pause" >&2; exit 1 ;;
    esac
    docker compose up -d api
    echo "LAUNCHES_PAUSED=$(env_get LAUNCHES_PAUSED)"
    ;;

  status)
    program_id="$(env_get HOLDFAST_PROGRAM_ID)"
    echo "cluster:  $(env_get SOLANA_CLUSTER) ($RPC)"
    echo "program:  $program_id"
    [ -f "$DEPLOYER" ] && echo "deployer: $(solana address -k "$DEPLOYER")  $(solana balance --url "$RPC" "$(solana address -k "$DEPLOYER")")"
    for name in keeper launcher; do
      address="$(cat "keys/$name.address")"
      echo "$name: $address  $(solana balance --url "$RPC" "$address")"
    done
    solana program show --url "$RPC" "$program_id" 2> /dev/null || echo "the program is not deployed at $program_id"
    echo "LAUNCHES_PAUSED=$(env_get LAUNCHES_PAUSED)  LAUNCHER_LOOKUP_TABLE=$(env_get LAUNCHER_LOOKUP_TABLE)"
    ;;

  *)
    sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
