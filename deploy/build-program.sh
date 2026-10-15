#!/usr/bin/env bash
# Builds the vault program for a program address and puts the binary where deploy/program.sh expects it.
# Run from the repository root on a machine with the toolchain from the README (Anchor 0.32.1, Agave 2.3.13):
#
#   bash deploy/build-program.sh <PROGRAM_ADDRESS>     # the address `bash deploy/program.sh keys` printed
#
# It writes the address into the program (declare_id!) and every default that names it, rebuilds, syncs the
# IDL and writes deploy/program/{holdfast_vault.so, holdfast_vault.so.sha256, program-id}. Commit the result;
# the server checks both the hash and the address before deploying.
set -euo pipefail

NEW="${1:?usage: bash deploy/build-program.sh <PROGRAM_ADDRESS>}"
[[ "$NEW" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]] || { echo "not a base58 address: $NEW" >&2; exit 1; }
[ -f Anchor.toml ] || { echo "run this from the repository root" >&2; exit 1; }

OLD="$(sed -n 's/^declare_id!("\(.*\)");$/\1/p' programs/holdfast-vault/src/lib.rs)"
if [ "$OLD" != "$NEW" ]; then
  git grep -l "$OLD" -- . ':!deploy/program' | xargs sed -i "s/$OLD/$NEW/g"
fi
grep -q '^\[programs.mainnet\]' Anchor.toml || printf '\n[programs.mainnet]\nholdfast_vault = "%s"\n' "$NEW" >> Anchor.toml

anchor build -p holdfast_vault
pnpm --filter @holdfast/chain idl:sync

mkdir -p deploy/program
cp target/deploy/holdfast_vault.so deploy/program/
(cd deploy/program && sha256sum holdfast_vault.so > holdfast_vault.so.sha256)
echo "$NEW" > deploy/program/program-id
echo "built deploy/program/holdfast_vault.so for $NEW: $(cut -d' ' -f1 deploy/program/holdfast_vault.so.sha256)"
