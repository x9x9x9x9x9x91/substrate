#!/usr/bin/env bash
# Auto-sync verification lane — docs/autosync-verify.md.
#
# The scheduler has unit tests over a fake clock and an e2e spec over the mock
# backend; the hosted transport has tests with no app at all. Nothing joined
# them. This script does: it runs the REAL app against a REAL hosted store,
# with a REAL second device on the other side, and then asserts from OUTSIDE
# the app — the driver's verdict is necessary, the store and the second
# device's disk are the proof.
#
# What it proves, in the order the driver runs it:
#   1  a fresh boot engages the auto lane unaided and adopts the other device's
#      change
#   2  a single edit, left alone, pushes itself once the vault settles — and
#      the second device can read it back off the remote
#   3  a window focus pulls a change made elsewhere
#   4  so does the background interval, with no trigger of any kind
#   5  a real divergence parks and shows, never silently overwrites the local
#      edit, and can be finished from the pane
#   6  sealing a scope purges the plaintext here and from the store, and the
#      lane says so out loud instead of reading healthy
#
# It runs on the SHIPPED timings — two minutes of settle, five of pull
# interval — so the whole run takes ~20 minutes. That is the point: the
# timings are half of what "full auto" means.
#
# Usage:
#     bash scripts/autosync-verify.sh              # ~20 min, warm build
#     AUTOSYNC_KEEP=1 bash scripts/autosync-verify.sh   # keep the vaults
#
# Never aimed at a real vault: both vaults and the store are created under
# /tmp by this script, the app runs with a config dir of its own under /tmp so
# its credentials never land in the real store, the second-device helper
# refuses a vault outside /tmp, and the in-app driver refuses a root without
# "vault-smoke-autosync" in it.
# The hosted store it talks to is a loopback instance of the shipped server
# binary, started and stopped here — a shared deployment is single-tenant and
# is never a test target.
set -uo pipefail

# shellcheck source=scripts/lib/checkout-guard.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/checkout-guard.sh"
guard_checkout_freshness autosync-verify.sh

cd "$(dirname "$0")/.."
ROOT="$PWD"
if [[ -f "$ROOT/scripts/lib/cargo-target.sh" ]]; then
  # shellcheck source=scripts/lib/cargo-target.sh
  . "$ROOT/scripts/lib/cargo-target.sh"
  substrate_use_shared_cargo_target
fi

RUN="$$"
SIGNAL="/tmp/autosync-verify-$RUN"
STORE="$SIGNAL/store"
VAULT_A="/tmp/vault-smoke-autosync-a-$RUN"
VAULT_B="/tmp/vault-smoke-autosync-b-$RUN"
LOG="$SIGNAL/app.log"
SERVER_LOG="$SIGNAL/server.log"
PEER_LOG="$SIGNAL/peer.log"
RESULT="$SIGNAL/result.json"
GATE="$SIGNAL/gate"

# The app's sync credentials, health file and privacy file live in its config
# dir, and VAULT_DIR does not redirect that. Left alone, every run stores a
# sync token plus a wrapped hosted master key keyed by a /tmp vault root this
# script then deletes — in the same store the real vault's credentials live in
# — and writes its health and privacy files over the real vault's. So the app
# gets a config dir of its own, inside the run's scratch directory.
CONFIG="$SIGNAL/config"
# Must match CREDENTIAL_SERVICE in src-tauri/src/gitsync.rs.
CRED_SERVICE="com.substrate.vault-sync"
if [[ "$(uname -s)" == "Darwin" ]]; then
  # macOS keeps app config under ~/Library and sync credentials in the login
  # keychain, and XDG_CONFIG_HOME moves neither. There the isolation is
  # after-the-fact instead: the run deletes its own keychain entries on the way
  # out, and the outside assertion at the end proves the real store carries
  # nothing keyed by either of this run's vaults.
  REAL_CONFIG="$HOME/Library/Application Support/com.example.substrate"
else
  REAL_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/com.example.substrate"
fi

PORT=${AUTOSYNC_PORT:-8791}
DEV_PORT=${AUTOSYNC_DEV_PORT:-1452}
TOKEN=${AUTOSYNC_TOKEN:-harness-token-0123456789}
PASSPHRASE=${AUTOSYNC_PASSPHRASE:-harness passphrase 1275}
BOOT_TIMEOUT=${AUTOSYNC_BOOT_TIMEOUT:-1200}
# Above the driver's own worst case, deliberately. The per-leg bounds sum to
# roughly 4900s (780 settle push + 780 post-seal refusal + 720 waiting for the
# local commit + 400 interval + 200 focus + 180 divergence pull + the shorter
# legs and gate deadlines). A bound below that sum kills a slow-but-healthy run
# with a generic "did not finish" instead of letting the leg that stalled say
# so itself.
RUN_TIMEOUT=${AUTOSYNC_RUN_TIMEOUT:-5400}

