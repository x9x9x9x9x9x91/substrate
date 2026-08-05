#!/usr/bin/env bash
# verify-quarantine.sh — prove a DMG survives the path a real download takes.
#
# The dev machine is the worst possible test environment for this: every binary
# here has already been assessed by Gatekeeper, and `scp`/AirDrop/`cp` do not
# set the quarantine attribute a browser download does. Quarantine was the
# single decisive variable in the first-run failure — the same bundle
# booted fine unquarantined and hung forever at `_dyld_start` with it. So an
# artifact that has not been through THIS script has not been through the code
# path that actually broke.
#
#   bash scripts/verify-quarantine.sh <path-to-dmg>
#
# What it does: copies the DMG to a scratch path, marks it quarantined exactly
# as Safari would, mounts it, copies the app out (as a user dragging it to
# /Applications does — the copy inherits quarantine), asks Gatekeeper about it,
# then LAUNCHES it against a scratch vault and waits for the app to write its
# startup line. Reaching `main` is the claim; the log line is the evidence.
#
# Touches only /tmp. Never installs to /Applications, never touches ~/Vault,
# and only ever signals the one pid it spawned itself.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
# shellcheck source=scripts/lib/checkout-guard.sh
. "$ROOT/scripts/lib/checkout-guard.sh"
guard_checkout_freshness verify-quarantine.sh

DMG_SRC=${1:-}
[ -n "$DMG_SRC" ] || { echo "usage: bash scripts/verify-quarantine.sh <path-to-dmg>" >&2; exit 2; }
[ -f "$DMG_SRC" ] || { echo "verify-quarantine: no such DMG: $DMG_SRC" >&2; exit 2; }

RUN="$$"
SCRATCH="/tmp/substrate-quarantine-$RUN"
VAULT="$SCRATCH/vault"
LOGDIR="$SCRATCH/logs"
MOUNT="$SCRATCH/mnt"
DMG="$SCRATCH/download/$(basename "$DMG_SRC")"
APP="$SCRATCH/app/Substrate.app"
LAUNCH_TIMEOUT=${QUARANTINE_LAUNCH_TIMEOUT:-45}

APP_PID=""
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die()  { printf '\nverify-quarantine: %s\n' "$*" >&2; exit 1; }

cleanup() {
  # Only ever the pid this script started — never a name match (a `pkill
  # Substrate` here would take out the user's real running app).
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    kill "$APP_PID" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$APP_PID" 2>/dev/null
  fi
  [ -d "$MOUNT" ] && hdiutil detach "$MOUNT" -quiet 2>/dev/null
  [ "${QUARANTINE_KEEP:-0}" = "1" ] || rm -rf "$SCRATCH"
}
trap cleanup EXIT

mkdir -p "$SCRATCH/download" "$SCRATCH/app" "$VAULT" "$LOGDIR" "$MOUNT"

# ---------------------------------------------------------------------------
# 1. Become a downloaded file. The quarantine value is Safari's shape:
#    flags;hex-timestamp;agent;uuid. The flag word matters (0083 = downloaded,
#    not yet assessed); the rest is provenance metadata.
# ---------------------------------------------------------------------------
step "Simulate download"
cp "$DMG_SRC" "$DMG"
xattr -w com.apple.quarantine \
  "0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)" "$DMG" \
  || die "could not set the quarantine attribute"
xattr -p com.apple.quarantine "$DMG" | sed 's/^/  quarantine: /'

# ---------------------------------------------------------------------------
# 2. Gatekeeper's verdict on the DMG itself, quarantined. This is what the
#    user's Mac evaluates when they double-click the download.
# ---------------------------------------------------------------------------
step "Gatekeeper — quarantined DMG"
DMG_SPCTL=$(spctl -a -t open --context context:primary-signature -vv "$DMG" 2>&1)
echo "$DMG_SPCTL" | sed 's/^/  /'
echo "$DMG_SPCTL" | grep -q "accepted" || die "spctl rejected the quarantined DMG"
echo "$DMG_SPCTL" | grep -q "source=Notarized Developer ID" \
  || die "quarantined DMG is accepted, but not as Notarized Developer ID"

