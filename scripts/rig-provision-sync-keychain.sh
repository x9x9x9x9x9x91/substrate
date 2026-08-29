#!/usr/bin/env bash
# One-time rig setup for the unattended auto-sync verification run.
#
# `scripts/autosync-verify.sh` boots the real app, and the real app stores its
# sync credentials in the user's default keychain. Over ssh that keychain is
# locked, which is why the run was a desktop ritual: it could tell you sync had
# regressed only if a human sat down and asked it. This script is what makes it
# askable from a gate — it creates a keychain that exists for that run and
# nothing else, with a password this machine keeps and the checkout never sees.
#
# What it creates, once per rig:
#   ~/Library/Keychains/substrate-autosync.keychain-db   the throwaway keychain
#   ~/.config/substrate/autosync-keychain-password       its password, mode 600
#
# What it does NOT do: change this user's default keychain, or add anything to
# the search list. The verify run makes the swap itself for the length of the
# run and puts the previous default back on the way out, so a machine somebody
# is logged in at keeps the keychain it had every minute the run is not going.
#
# It also holds nothing real. The credentials that land in it are the ones the
# verify run invents against its own loopback store — a throwaway token and a
# passphrase compiled into the harness — and the run deletes them again as it
# exits. No account of anyone's is involved at any point.
#
# Usage, on the rig itself or over ssh:
#     bash scripts/rig-provision-sync-keychain.sh
#     bash scripts/rig-provision-sync-keychain.sh --force   # replace an existing one
#
# Then the run, from anywhere:
#     AUTOSYNC_KEYCHAIN="$HOME/Library/Keychains/substrate-autosync.keychain-db" \
#       bash scripts/autosync-verify.sh
#
# To undo it completely:
#     security delete-keychain ~/Library/Keychains/substrate-autosync.keychain-db
#     rm ~/.config/substrate/autosync-keychain-password
set -uo pipefail

# shellcheck source=scripts/lib/checkout-guard.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/checkout-guard.sh"
guard_checkout_freshness rig-provision-sync-keychain.sh

KEYCHAIN="${AUTOSYNC_KEYCHAIN:-$HOME/Library/Keychains/substrate-autosync.keychain-db}"
PASSWORD_FILE="${AUTOSYNC_KEYCHAIN_PASSWORD_FILE:-$HOME/.config/substrate/autosync-keychain-password}"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

fail() { printf 'rig-provision-sync-keychain: %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || fail "keychains are a macOS notion; this host is $(uname -s)."
command -v security >/dev/null || fail "no security(1) on PATH."

# The one name this script must never be pointed at. Everything below creates,
# overwrites and hands out a password, and doing any of that to the keychain
# holding a person's real credentials is not a mistake worth leaving available.
case "$KEYCHAIN" in
  *login.keychain-db|*login.keychain)
    fail "refusing to touch the login keychain. This provisions a dedicated one." ;;
esac

if [[ -f "$KEYCHAIN" && "$FORCE" != "1" ]]; then
  printf 'already provisioned: %s\n' "$KEYCHAIN"
  printf 'password file:       %s\n' "$PASSWORD_FILE"
  printf 'pass --force to replace it.\n'
  exit 0
fi

# Generated here, on the machine that will keep it, and read back from the file
# rather than carried in a variable — so it is never echoed, never in an
# argument list `ps` can read, and never inherited by anything the run spawns.
mkdir -p "$(dirname "$PASSWORD_FILE")" || fail "could not create $(dirname "$PASSWORD_FILE")"
umask 077
# `head -c 40` at the END of the pipe rather than the start of it: a head that
# stops early leaves the reader ahead of it dead of SIGPIPE, and under
# pipefail that is the status of the whole pipeline — a password written
# correctly and then reported as a failure.
# No trailing newline either: the file holds the password and nothing else, so
# a reader that does not think to strip one still gets the right bytes.
head -c 4096 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-40 | tr -d '\n' >"$PASSWORD_FILE" \
  || fail "could not write $PASSWORD_FILE"
chmod 600 "$PASSWORD_FILE" || fail "could not restrict $PASSWORD_FILE"
# An empty file would be fed to create-keychain below as an empty password,
# and an empty password is one create-keychain accepts without complaint.
[[ -s "$PASSWORD_FILE" ]] || fail "wrote an empty $PASSWORD_FILE"

security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
# `-p <password>` is how the obvious version of this line reads, and it is the
# one shape that puts the password in an argument list `ps` can read — the very
# thing the comment above says never happens (security(1)'s own help calls -p
# insecure). Given no -p, create-keychain prompts instead, and the prompt reads
# stdin when stdin is not a terminal — twice, since it asks for a confirmation
# — so the password reaches it on stdin, as it does the unlock below.
# Fed by process substitution rather than a pipe, for the same reason the unlock
# is fed by a redirect: create-keychain does not drain its stdin, so a writer
# left on the far side of a pipe can die of SIGPIPE and hand pipefail a 141 for
# a keychain that was created perfectly well.
# Its stderr goes to a file rather than to /dev/null: the prompt text lands
# there on a run that works, but so does the only diagnostic a failed run has
# ("A keychain with the same name already exists.", exit 48 — reachable
# whenever the delete-keychain above fails on a stale or wrong-owner file).
CREATE_ERR="$(mktemp "${TMPDIR:-/tmp}/autosync-create-keychain.XXXXXX")" \
  || fail "could not create a temporary file for create-keychain's output"
if ! security create-keychain "$KEYCHAIN" \
  < <(cat "$PASSWORD_FILE"; printf '\n'; cat "$PASSWORD_FILE"; printf '\n') \
  2>"$CREATE_ERR"; then
  why="$(tail -n 1 "$CREATE_ERR")"
  rm -f "$CREATE_ERR"
  fail "could not create $KEYCHAIN${why:+: $why}"
fi
rm -f "$CREATE_ERR"
# A new keychain locks itself after five minutes and on sleep; the run takes
# twenty. Bare set-keychain-settings clears both, and only works on an unlocked
# keychain — which a freshly created one is not, from a second process.
# Fed from a redirect rather than `cat ... | security`: the password still
# arrives on stdin and still never appears in an argument list `ps` can read,
# but there is no writer left holding a pipe. A reader that exits before the
# writer's first write kills `cat` with SIGPIPE, and under pipefail that 141
# becomes the status of the whole pipeline — a keychain unlocked fine and then
# reported as a failure, intermittently and only when the machine is loaded
# enough to lose the race.
security unlock-keychain "$KEYCHAIN" <"$PASSWORD_FILE" >/dev/null 2>&1 \
  || fail "created $KEYCHAIN but could not unlock it."
security set-keychain-settings "$KEYCHAIN" \
  || fail "could not clear the auto-lock timeout on $KEYCHAIN."
security lock-keychain "$KEYCHAIN" >/dev/null 2>&1 || true

printf 'provisioned: %s\n' "$KEYCHAIN"
printf 'password:    %s (mode 600, this machine only)\n' "$PASSWORD_FILE"
printf 'default keychain left as: %s\n' "$(security default-keychain -d user | tr -d ' "')"
printf '\nrun it with:\n  AUTOSYNC_KEYCHAIN=%q bash scripts/autosync-verify.sh\n' "$KEYCHAIN"