# Must match VERIFY_MARKERS in src/lib/autosyncverify.ts.
MARK_SETTLE="autosync-settle-marker"
MARK_SEALED="autosync-sealed-marker"
MARK_LOCAL="autosync-local-edit-marker"

APP_PID=""
SERVER_PID=""
XVFB_PID=""
fail() { printf '\nAUTOSYNC-VERIFY FAIL: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }

stop() {  # only ever processes this script started
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.25; done
  kill -KILL -"$pid" 2>/dev/null || true
}

# Whatever the app stored under this run's throwaway roots, gone — the config
# dir above covers it wherever the credentials are a file, this covers the one
# platform where they are not. Prefix-guarded, so it can only ever name a root
# this script created.
forget_credentials() {
  [[ "$(uname -s)" == "Darwin" ]] || return 0
  command -v security >/dev/null || return 0
  local root
  for root in "$VAULT_A" "$VAULT_B"; do
    [[ "$root" == /tmp/vault-smoke-autosync-* ]] || continue
    security delete-generic-password -s "$CRED_SERVICE" -a "$root" >/dev/null 2>&1 || true
    security delete-generic-password -s "$CRED_SERVICE" -a "#hosted-master-key:$root" \
      >/dev/null 2>&1 || true
  done
}

cleanup() {
  local rc=$?
  stop "$APP_PID"
  stop "$SERVER_PID"
  stop "$XVFB_PID"
  forget_credentials
  if [[ "${AUTOSYNC_KEEP:-0}" == "1" ]]; then
    printf '\nkept: vaults %s / %s, signals %s\n' "$VAULT_A" "$VAULT_B" "$SIGNAL"
  else
    [[ "$VAULT_A" == /tmp/vault-smoke-autosync-a-* ]] && rm -rf "$VAULT_A"
    [[ "$VAULT_B" == /tmp/vault-smoke-autosync-b-* ]] && rm -rf "$VAULT_B"
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

printf 'substrate auto-sync verification (run %s)\n' "$RUN"

# ---------------------------------------------------------------- preflight
command -v node >/dev/null || fail "node not on PATH"
command -v cargo >/dev/null || fail "cargo not on PATH"
[[ -d node_modules ]] || fail "no node_modules — run npm ci"
lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && fail "port $PORT is busy (AUTOSYNC_PORT=<free port>)"
lsof -nP -iTCP:$DEV_PORT -sTCP:LISTEN >/dev/null 2>&1 && fail "dev port $DEV_PORT is busy (AUTOSYNC_DEV_PORT=<free port>)"
mkdir -p "$STORE" || fail "could not create $STORE"
mkdir -p "$CONFIG" || fail "could not create $CONFIG"

# ------------------------------------------------------------------ vaults
cp -R examples/vault "$VAULT_A" || fail "could not seed $VAULT_A"
mkdir -p "$VAULT_B" || fail "could not create $VAULT_B"
note "vault A (the app) $VAULT_A / vault B (the second device) $VAULT_B"

# --------------------------------------------------- the hosted sync server
# The shipped binary, on loopback, with a storage root this script owns.
note "building the hosted sync server …"
cargo build --release --manifest-path hosted-sync-server/Cargo.toml >"$SERVER_LOG" 2>&1 \
  || fail "server build failed — tail of $SERVER_LOG:
$(tail -20 "$SERVER_LOG")"
SERVER_BIN=$(cargo metadata --format-version 1 --no-deps --manifest-path hosted-sync-server/Cargo.toml \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).target_directory))')/release/substrate-hosted-sync-server
[[ -x "$SERVER_BIN" ]] || fail "server binary not found at $SERVER_BIN"
set -m
env SUBSTRATE_BLOB_ADDR="127.0.0.1:$PORT" SUBSTRATE_BLOB_DIR="$STORE" SUBSTRATE_BLOB_TOKEN="$TOKEN" \
  "$SERVER_BIN" >>"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
set +m
sleep 1
kill -0 "$SERVER_PID" 2>/dev/null || fail "the sync server exited at once — $(tail -5 "$SERVER_LOG")"
note "hosted store on 127.0.0.1:$PORT, objects under $STORE"

