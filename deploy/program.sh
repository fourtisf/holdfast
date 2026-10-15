#!/usr/bin/env bash
# Deploys and sets up the vault program from the server, run from the repository root after deploy/init.sh:
#
#   bash deploy/program.sh keys          install the Solana CLI, create the deployer and program keypairs
#   bash deploy/program.sh import-deployer [--show] [file]   use your own wallet as the deployer: its address,
#                                        then its private key at a hidden prompt (--show: visible while pasting, then
#                                        wiped from the screen) or from a file that is deleted after reading
#                                        (run it before or instead of creating one with `keys`)
#   bash deploy/program.sh deploy        deploy deploy/program/holdfast_vault.so, or upgrade it (checks the hash,
#                                        the address it was built for and the deployer's balance)
#   bash deploy/program.sh diagnose      explain a failed deploy: simulates its first transaction and prints the error
#   bash deploy/program.sh init          create the on-chain Config with the keeper and launcher from keys/, and give
#                                        the keeper its starting 0.02 SOL from the deployer
#   bash deploy/program.sh alt           create the launcher's lookup table (paid by the deployer) and put it in .env
#   bash deploy/program.sh admin <cmd>   any command of apps/keeper/src/admin.ts, signed by the deployer
#   bash deploy/program.sh revenue <wallet>   the keeper becomes the platform treasury: the 10% share pays for its
#                                        transactions and the rest is forwarded to <wallet>
#   bash deploy/program.sh export keeper|launcher|deployer [--file]   show a wallet's private key to import it in
#                                        Phantom (--file: write it to a text file to download over SFTP instead)
#   bash deploy/program.sh new-key keeper|launcher   replace a robot wallet (e.g. after its key was exposed); points
#                                        the on-chain Config at the new one when it is already initialized
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
# Simulates the deploy's first transaction and prints the real error (deploy/diagnose-deploy.mjs).
diagnose() {
  docker compose run --rm --no-deps -T --user root -v "$ADMIN_DIR:/admin:ro" -v "$PWD/deploy/program:/program:ro" \
    -v "$PWD/deploy/diagnose-deploy.mjs:/app/apps/keeper/diagnose-deploy.mjs:ro" -w /app/apps/keeper keeper \
    node diagnose-deploy.mjs "$RPC" /admin/deployer.json /program/holdfast_vault.so "$(solana address -k "$PROGRAM")"
}
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
make sure the deployer holds 4.75 SOL (no other wallet needs SOL), then git pull and run: bash deploy/program.sh deploy
NEXT
    ;;

  import-deployer)
    umask 077
    mkdir -p "$ADMIN_DIR"
    chmod 700 "$ADMIN_DIR"
    show=false
    file=""
    for arg in "${@:2}"; do
      case "$arg" in --show) show=true ;; *) file="$arg" ;; esac
    done
    printf 'Address of the wallet that pays and owns the program (as Phantom shows it): '
    IFS= read -r expected
    expected="$(printf '%s' "$expected" | tr -d '[:space:]')"
    if [ -n "$file" ]; then
      # From a file (e.g. uploaded over SFTP), deleted right after it is read.
      [ -f "$file" ] || { echo "$file does not exist" >&2; exit 1; }
      key="$(cat "$file")"
      shred -u "$file" 2> /dev/null || rm -f "$file"
      echo "read the key from $file and deleted the file"
    else
      printf 'Its private key (Phantom: Settings > Manage Accounts > your account > Show Private Key > Solana,\n'
      if $show; then
        printf 'then the copy button). Paste it and press Enter; the screen is cleared right after:\n'
        IFS= read -r key
        while IFS= read -r -t 0.5 more; do key+="$more"; done
        # Wipe the pasted key from the screen and the scrollback.
        printf '\033[2J\033[3J\033[H'
      else
        printf 'then the copy button). Paste it and press Enter; nothing shows while you paste: '
        IFS= read -rs key
        # A paste that wrapped over several lines arrives as several lines: take them all, so none reaches the shell.
        while IFS= read -rs -t 0.5 more; do key+="$more"; done
        echo
      fi
    fi
    # printf is a builtin: the key never shows up in the process list or the shell history.
    if ! printf '%s' "$key" | docker run --rm -i -v "$PWD/deploy:/d:ro" node:22-bookworm-slim node /d/import-key.mjs "$expected" \
      > "$DEPLOYER.tmp" 2> "$ADMIN_DIR/.address"; then
      unset key
      rm -f "$DEPLOYER.tmp"
      cat "$ADMIN_DIR/.address" >&2
      rm -f "$ADMIN_DIR/.address"
      exit 1
    fi
    unset key
    if [ -f "$DEPLOYER" ] && ! cmp -s "$DEPLOYER" "$DEPLOYER.tmp"; then
      mv "$DEPLOYER" "$ADMIN_DIR/deployer.replaced-$(date +%s).json"
      echo "the previous deployer keypair is kept next to it as deployer.replaced-*.json"
    fi
    mv "$DEPLOYER.tmp" "$DEPLOYER"
    echo "deployer: $(cat "$ADMIN_DIR/.address"), your wallet. Next: bash deploy/program.sh deploy"
    rm -f "$ADMIN_DIR/.address"
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
      echo >&2
      echo "the deploy did not finish. Checking why (nothing is sent):" >&2
      diagnose >&2 || true
      echo >&2
      echo "Run this command again once the cause is fixed. SOL left in an unfinished buffer comes back after a deploy" >&2
      echo "succeeds; ignore the 12-word phrase above, it only belongs to that temporary buffer." >&2
      exit 1
    fi
    sol program close --buffers > /dev/null 2>&1 || true
    set_var HOLDFAST_PROGRAM_ID "$program_id"
    sol program show "$program_id"
    echo "HOLDFAST_PROGRAM_ID=$program_id is in .env. Next: bash deploy/program.sh init"
    ;;

  diagnose)
    need "$DEPLOYER"
    need "$PROGRAM"
    diagnose
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

  export)
    case "${2:-}" in
      keeper | launcher) file="keys/$2.json" ;;
      deployer) file="$DEPLOYER" ;;
      *) echo "usage: bash deploy/program.sh export keeper|launcher|deployer [--file]" >&2; exit 1 ;;
    esac
    [ -f "$file" ] || { echo "$file is missing" >&2; exit 1; }
    if [ "${3:-}" = "--file" ]; then
      # For terminals that cannot copy: a text file to download over SFTP, then delete.
      umask 077
      mkdir -p "$ADMIN_DIR"
      out="$ADMIN_DIR/$2-private-key.txt"
      docker run --rm -i -v "$PWD/deploy:/d:ro" node:22-bookworm-slim node /d/export-key.mjs < "$file" > "$out"
      echo "the $2 private key ($(solana address -k "$file")) is in $out"
      echo "Download it (Termius: SFTP tab > $ADMIN_DIR), open it, copy the line into Phantom (Add account > Import"
      echo "Private Key), delete the downloaded copy, then delete this one: rm $out"
      exit 0
    fi
    echo "Private key of the $2 wallet $(solana address -k "$file"), to import in Phantom (Add account > Import"
    echo "Private Key). The server keeps its copy: the services sign with it. Make sure nobody can see this screen and"
    printf 'take no screenshot. Press Enter to show it: '
    read -r _
    docker run --rm -i -v "$PWD/deploy:/d:ro" node:22-bookworm-slim node /d/export-key.mjs < "$file"
    printf 'Press Enter when you have copied it; the screen and scrollback are cleared: '
    read -r _
    printf '\033[2J\033[3J\033[H'
    echo "the $2 private key was shown and cleared from the screen"
    ;;

  new-key)
    case "${2:-}" in
      keeper | launcher) ;;
      *) echo "usage: bash deploy/program.sh new-key keeper|launcher" >&2; exit 1 ;;
    esac
    old="$(cat "keys/$2.address" 2> /dev/null || true)"
    [ -f "keys/$2.json" ] && mv "keys/$2.json" "keys/$2.replaced-$(date +%s).json"
    docker run --rm -v "$PWD/deploy:/d:ro" node:22-bookworm-slim node /d/keygen.mjs > "keys/$2.json.tmp" 2> "keys/$2.address"
    mv "keys/$2.json.tmp" "keys/$2.json"
    chown 1000:1000 "keys/$2.json"
    chmod 600 "keys/$2.json"
    new="$(cat "keys/$2.address")"
    [ "$2" = launcher ] && set_var LAUNCHER_ADDRESS "$new"
    echo "new $2 wallet: $new (the old one is kept as keys/$2.replaced-*.json)"
    # Already initialized with the old wallet: the Config must name the new one.
    if [ -n "$old" ] && admin_cli show 2> /dev/null | grep -q "\"$2\": \"$old\""; then
      need "$DEPLOYER"
      admin_cli "set-$2" "$new"
      docker compose up -d "$2" > /dev/null
    fi
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
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