# ---------------------------------------------------------------------------
# 3. Mount and copy the app out — the drag-to-Applications step. The copy
#    inherits the quarantine flag from the mounted image, which is the state
#    that hung before signing.
# ---------------------------------------------------------------------------
step "Mount and extract"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT" -quiet \
  || die "could not mount the DMG"
[ -d "$MOUNT/Substrate.app" ] || die "no Substrate.app inside the DMG"
cp -R "$MOUNT/Substrate.app" "$APP" || die "could not copy the app out of the DMG"
hdiutil detach "$MOUNT" -quiet || echo "  (detach warning — continuing)"

echo -n "  extracted app quarantine: "
xattr -p com.apple.quarantine "$APP" 2>/dev/null || echo "(none — inherited clean)"

step "Gatekeeper — extracted app"
APP_SPCTL=$(spctl -a -t exec -vv "$APP" 2>&1)
echo "$APP_SPCTL" | sed 's/^/  /'
echo "$APP_SPCTL" | grep -q "accepted" || die "spctl rejected the extracted app"
echo "$APP_SPCTL" | grep -q "source=Notarized Developer ID" \
  || die "extracted app is accepted, but not as Notarized Developer ID"

step "Stapled ticket (offline check)"
xcrun stapler validate "$APP" 2>&1 | sed 's/^/  /' \
  || echo "  note: app itself is not stapled — it is covered by the DMG's ticket"

# ---------------------------------------------------------------------------
# 4. The actual claim: it reaches `main`. spctl approving is policy; running is
#    fact. The failure this whole check exists to fix produced a process that
#    existed, held 32 KB RSS, and never executed a line of our code — an
#    assessment gate would have called that a pass. So: launch it, and wait for
#    the app's own startup line to appear in a log dir it has to reach `main`
#    to create.
# ---------------------------------------------------------------------------
step "Launch (quarantined, scratch vault)"
LOG="$LOGDIR/substrate.log"
VAULT_DIR="$VAULT" SUBSTRATE_LOG_DIR="$LOGDIR" \
  "$APP/Contents/MacOS/Substrate" >"$SCRATCH/stdout.log" 2>&1 &
APP_PID=$!
echo "  pid $APP_PID, vault $VAULT"

STARTED=""
for _ in $(seq 1 $((LAUNCH_TIMEOUT * 2))); do
  if [ -f "$LOG" ] && grep -q "substrate .* starting" "$LOG"; then STARTED=1; break; fi
  # A dead process will never write it; stop waiting out the full timeout.
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep 0.5
done

if [ -z "$STARTED" ]; then
  echo "  --- stdout/stderr ---"; sed 's/^/  /' "$SCRATCH/stdout.log" 2>/dev/null
  if kill -0 "$APP_PID" 2>/dev/null; then
    # The F1 signature: alive, but never got past dyld.
    echo "  process is ALIVE but never logged a startup line after ${LAUNCH_TIMEOUT}s"
    sample "$APP_PID" 1 -f "$SCRATCH/sample.txt" >/dev/null 2>&1 \
      && grep -m5 "_dyld_start\|dyld" "$SCRATCH/sample.txt" | sed 's/^/  /'
    die "app did not reach main — the SUB-459 F1 hang signature"
  fi
  die "app exited before logging a startup line"
fi

grep -m1 "starting" "$LOG" | sed 's/^/  /'
echo "  vault line: $(grep -m1 "^.*vault:" "$LOG" | sed 's/^ *//')"

step "PASS"
echo "  A quarantined download mounts, extracts, passes Gatekeeper as"
echo "  Notarized Developer ID, and reaches main."