# ------------------------------------------------------- the second device
# The same client engine the app calls, driven headlessly: build the test
# binary once here, then invoke it per step so no cargo lock is held while the
# app is running.
note "building the second-device helper …"
PEER_BIN=$(cargo test --lib --no-run --manifest-path src-tauri/Cargo.toml --message-format=json 2>>"$PEER_LOG" \
  | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  let bin="";
  for (const line of d.split("\n").filter(Boolean)) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.reason === "compiler-artifact" && m.executable && m.profile?.test && m.target?.name === "substrate_lib") bin = m.executable;
  }
  console.log(bin);
});')
[[ -x "$PEER_BIN" ]] || fail "second-device helper not built — tail of $PEER_LOG:
$(tail -20 "$PEER_LOG")"

peer() {  # peer <action> [path] [body]
  local action="$1" path="${2:-}" body="${3:-}"
  env SUBSTRATE_PEER_ACTION="$action" \
      SUBSTRATE_PEER_VAULT="$VAULT_B" \
      SUBSTRATE_PEER_CREDS="$SIGNAL/peer-credentials.json" \
      SUBSTRATE_PEER_URL="blob+http://127.0.0.1:$PORT" \
      SUBSTRATE_PEER_TOKEN="$TOKEN" \
      SUBSTRATE_PEER_PASSPHRASE="$PASSPHRASE" \
      SUBSTRATE_PEER_PATH="$path" \
      SUBSTRATE_PEER_BODY="$body" \
      "$PEER_BIN" --ignored --exact gitsync::autosync_peer::peer_action --nocapture >>"$PEER_LOG" 2>&1
  local rc=$?
  tail -3 "$PEER_LOG" | grep '^PEER' | sed 's/^/    /'
  return $rc
}

# --------------------------------------------------------------- launch app
# A headless display when there is none: the app is a real GUI process either
# way, and the scheduler under test does not care what it is drawn on.
if [[ -z "${DISPLAY:-}" ]] && command -v Xvfb >/dev/null; then
  set -m
  Xvfb :99 -screen 0 1600x1200x24 >"$SIGNAL/xvfb.log" 2>&1 &
  XVFB_PID=$!
  set +m
  export DISPLAY=:99
  export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
  sleep 1
  note "headless display :99"
fi

note "launching the real app (VAULT_DIR=$VAULT_A, dev port $DEV_PORT) …"
set -m
env VAULT_DIR="$VAULT_A" \
    XDG_CONFIG_HOME="$CONFIG" \
    SUBSTRATE_SMOKE=1 \
    SUBSTRATE_SMOKE_DIR="$SIGNAL" \
    VITE_SUBSTRATE_AUTOSYNC_VERIFY=1 \
    VITE_AUTOSYNC_URL="blob+http://127.0.0.1:$PORT" \
    VITE_AUTOSYNC_TOKEN="$TOKEN" \
    VITE_AUTOSYNC_PASSPHRASE="$PASSPHRASE" \
    SUBSTRATE_DEV_PORT="$DEV_PORT" \
    npm run tauri dev -- --no-watch \
      --config "{\"build\":{\"devUrl\":\"http://localhost:$DEV_PORT\"}}" >"$LOG" 2>&1 &
APP_PID=$!
set +m

# ------------------------------------------------------------- the gate loop
# The driver asks for outside work by naming a step; this answers by writing
# the answer into vault A as a note, which is the only channel the driver
# reads. Everything here happens BEHIND the app's back, the way a second
# device and a second person do.
receipt() {  # receipt <gate> <payload>
  mkdir -p "$VAULT_A/Harness"
  printf -- '---\ntype: note\n---\n\n%s\n' "$2" >"$VAULT_A/Harness/gate-$1.md"
  note "answered gate $1: $2"
}

handle_gate() {
  case "$1" in
    seed)
      peer join || fail "the second device could not join the store"
      peer push "Peer/One.md" "$(printf -- '---\ntype: note\n---\n\npeer-seed\n')" \
        || fail "the second device could not push its first note"
      receipt seed "PEER-SEEDED"
      ;;
    check-push)
      peer pull || fail "the second device could not pull"
      if grep -q "$MARK_SETTLE" "$VAULT_B/Harness/Settle.md" 2>/dev/null; then
        receipt check-push "PEER-HAS-SETTLE-MARKER"
      else
        receipt check-push "PEER-MISSING-SETTLE-MARKER"
      fi
      ;;
    peer-two)
      peer push "Peer/Two.md" "$(printf -- '---\ntype: note\n---\n\npeer-two\n')" \
        || fail "the second device could not push Peer/Two.md"
      receipt peer-two "PEER-PUSHED-TWO"
      ;;
    peer-three)
      peer push "Peer/Three.md" "$(printf -- '---\ntype: note\n---\n\npeer-three\n')" \
        || fail "the second device could not push Peer/Three.md"
      receipt peer-three "PEER-PUSHED-THREE"
      ;;
    check-sealed)
      peer pull || true
      local why=""
      grep -rq "$MARK_SEALED" "$STORE" 2>/dev/null && why="the store holds the sealed plaintext; "
      grep -rq "$MARK_SEALED" "$VAULT_B" 2>/dev/null && why="${why}the second device holds it in the clear; "
      grep -q "$MARK_SEALED" "$VAULT_A/Sealed/Secret.md" 2>/dev/null &&
        why="${why}the note is still plaintext on this device; "
      # the purge is a history rewrite, so the working file being ciphertext
      # proves nothing on its own: the plaintext commit is what has to be gone
      [[ -n "$(git -C "$VAULT_A" log --all -S"$MARK_SEALED" --format=%h 2>/dev/null | head -1)" ]] &&
        why="${why}this device's git history still holds the plaintext; "
      if [[ -z "$why" ]]; then
        receipt check-sealed "SEALED-MARKER-ABSENT"
      else
        receipt check-sealed "SEALED-MARKER-LEAKED: $why"
      fi
      ;;
    peer-diverge)
      peer push "Harness/Settle.md" \
        "$(printf -- '---\ntype: note\n---\n\nthe other device rewrote this line\n')" \
        || fail "the second device could not push the diverging edit"
      receipt peer-diverge "PEER-DIVERGED"
      ;;
    local-committed)
      # The app commits on its own schedule — two minutes of quiet, or a ten
      # minute bound for a vault that never goes quiet. Until that lands, the
      # local edit is an uncommitted working file and the pull has nothing to
      # diverge from, so the driver waits here rather than guessing a sleep.
      # Read-only on vault A, from outside, the same way vaultwatch.log reads.
      local waited_commit=0
      until [[ -n "$(git -C "$VAULT_A" log --all -S"$MARK_LOCAL" --format=%h 2>/dev/null | head -1)" ]]; do
        sleep 5
        waited_commit=$((waited_commit + 5))
        # the main loop's outside read is paused while this gate blocks, so
        # keep it going here: this is the window it exists to explain
        if (( waited_commit % 30 == 0 )); then
          printf '%s head=%s dirty=%s\n' "$(date +%H:%M:%S)" \
            "$(git -C "$VAULT_A" log -1 --format='%h %s' 2>/dev/null)" \
            "$(git -C "$VAULT_A" status --porcelain 2>/dev/null | wc -l | tr -d ' ')" \
            >>"$SIGNAL/vaultwatch.log"
        fi
        if (( waited_commit >= 690 )); then
          receipt local-committed "LOCAL-EDIT-NEVER-COMMITTED"
          return
        fi
      done
      receipt local-committed "LOCAL-EDIT-COMMITTED after ${waited_commit}s"
      ;;
    shot)
      if command -v import >/dev/null && [[ -n "${DISPLAY:-}" ]]; then
        import -window root "$SIGNAL/divergence.png" 2>/dev/null &&
          note "screenshot: $SIGNAL/divergence.png"
      elif command -v screencapture >/dev/null; then
        screencapture -x "$SIGNAL/divergence.png" && note "screenshot: $SIGNAL/divergence.png"
      else
        note "no screenshot tool on this host — the pane state is asserted, not photographed"
      fi
      receipt shot "SHOT-TAKEN"
      ;;
    *) fail "the driver asked for an unknown step: $1" ;;
  esac
}

waited=0
booted=0
while [[ ! -f "$RESULT" ]]; do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    [[ -f "$RESULT" ]] && break
    fail "the app exited before writing a result — tail of $LOG:
$(tail -30 "$LOG")"
  fi
  if [[ -f "$GATE" ]]; then
    booted=1
    name="$(cat "$GATE")"
    rm -f "$GATE"
    handle_gate "$name"
  fi
  sleep 1
  waited=$((waited + 1))
  if (( waited % 60 == 0 )); then note "running (${waited}s) — $(tail -1 "$LOG" | cut -c1-90)"; fi
  # An outside read of the app's own history, so a long wait can be told
  # apart afterwards: a vault that never commits means the auto-snapshot
  # thread is being kept dirty, which is the same thing that would hold the
  # push debounce open. Read-only, and nothing the app can see.
  if (( waited % 30 == 0 )); then
    printf '%s head=%s dirty=%s\n' "$(date +%H:%M:%S)" \
      "$(git -C "$VAULT_A" log -1 --format='%h %s' 2>/dev/null)" \
      "$(git -C "$VAULT_A" status --porcelain 2>/dev/null | wc -l | tr -d ' ')" >>"$SIGNAL/vaultwatch.log"
  fi
  if (( booted == 0 && waited > BOOT_TIMEOUT )); then
    fail "no gate from the driver within ${BOOT_TIMEOUT}s — tail of $LOG:
$(tail -30 "$LOG")"
  fi
  # Keep both vaults: a run that ran out of time is exactly the run whose
  # disk state has to be readable afterwards, and deleting it is deleting the
  # evidence for why it stalled.
  (( waited > RUN_TIMEOUT )) && { AUTOSYNC_KEEP=1; fail "the run did not finish within ${RUN_TIMEOUT}s (vaults kept) — tail of $LOG:
$(tail -30 "$LOG")"; }
done

for _ in $(seq 1 40); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 0.25; done

# ------------------------------------------------------------ driver report
printf '\ndriver legs:\n'
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const l of r.legs) console.log(`  ${l.pass ? "PASS" : "FAIL"} ${l.leg} (${Math.round(l.ms/1000)}s) — ${l.detail}`);
console.log(`\n  driver verdict: ${r.pass ? "pass" : "FAIL"} in ${Math.round(r.ms/1000)}s over ${r.legs.length} leg(s)`);
if (r.fatal) console.log(`  fatal: ${r.fatal}`);
process.exit(r.pass ? 0 : 1);
' "$RESULT" || { AUTOSYNC_KEEP=1; fail "the in-app driver reported a failure (see above; logs in $SIGNAL)"; }

# ------------------------------------------------- outside disk assertions
# Everything above is the app's own word. These are not.
printf '\noutside assertions:\n'
check() { local what="$1"; shift; if "$@"; then note "ok   $what"; else fail "$what"; fi; }
check "the store never saw the settle marker in the clear" \
  bash -c "! grep -rq '$MARK_SETTLE' '$STORE'"
check "the store never saw the sealed marker in the clear" \
  bash -c "! grep -rq '$MARK_SEALED' '$STORE'"
check "the store never saw the local edit in the clear" \
  bash -c "! grep -rq '$MARK_LOCAL' '$STORE'"
# Read from history, not from the working file: the divergence leg has the
# second device deliberately rewrite this very note, so by the end of the run
# the marker is gone from disk on purpose. What must still be true is that it
# arrived at all, and a commit is the only record of that which the later legs
# do not overwrite.
check "the settle edit really reached the second device" \
  bash -c '[[ -n "$(git -C "'"$VAULT_B"'" log --all -S"'"$MARK_SETTLE"'" --format=%h | head -1)" ]]'
check "the sealed note is not plaintext on the second device" \
  bash -c "! grep -rq '$MARK_SEALED' '$VAULT_B'"
check "the sealed note is not plaintext on this device either" \
  bash -c "! grep -q '$MARK_SEALED' '$VAULT_A/Sealed/Secret.md'"
check "the diverging pull did not overwrite the local edit" \
  grep -q "$MARK_LOCAL" "$VAULT_A/Harness/Settle.md"
check "the app's vault is a Substrate-owned history repo" test -f "$VAULT_A/.git/substrate-owned"
# The run's own credentials are not evidence about the product, but their
# absence from the real store is evidence about this script: the config dir
# redirect above is only a claim until something outside the app checks it.
no_run_keyed_credentials() {
  ! grep -q 'vault-smoke-autosync' "$REAL_CONFIG/vault-sync.json" 2>/dev/null || return 1
  if [[ "$(uname -s)" == "Darwin" ]] && command -v security >/dev/null; then
    local root
    for root in "$VAULT_A" "$VAULT_B"; do
      security find-generic-password -s "$CRED_SERVICE" -a "$root" >/dev/null 2>&1 && return 1
      security find-generic-password -s "$CRED_SERVICE" -a "#hosted-master-key:$root" \
        >/dev/null 2>&1 && return 1
    done
  fi
  return 0
}
check "the real credential store holds nothing keyed by this run's vaults" \
  no_run_keyed_credentials

printf '\nstore: %s objects, %s\n' \
  "$(find "$STORE" -type f | wc -l | tr -d ' ')" "$(du -sh "$STORE" | cut -f1)"
printf 'AUTOSYNC-VERIFY PASS — real app, real hosted store, real second device\n'
printf 'logs: %s\n' "$SIGNAL"
