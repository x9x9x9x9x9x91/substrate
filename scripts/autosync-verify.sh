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
# And, from outside all three processes, the promise the sync design exists to
# keep: what crossed the WIRE was ciphertext. A tee sits on the loopback
# address the app dials, keeping every byte in both directions; afterwards the
# capture is read back and must hold none of this run's plaintext — not the
# harness markers, not the synthetic vault's own phrases — while every uploaded
# body opens with the encryption envelope its route carries. The store-directory
# grep further down is the server's word for the same thing; the capture is
# nobody's. Both are written into a dated evidence bundle the run prints.
#
# It runs on the SHIPPED timings — two minutes of settle, five of pull
# interval — so the whole run takes ~20 minutes. That is the point: the
# timings are half of what "full auto" means.
#
# Usage:
#     bash scripts/autosync-verify.sh              # ~20 min, warm build
#     AUTOSYNC_BUNDLE=1 bash scripts/autosync-verify.sh # the BUNDLED app
#     AUTOSYNC_KEEP=1 bash scripts/autosync-verify.sh   # keep the vaults
#     AUTOSYNC_KEYCHAIN=~/Library/Keychains/substrate-autosync.keychain-db \
#       bash scripts/autosync-verify.sh            # unattended, over ssh
#
# ATTENDED vs UNATTENDED. The app stores its sync credentials in whichever
# keychain is the user's default, and over ssh that one is locked — so the run
# was a desktop ritual and could never be a gate. AUTOSYNC_KEYCHAIN is the way
# out: a keychain that exists for this run and nothing else, provisioned once
# per rig by scripts/rig-provision-sync-keychain.sh, unlocked here from a
# password file kept outside the checkout, made the default for the length of
# the run, and put back afterwards. The app is not changed and does not know:
# it writes to the default keychain either way. Attended mode is what runs
# when the variable is unset.
#
# Unattended keychain mode is the full proof path for credential hygiene, and
# the mode a release proof should use: only there can the run say both halves
# — that the real default keychain holds nothing keyed by this run's vaults,
# AND that the credentials the app made went to the throwaway keychain
# instead. Attended, there is only one keychain and the app's credentials
# belong in it while the app is up, so the same assertion is asked after
# teardown has run: it proves this run leaves nothing behind, not that it
# stayed out. Both modes still check the config file, which is where the
# XDG redirect is provable on either. An attended run can be fully green.
#
# Bundle mode compiles the real frontend into the real binary (`tauri build
# --debug --no-bundle`, the same mechanism the real-app smoke lane uses) and
# runs THAT against the loopback store. Run it in that mode before shipping a
# release that touches sync — the dev-mode run proves the scheduler, the
# bundled run proves the shipped shape: no dev server, real CSP, the frontend
# inside the binary. It is not the artifact a user downloads: debug profile,
# unbundled, unsigned, and the driver's remote and passphrase compiled in. What
# it removes from doubt is the dev server, which is the part that was never a
# release.
#
# Never aimed at a real vault: both vaults and the store are created under
# /tmp by this script, the app runs with a config dir of its own under /tmp so
# its credentials never land in the real store, the second-device helper
# refuses a vault outside /tmp, and the in-app driver refuses a root without
# "vault-smoke-autosync" in it. The drives shelf is pointed at an empty scratch
# root too (SUBSTRATE_VOLUME_ROOTS), so the app never catalogs the machine's
# real mounted disks into the harness vault.
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
# Every phrase the capture must not hold, one per line — built from the seed
# vault after it lands, so it names what is really in there rather than a list
# that can drift away from it.
FORBIDDEN="$SIGNAL/forbidden-phrases.txt"
BUILD_STAMP="$SIGNAL/build-start"

# The app's sync credentials, health file and privacy file live in its config
# dir, and VAULT_DIR does not redirect that. Left alone, every run stores a
# sync token plus a wrapped hosted master key keyed by a /tmp vault root this
# script then deletes — in the same store the real vault's credentials live in
# — and writes its health and privacy files over the real vault's. So the app
# gets a config dir of its own, inside the run's scratch directory.
CONFIG="$SIGNAL/config"
# The drives shelf catalogs every volume mounted on the machine, and a real
# external disk is a real vault's worth of file names — the 2026-08-29 attended
# run watched it write a Time Machine drive's whole listing into the scratch
# vault, and the rewrites kept the tree dirty so sync could never engage. The
# app is pointed at an empty scratch root instead, through the same hook the
# drives tests use.
VOLUME_ROOTS="$SIGNAL/volumes"
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

# The dedicated test keychain, or empty for attended mode. A path, so the run
# names exactly one file rather than trusting a search-list lookup, and the
# refusals below can say which file they mean.
KEYCHAIN=${AUTOSYNC_KEYCHAIN:-}
# Its password, on the rig and never in the checkout. A file rather than a
# variable by default: a variable is inherited by everything the run spawns —
# the app, cargo, the server — and this one has no business being there.
KEYCHAIN_PASSWORD_FILE=${AUTOSYNC_KEYCHAIN_PASSWORD_FILE:-$HOME/.config/substrate/autosync-keychain-password}
# What the user's keychain configuration was before this run touched it, so
# cleanup() can put it back byte for byte. Empty until the swap happens, which
# is what makes the restore a no-op on every path that never got that far.
KEYCHAIN_PRIOR_DEFAULT=""
# An array, not a string. A keychain path can hold a space, and a search list
# rebuilt by word-splitting one turns a path with a space in it into two
# entries that are each nothing — which leaves the user's keychain search list
# quietly broken after a run that otherwise passed.
KEYCHAIN_PRIOR_LIST=()

# The app and the second device dial PORT; the sync server itself listens on
# SERVER_PORT and never sees a client directly. What sits between them is the
# tee — so the capture is every byte the app sent, taken before the server can
# have an opinion about any of it.
PORT=${AUTOSYNC_PORT:-8791}
SERVER_PORT=${AUTOSYNC_SERVER_PORT:-$((PORT + 1))}
DEV_PORT=${AUTOSYNC_DEV_PORT:-1452}
BUNDLE=${AUTOSYNC_BUNDLE:-0}
TOKEN=${AUTOSYNC_TOKEN:-harness-token-0123456789}
PASSPHRASE=${AUTOSYNC_PASSPHRASE:-harness passphrase 1275}
BOOT_TIMEOUT=${AUTOSYNC_BOOT_TIMEOUT:-1200}
# Above the driver's own worst case, deliberately. The per-leg bounds sum to
# roughly 4900s (780 settle push + 780 post-seal refusal + 720 waiting for the
# local commit + 400 interval + 200 focus + 180 divergence pull + the shorter
# legs and gate deadlines). A bound below that sum kills a slow-but-healthy run
# with a generic "did not finish" instead of letting the leg that stalled say
# so itself. It bounds the DRIVER loop only: bundle mode's build and the wire
# assertion both run outside it, so neither eats into the budget.
RUN_TIMEOUT=${AUTOSYNC_RUN_TIMEOUT:-5400}

# Must match VERIFY_MARKERS in src/lib/autosyncverify.ts.
MARK_SETTLE="autosync-settle-marker"
MARK_SEALED="autosync-sealed-marker"
MARK_LOCAL="autosync-local-edit-marker"

# Ordinary-looking notes, written into vault A before the app ever starts, so
# the run carries the kind of prose a vault actually holds and not only harness
# markers. Their phrases are the wire assertion's real subject: each one is
# proven to have reached the second device THROUGH the store, and proven absent
# from the capture — a phrase that never travelled would be absent for free.
# Synthetic by decision: a real vault, or a copy of one, never takes part in
# this run, encrypted or otherwise.
CANARY_ONE="hyaline drift under the tape hiss, second pass"
CANARY_TWO="bergamot and petrol, cut at 33 for the white label"
CANARY_THREE="settle the mastering invoice before the Thursday handover"
# Body text is not the only thing a leak can be made of. A note's own name, the
# folder holding it and a frontmatter tag are metadata, and metadata is what
# rides in a URL, a header or a manifest field where nothing is sealed — so
# each one is a canary of its own, seeded distinctively enough that a match in
# the capture could only be the real thing.
CANARY_FOLDER="Tape Room Sessions"
CANARY_FILE="Hyaline Drift Room B"
CANARY_TAG="petrol-white-label"

# Where the run's proof is left behind. Named by the UTC minute it started, so
# a release ritual can point at one run and a later run never overwrites it.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE=${AUTOSYNC_EVIDENCE_DIR:-$ROOT/.autosync-evidence/$STAMP-$RUN}
WIRE="$EVIDENCE/wire"
TRANSCRIPT="$EVIDENCE/assertions.txt"

APP_PID=""
SERVER_PID=""
PROXY_PID=""
XVFB_PID=""
# Named before anything can fail, because the evidence manifest is written from
# cleanup() and a run that died in preflight still has to say what it was.
APP_BINARY="(never launched)"
fail() { printf '\nAUTOSYNC-VERIFY FAIL: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }

# A scratch root this run certainly created, at a path anyone can predict from
# a process id. `rm -rf` first, so a symlink planted there is removed rather
# than followed; `mkdir` without -p, so a path that came back between the two
# loses instead of being adopted; and the result resolved and re-checked, so
# what the run ends up holding is really a throwaway under /tmp and not a door
# into a real vault.
fresh_dir() {
  local dir="$1" real
  [[ "$dir" == /tmp/* ]] || fail "refusing to make a scratch root outside /tmp: $dir"
  rm -rf -- "$dir" || fail "could not clear $dir"
  mkdir -- "$dir" 2>/dev/null || fail "$dir came back between the clear and the create — refusing to run"
  if [[ -L "$dir" ]]; then fail "$dir is a symlink — refusing to run"; fi
  real="$(cd -- "$dir" && pwd -P)" || fail "could not resolve $dir"
  [[ "$real" == /tmp/* || "$real" == /private/tmp/* ]] \
    || fail "$dir resolves to $real, which is not a throwaway under /tmp"
}

# Phrase tests that never splice a phrase into a shell string: one apostrophe
# in a seeded line was enough to turn an assertion into a check that could not
# fail. `-F` for the same reason — a phrase is a phrase, not a pattern.
absent_from() { ! grep -rqF -- "$1" "${@:2}"; }
present_in() { grep -rqF -- "$1" "${@:2}"; }
in_history() { [[ -n "$(git -C "$1" log --all -S"$2" --format=%h 2>/dev/null | head -1)" ]]; }

stop() {  # only ever processes this script started
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.25; done
  kill -KILL -"$pid" 2>/dev/null || true
}

# ------------------------------------------------------- the test keychain
# Unattended mode, in three moves that are all reversible.
#
# The app writes its credentials with SecItemAdd naming no keychain, which
# means the user's DEFAULT keychain — so redirecting the app is redirecting the
# default, and there is no way to do it from outside without touching that
# setting. It is touched for the length of the run and restored from cleanup(),
# and both the previous default and the previous search list are captured
# before anything moves, so the restore does not have to guess.
#
# The password is read from a file the rig owns. It is never echoed, never put
# in a command line where `ps` could read it, and never exported: `security`
# gets it by a redirect straight from that file, so it is never copied anywhere
# else either — not into a shell variable held for the length of the run, and
# not into the temp file a here-string is under bash 3.2 (measured: `<<<` is a
# pipe under bash 5 but a regular file in $TMPDIR under /bin/bash on macOS, and
# nothing here requires bash 4+).
#
# This function is the guard on that file rather than the way its contents
# travel: it is called for its checks, and its output is discarded.
keychain_password() {
  local file="$KEYCHAIN_PASSWORD_FILE" perms
  [[ -f "$file" ]] || fail "no keychain password file at $file — run
  scripts/rig-provision-sync-keychain.sh on this machine first, or point
  AUTOSYNC_KEYCHAIN_PASSWORD_FILE at the one it wrote."
  case "$(cd "$(dirname "$file")" && pwd -P)" in
    "$ROOT"|"$ROOT"/*) fail "the keychain password file is inside the checkout ($file) — move it out;
  a password under a git tree is one careless add-everything commit away from being published." ;;
  esac
  perms="$(stat -f '%Lp' "$file" 2>/dev/null || stat -c '%a' "$file" 2>/dev/null)"
  [[ "$perms" == "600" || "$perms" == "400" ]] \
    || fail "$file is mode $perms — it must be 600, readable by its owner only (chmod 600)."
  # Trailing newline stripped, for a caller that wants the password as a value.
  # `security unlock-keychain` itself reads only as far as the first newline
  # (measured: one trailing newline, two, and CRLF all unlock at 0; one extra
  # non-newline character gives 51), so a file with a hand-added newline
  # unlocks fine either way — the stripping is for anything that compares or
  # stores it, not for the unlock.
  printf '%s' "$(cat "$file")"
}

# The scheduler under test lives in the app's webview, and macOS suspends an
# app's webview wholesale while the console session sits at the lock screen —
# the app boots and pulls once (that runs before the suspension bites) and
# then never fires another trigger, which reads as a settle-push timeout
# fifteen minutes later. Refuse up front with the real reason instead.
# Display SLEEP alone is handled (the launch holds a caffeinate assertion);
# a LOCKED session cannot be fixed from a script and needs a person.
screen_lock_preflight() {
  [[ "$(uname -s)" == "Darwin" ]] || return 0
  local locked
  locked=$(python3 - <<'PY' 2>/dev/null
try:
    import Quartz
    d = Quartz.CGSessionCopyCurrentDictionary() or {}
    print("locked" if d.get("CGSSessionScreenIsLocked") else "unlocked")
except Exception:
    print("unknown")
PY
) || locked="unknown"
  [[ "$locked" == "locked" ]] && fail "this console session is at the lock screen, so macOS suspends
  the app's webview and the sync scheduler inside it never fires — the run
  would only time out. Unlock this Mac (or disable its screen lock for the
  rig role) and run again."
  return 0
}

keychain_open() {
  [[ -n "$KEYCHAIN" ]] || return 0
  [[ "$(uname -s)" == "Darwin" ]] || fail "AUTOSYNC_KEYCHAIN is a macOS notion; this host is $(uname -s)."
  command -v security >/dev/null || fail "AUTOSYNC_KEYCHAIN is set but there is no security(1) here."
  [[ -f "$KEYCHAIN" ]] || fail "no keychain at $KEYCHAIN — run scripts/rig-provision-sync-keychain.sh
  on this machine first."
  # A refusal rather than a fallback. The point of this mode is that the real
  # keychain is never opened, so a run that quietly used it instead would be
  # the one failure mode worth being loud about.
  case "$KEYCHAIN" in
    *login.keychain-db|*login.keychain)
      fail "AUTOSYNC_KEYCHAIN points at the login keychain ($KEYCHAIN). This mode exists to keep
  the run off it — give it the dedicated keychain instead." ;;
  esac

  # `security` prints each path indented and quoted, one per line. Read line by
  # line and strip only the leading indent and the surrounding quotes, so a
  # path with a space in it survives the round trip intact.
  KEYCHAIN_PRIOR_DEFAULT="$(security default-keychain -d user 2>/dev/null | sed -e 's/^ *"//' -e 's/"$//')"
  KEYCHAIN_PRIOR_LIST=()
  while IFS= read -r line; do
    line="${line#"${line%%[! ]*}"}"
    line="${line#\"}"; line="${line%\"}"
    [[ -n "$line" ]] && KEYCHAIN_PRIOR_LIST+=("$line")
  done < <(security list-keychains -d user 2>/dev/null)
  [[ -n "$KEYCHAIN_PRIOR_DEFAULT" ]] || fail "could not read this user's default keychain, so the swap
  below would have nothing to restore."
  (( ${#KEYCHAIN_PRIOR_LIST[@]} > 0 )) || fail "could not read this user's keychain search list, so the
  swap below would have nothing to restore."

  # Fed by a redirect from the password file rather than `keychain_password |
  # security`: the password arrives on stdin, never appears in an argument list
  # `ps` could read, and there is no writer left holding a pipe. A reader that
  # exits before the writer's first write kills the writer with SIGPIPE, and
  # under pipefail that 141 becomes the status of the whole pipeline — a
  # keychain that unlocked fine, reported as a bad password, intermittently and
  # only when the machine is loaded enough to lose the race. A here-string
  # would fix the pipe and open a worse hole: under /bin/bash 3.2 on macOS it
  # is a regular file in $TMPDIR, so the password would be written to disk.
  # keychain_password still runs first, for its checks alone — a missing,
  # in-checkout or world-readable password file reports its own reason instead
  # of arriving here as a failed unlock.
  keychain_password >/dev/null || exit 1
  security unlock-keychain "$KEYCHAIN" <"$KEYCHAIN_PASSWORD_FILE" >/dev/null 2>&1 \
    || fail "could not unlock $KEYCHAIN with the password in $KEYCHAIN_PASSWORD_FILE."
  # A fresh keychain locks itself after five minutes, and this run takes twenty.
  # Bare set-keychain-settings clears both the timeout and lock-on-sleep, and
  # only works on an unlocked keychain — hence the order.
  security set-keychain-settings "$KEYCHAIN" >/dev/null 2>&1 \
    || fail "could not clear the auto-lock timeout on $KEYCHAIN; a five-minute lock would strand
  the run somewhere in the middle of it."

  # Search list first, default second. The other way round leaves a window in
  # which the default keychain is not in the search list, and a read landing in
  # it fails for a reason that has nothing to do with sync.
  security list-keychains -d user -s "$KEYCHAIN" "${KEYCHAIN_PRIOR_LIST[@]}" >/dev/null 2>&1 \
    || fail "could not put $KEYCHAIN on the keychain search list."
  security default-keychain -d user -s "$KEYCHAIN" >/dev/null 2>&1 \
    || fail "could not make $KEYCHAIN the default keychain for this user."
  note "keychain: $KEYCHAIN (default for this run; $KEYCHAIN_PRIOR_DEFAULT restored on exit)"
}

keychain_restore() {
  [[ -n "$KEYCHAIN_PRIOR_DEFAULT" ]] || return 0
  security default-keychain -d user -s "$KEYCHAIN_PRIOR_DEFAULT" >/dev/null 2>&1 || true
  (( ${#KEYCHAIN_PRIOR_LIST[@]} > 0 )) \
    && security list-keychains -d user -s "${KEYCHAIN_PRIOR_LIST[@]}" >/dev/null 2>&1
  [[ -n "$KEYCHAIN" ]] && security lock-keychain "$KEYCHAIN" >/dev/null 2>&1
  KEYCHAIN_PRIOR_DEFAULT=""
  return 0
}

# Whatever the app stored under this run's throwaway roots, gone — the config
# dir above covers it wherever the credentials are a file, this covers the one
# platform where they are not. Prefix-guarded, so it can only ever name a root
# this script created.
forget_credentials() {
  [[ "$(uname -s)" == "Darwin" ]] || return 0
  command -v security >/dev/null || return 0
  local root acct
  for root in "$VAULT_A" "$VAULT_B"; do
    [[ "$root" == /tmp/vault-smoke-autosync-* ]] || continue
    # The app keys entries by the root as IT spells it — canonicalized, so
    # /tmp becomes /private/tmp on macOS. Both spellings, or the delete
    # quietly misses the entry the app actually wrote.
    for acct in "$root" "/private$root"; do
      security delete-generic-password -s "$CRED_SERVICE" -a "$acct" >/dev/null 2>&1 || true
      security delete-generic-password -s "$CRED_SERVICE" -a "#hosted-master-key:$acct" \
        >/dev/null 2>&1 || true
      # Unattended mode names the test keychain outright as well, because this
      # runs from cleanup() and the ordering against the default-keychain
      # restore is not something either half should have to know about.
      if [[ -n "$KEYCHAIN" && -f "$KEYCHAIN" ]]; then
        security delete-generic-password -s "$CRED_SERVICE" -a "$acct" "$KEYCHAIN" >/dev/null 2>&1 || true
        security delete-generic-password -s "$CRED_SERVICE" -a "#hosted-master-key:$acct" \
          "$KEYCHAIN" >/dev/null 2>&1 || true
      fi
    done
  done
}

# The bundle is written from here rather than at the end of a green run, so a
# red one leaves the same evidence: a failed capture is the one worth reading,
# and a run that died before the wire assertion still has driver legs, log
# tails and a manifest that says which verdict it is.
write_evidence() {  # write_evidence <pass|fail>
  local verdict="$1" objects=0
  command -v node >/dev/null || return 0
  mkdir -p "$EVIDENCE" 2>/dev/null || return 0
  cp "$RESULT" "$EVIDENCE/driver-legs.json" 2>/dev/null || true
  cp "$SERVER_LOG" "$EVIDENCE/server.log" 2>/dev/null || true
  cp "$PEER_LOG" "$EVIDENCE/peer.log" 2>/dev/null || true
  cp "$FORBIDDEN" "$EVIDENCE/forbidden-phrases.txt" 2>/dev/null || true
  tail -300 "$LOG" >"$EVIDENCE/app.log.tail" 2>/dev/null || true
  tail -200 "$SIGNAL/wire.log" >"$EVIDENCE/wire.log.tail" 2>/dev/null || true
  if [[ -d "$STORE/objects" ]]; then
    objects=$(find "$STORE/objects" -type f ! -name '.tmp-*' | wc -l | tr -d ' ')
  fi
  env EV_STAMP="$STAMP" EV_RUN="$RUN" EV_MODE="$([[ "$BUNDLE" == "1" ]] && echo bundle || echo dev)" \
      EV_BINARY="$APP_BINARY" EV_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" \
      EV_HOST="$(uname -sm) $(hostname)" EV_OBJECTS="$objects" \
      EV_PORT="$PORT" EV_SERVER_PORT="$SERVER_PORT" EV_VERDICT="$verdict" \
    node -e '
const e = process.env;
const fs = require("fs");
// A run that never reached the wire assertion has no report; the manifest says
// so instead of failing to exist.
let wire = null;
try { wire = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
console.log(JSON.stringify({
  lane: "autosync-verify",
  startedUtc: e.EV_STAMP, run: e.EV_RUN, mode: e.EV_MODE, appBinary: e.EV_BINARY,
  commit: e.EV_COMMIT, host: e.EV_HOST,
  wirePort: Number(e.EV_PORT), storePort: Number(e.EV_SERVER_PORT),
  storeObjects: Number(e.EV_OBJECTS), wire, verdict: e.EV_VERDICT,
}, null, 2));
' "$WIRE/wire-report.json" >"$EVIDENCE/run.json" 2>/dev/null || true
}

cleanup() {
  local rc=$?
  local verdict=fail
  (( rc == 0 )) && verdict=pass
  stop "$APP_PID"
  stop "$PROXY_PID"
  stop "$SERVER_PID"
  stop "$XVFB_PID"
  forget_credentials
  keychain_restore
  write_evidence "$verdict"
  if [[ "${AUTOSYNC_KEEP:-0}" == "1" ]]; then
    printf '\nkept: vaults %s / %s, signals %s\n' "$VAULT_A" "$VAULT_B" "$SIGNAL"
  else
    [[ "$VAULT_A" == /tmp/vault-smoke-autosync-a-* ]] && rm -rf "$VAULT_A"
    [[ "$VAULT_B" == /tmp/vault-smoke-autosync-b-* ]] && rm -rf "$VAULT_B"
  fi
  # The evidence bundle outlives the scratch state either way — it is the
  # point of the run, and a failed run's capture is the one worth reading.
  printf 'evidence: %s\n' "$EVIDENCE"
  exit $rc
}
trap cleanup EXIT INT TERM

printf 'substrate auto-sync verification (run %s)\n' "$RUN"

# ---------------------------------------------------------------- preflight
command -v node >/dev/null || fail "node not on PATH"
command -v cargo >/dev/null || fail "cargo not on PATH"
[[ -d node_modules ]] || fail "no node_modules — run npm ci"

# The credential-hygiene assertion at the end reads the real store by service
# name. If the app's name for it moves and this one does not, that assertion
# quietly starts proving nothing, so the drift is caught here instead.
grep -qF -- "CREDENTIAL_SERVICE: &str = \"$CRED_SERVICE\"" src-tauri/src/gitsync.rs \
  || fail "CREDENTIAL_SERVICE in src-tauri/src/gitsync.rs is no longer \"$CRED_SERVICE\" —
  update CRED_SERVICE here, or the credential assertions below assert nothing."

# The app stores its sync credentials in the default keychain, and over ssh
# that one is locked ("User interaction is not allowed"). That surfaced only
# after twenty minutes of building, so it is checked here instead — and in
# unattended mode the swap that makes it survivable happens first, so what the
# round trip below asks about is the keychain the app will really use.
screen_lock_preflight
keychain_open

# Asked as a real write-read-delete round trip against the DEFAULT user
# keychain, not as `show-keychain-info` on a hardcoded login.keychain-db: that
# reads the wrong keychain on a machine whose default is not the login one, and
# an unlocked keychain still refuses an unattended session at the ACL prompt.
# The round trip is the same thing the app is about to do.
keychain_round_trip() {
  local keychain probe="com.substrate.autosync-verify-preflight-$RUN" rc
  keychain="$(security default-keychain -d user 2>/dev/null | tr -d ' "')"
  [[ -n "$keychain" ]] || return 1
  security add-generic-password -U -s "$probe" -a preflight -w probe "$keychain" >/dev/null 2>&1 || return 1
  security find-generic-password -s "$probe" -a preflight "$keychain" >/dev/null 2>&1
  rc=$?
  security delete-generic-password -s "$probe" -a preflight "$keychain" >/dev/null 2>&1 || true
  return $rc
}
if [[ "$(uname -s)" == "Darwin" ]] && command -v security >/dev/null; then
  keychain_round_trip \
    || fail "this session cannot write and read back a keychain item, so the app cannot store
  its sync credentials. Expected over ssh with no AUTOSYNC_KEYCHAIN (a locked login keychain, or
  an ACL prompt with nobody to answer it) — run this attended, in a desktop session on the
  machine itself, or provision a dedicated keychain with
  scripts/rig-provision-sync-keychain.sh and point AUTOSYNC_KEYCHAIN at it."
fi
lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && fail "port $PORT is busy (AUTOSYNC_PORT=<free port>)"
lsof -nP -iTCP:$SERVER_PORT -sTCP:LISTEN >/dev/null 2>&1 \
  && fail "store port $SERVER_PORT is busy (AUTOSYNC_SERVER_PORT=<free port>)"
# Bundle mode embeds the frontend in the binary and serves nothing over http,
# so the dev port is a dev-mode concern only.
if [[ "$BUNDLE" != "1" ]] && lsof -nP -iTCP:$DEV_PORT -sTCP:LISTEN >/dev/null 2>&1; then
  fail "dev port $DEV_PORT is busy (AUTOSYNC_DEV_PORT=<free port>)"
fi
fresh_dir "$SIGNAL"
mkdir "$STORE" || fail "could not create $STORE"
mkdir "$CONFIG" || fail "could not create $CONFIG"
mkdir "$VOLUME_ROOTS" || fail "could not create $VOLUME_ROOTS"
mkdir -p "$WIRE" || fail "could not create $WIRE"
: >"$TRANSCRIPT" || fail "could not write $TRANSCRIPT"
: >"$BUILD_STAMP" || fail "could not write $BUILD_STAMP"

# ------------------------------------------------------------------ vaults
fresh_dir "$VAULT_A"
fresh_dir "$VAULT_B"
cp -R examples/vault/. "$VAULT_A/" || fail "could not seed $VAULT_A"
# A few notes of the kind a working vault holds, on top of the example seed.
# They exist to give the wire assertion something with real prose in it: the
# harness markers are written mid-run by the driver, these are already there
# when the app first pushes, so they ride the very first upload. The folder,
# the file name and one of the tags are canaries in their own right — the
# shapes a leak takes when it leaks metadata rather than prose.
mkdir -p "$VAULT_A/$CANARY_FOLDER" "$VAULT_A/Releases" || fail "could not seed the session notes"
printf -- '---\ntype: note\ntags: [session]\n---\n\n# %s\n\n%s\n' \
  "$CANARY_FILE" "$CANARY_ONE" >"$VAULT_A/$CANARY_FOLDER/$CANARY_FILE.md"
printf -- '---\ntype: note\ntags: [release, %s]\n---\n\n# White label\n\n%s\n' \
  "$CANARY_TAG" "$CANARY_TWO" >"$VAULT_A/Releases/White Label.md"
printf -- '---\ntype: note\n---\n\n# Admin\n\n- [ ] %s\n' \
  "$CANARY_THREE" >"$VAULT_A/$CANARY_FOLDER/Admin.md"
SEEDED_NOTES=$(find "$VAULT_A" -name '*.md' | wc -l | tr -d ' ')
note "vault A (the app) $VAULT_A / vault B (the second device) $VAULT_B"

# Everything the capture must not hold, read off the seed vault that is now on
# disk rather than kept as a hand-written list beside it. Two streams: the
# named canaries and the passphrase, which are forbidden whatever their length,
# and then every note name, folder name and line of prose the seed carries,
# from 24 characters up — short enough to be a coincidence in ciphertext is
# short enough to be a false red, and the run is worth more than the last
# twenty characters. The token is deliberately absent: it is the credential
# the transport authenticates WITH, so it is on the wire by design.
{
  printf '%s\n' "$PASSPHRASE" "$CANARY_ONE" "$CANARY_TWO" "$CANARY_THREE" \
    "$CANARY_FOLDER" "$CANARY_FILE" "$CANARY_TAG"
  {
    find "$VAULT_A" -name '*.md' -print | sed "s|^$VAULT_A/||; s|\.md\$||" | tr '/' '\n'
    find "$VAULT_A" -name '*.md' -exec cat {} +
  } | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | awk 'length($0) >= 24' | sort -u
} >"$FORBIDDEN" || fail "could not build the forbidden-phrase list"
FORBIDDEN_COUNT=$(wc -l <"$FORBIDDEN" | tr -d ' ')
note "seeded $SEEDED_NOTES synthetic notes; $FORBIDDEN_COUNT phrases forbidden on the wire"

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
env SUBSTRATE_BLOB_ADDR="127.0.0.1:$SERVER_PORT" SUBSTRATE_BLOB_DIR="$STORE" SUBSTRATE_BLOB_TOKEN="$TOKEN" \
  "$SERVER_BIN" >>"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
set +m
sleep 1
kill -0 "$SERVER_PID" 2>/dev/null || fail "the sync server exited at once — $(tail -5 "$SERVER_LOG")"
note "hosted store on 127.0.0.1:$SERVER_PORT, objects under $STORE"

# ------------------------------------------------------------ the wire tee
# Everything the app and the second device send goes through here on its way
# to the store, and every byte of it is kept. Loopback hosted sync is plain
# HTTP by design, so this reads the wire without decrypting anything: whatever
# the capture holds is what left the app.
note "starting the wire tee on 127.0.0.1:$PORT …"
set -m
node scripts/autosync-verify.ts proxy --listen "$PORT" --upstream "127.0.0.1:$SERVER_PORT" \
  --dir "$WIRE" --ready "$SIGNAL/wire-ready" >>"$SIGNAL/wire.log" 2>&1 &
PROXY_PID=$!
set +m
for _ in $(seq 1 40); do [[ -f "$SIGNAL/wire-ready" ]] && break; sleep 0.25; done
[[ -f "$SIGNAL/wire-ready" ]] || fail "the wire tee never came up — $(tail -5 "$SIGNAL/wire.log")"
note "wire capture under $WIRE"

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
  # far enough back to catch this action's own lines even when it retried a
  # moved remote or printed a failure the test result lines then scrolled past
  tail -30 "$PEER_LOG" | grep '^PEER' | tail -6 | sed 's/^/    /'
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

# The driver's remote, token and passphrase are compiled into the frontend, so
# they are build-time variables in both modes — handed to `tauri dev` below,
# and to `tauri build` in bundle mode.
APP_BINARY="tauri dev (development build)"
if [[ "$BUNDLE" == "1" ]]; then
  # The shipped shape: the real frontend compiled into the real binary, real
  # CSP, no dev server anywhere. This is what makes the run a statement about
  # a build a user could install rather than about a dev server.
  note "building the bundled app (vite build + cargo — the slow part) …"
  : >"$BUILD_STAMP"
  env VITE_SUBSTRATE_AUTOSYNC_VERIFY=1 \
      VITE_AUTOSYNC_URL="blob+http://127.0.0.1:$PORT" \
      VITE_AUTOSYNC_TOKEN="$TOKEN" \
      VITE_AUTOSYNC_PASSPHRASE="$PASSPHRASE" \
      npm run tauri build -- --debug --no-bundle >"$LOG" 2>&1 \
    || fail "tauri build failed — tail of $LOG:
$(tail -30 "$LOG")"
  TARGET_DIR=$(cd src-tauri && cargo metadata --format-version 1 --no-deps 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).target_directory))')
  APP_BIN="$TARGET_DIR/debug/substrate"
  [[ -x "$APP_BIN" ]] || fail "built binary not found at $APP_BIN"
  # A build that silently no-ops leaves a binary from some earlier tree, and the
  # run would then be a statement about that tree instead of this one.
  [[ "$APP_BIN" -nt "$BUILD_STAMP" ]] \
    || fail "$APP_BIN is older than this run's build — a stale artifact, not what was just compiled"
  APP_BINARY="$APP_BIN"
  note "launching the bundled binary ($APP_BIN, VAULT_DIR=$VAULT_A) …"
  set -m
  env VAULT_DIR="$VAULT_A" \
      XDG_CONFIG_HOME="$CONFIG" \
      SUBSTRATE_VOLUME_ROOTS="$VOLUME_ROOTS" \
      SUBSTRATE_SMOKE=1 \
      SUBSTRATE_SMOKE_DIR="$SIGNAL" \
      "$APP_BIN" >>"$LOG" 2>&1 &
  APP_PID=$!
  set +m
else
  note "launching the real app (VAULT_DIR=$VAULT_A, dev port $DEV_PORT) …"
  set -m
  env VAULT_DIR="$VAULT_A" \
      XDG_CONFIG_HOME="$CONFIG" \
      SUBSTRATE_VOLUME_ROOTS="$VOLUME_ROOTS" \
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
fi

# The push debounce and the background pull both live in the webview, and
# macOS suspends an occluded webview's timers wholesale — with the rig's
# display asleep the app boots, pulls once, and then never fires another
# trigger for the whole run (observed as fifteen wire-silent minutes while
# the backend answered status polls fine). Wake the display and hold the
# machine's attention for exactly as long as the app lives.
if command -v caffeinate >/dev/null; then
  caffeinate -disu -w "$APP_PID" &
fi

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
      if grep -qF -- "$MARK_SETTLE" "$VAULT_B/Harness/Settle.md" 2>/dev/null; then
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
      grep -rqF -- "$MARK_SEALED" "$STORE" 2>/dev/null && why="the store holds the sealed plaintext; "
      grep -rqF -- "$MARK_SEALED" "$VAULT_B" 2>/dev/null && why="${why}the second device holds it in the clear; "
      grep -qF -- "$MARK_SEALED" "$VAULT_A/Sealed/Secret.md" 2>/dev/null &&
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
' "$RESULT" | tee -a "$TRANSCRIPT" \
  || { AUTOSYNC_KEEP=1; fail "the in-app driver reported a failure (see above; logs in $SIGNAL)"; }

# ---------------------------------------------- what actually crossed the wire
# The tee goes down first so nothing can still be writing into the capture,
# then the capture is read back from outside every process that made it. Both
# the harness markers and the synthetic vault's own prose are forbidden; the
# positive control — that those phrases really did travel — is asserted below
# against the second device, which only ever received them through this wire.
# The app goes down before the tee, not after: a push that fires into a tee
# that is already gone is a byte nobody captured, and the assertion would then
# be reading a wire that had traffic on it the capture never saw.
stop "$APP_PID"
APP_PID=""
stop "$PROXY_PID"
PROXY_PID=""
printf '\nwire capture (every byte the app sent):\n'
node scripts/autosync-verify.ts assert --dir "$WIRE" \
  --forbid "$MARK_SETTLE" --forbid "$MARK_SEALED" --forbid "$MARK_LOCAL" \
  --forbid "peer-seed" --forbid "peer-two" --forbid "peer-three" \
  --forbid-file "$FORBIDDEN" 2>&1 | tee -a "$TRANSCRIPT" \
  || { AUTOSYNC_KEEP=1; fail "the wire capture did not hold up (capture kept under $WIRE)"; }

# ------------------------------------------------- outside disk assertions
# Everything above is the app's own word. These are not.
printf '\noutside assertions:\n'
check() {
  local what="$1"; shift
  if "$@"; then
    note "ok   $what"
    printf 'ok   %s\n' "$what" >>"$TRANSCRIPT"
  else
    printf 'FAIL %s\n' "$what" >>"$TRANSCRIPT"
    fail "$what"
  fi
}
check "the store never saw the settle marker in the clear" absent_from "$MARK_SETTLE" "$STORE"
check "the store never saw the sealed marker in the clear" absent_from "$MARK_SEALED" "$STORE"
check "the store never saw the local edit in the clear" absent_from "$MARK_LOCAL" "$STORE"
# Read from history, not from the working file: the divergence leg has the
# second device deliberately rewrite this very note, so by the end of the run
# the marker is gone from disk on purpose. What must still be true is that it
# arrived at all, and a commit is the only record of that which the later legs
# do not overwrite.
check "the settle edit really reached the second device" in_history "$VAULT_B" "$MARK_SETTLE"
check "the sealed note is not plaintext on the second device" absent_from "$MARK_SEALED" "$VAULT_B"
check "the sealed note is not plaintext on this device either" \
  absent_from "$MARK_SEALED" "$VAULT_A/Sealed/Secret.md"
check "the diverging pull did not overwrite the local edit" \
  present_in "$MARK_LOCAL" "$VAULT_A/Harness/Settle.md"
check "the app's vault is a Substrate-owned history repo" test -f "$VAULT_A/.git/substrate-owned"
# The run's own credentials are not evidence about the product, but their
# absence from the real store is evidence about this script: the config dir
# redirect above is only a claim until something outside the app checks it.
no_run_keyed_credentials() {
  ! grep -q 'vault-smoke-autosync' "$REAL_CONFIG/vault-sync.json" 2>/dev/null || return 1
  if [[ "$(uname -s)" == "Darwin" ]] && command -v security >/dev/null; then
    local root
    # Unattended mode asks the keychain that was the default before this run
    # by name. Unqualified, the search list still holds the test keychain the
    # credentials are legitimately in, and the question would answer itself
    # wrongly. Honest limit: that keychain is locked over ssh, so a locked
    # read is indistinguishable here from an empty one — which is why the
    # positive check below, that the credentials went to the test keychain
    # instead, is the half that carries the claim in this mode.
    # Attended mode has no second keychain to name, so the question is asked
    # unqualified — of the real default keychain, which is where the app put
    # this run's credentials by design. The caller forgets them first, so what
    # is being asked there is whether teardown emptied it, not whether the app
    # kept out of it.
    local -a where=()
    [[ -n "$KEYCHAIN_PRIOR_DEFAULT" ]] && where=("$KEYCHAIN_PRIOR_DEFAULT")
    # Both spellings of each root: the app stores under the canonicalized
    # path (/private/tmp on macOS), and a probe that only asks for /tmp
    # would call a real-store leak clean.
    local acct
    for root in "$VAULT_A" "$VAULT_B"; do
      for acct in "$root" "/private$root"; do
        security find-generic-password -s "$CRED_SERVICE" -a "$acct" "${where[@]}" >/dev/null 2>&1 && return 1
        security find-generic-password -s "$CRED_SERVICE" -a "#hosted-master-key:$acct" \
          "${where[@]}" >/dev/null 2>&1 && return 1
      done
    done
  fi
  return 0
}
# Attended mode has no throwaway keychain: the app writes to the user's real
# default keychain because that is the shipped behaviour, so this run's
# credentials are legitimately sitting in it right now and the question below
# could only ever answer "no". What is worth asserting attended is the other
# end — that the run takes them back out again. So teardown is pulled forward
# to here and the assertion reads it: the app is already stopped above and
# nothing below touches a credential, so forgetting them early costs the run
# nothing, and cleanup() still runs the same function again on exit (it is
# idempotent, and prefix-guarded to roots this script created).
# Unattended must NOT do this — the positive check further down needs the
# test keychain's entries still there to have anything to find.
CRED_CHECK="the real credential store holds nothing keyed by this run's vaults"
if [[ -z "$KEYCHAIN" ]]; then
  forget_credentials
  CRED_CHECK="$CRED_CHECK once this run has forgotten them"
fi
check "$CRED_CHECK" no_run_keyed_credentials
# Unattended mode only, and the reason the assertion above still means
# something there: the credentials this run made exist, and they are in the
# throwaway keychain. Without this, "not in the real store" would also be true
# of a run whose app never stored anything at all.
if [[ -n "$KEYCHAIN" ]]; then
  credentials_landed_in_test_keychain() {
    # Either spelling counts: the app writes under the canonicalized root
    # (/private/tmp on macOS), not the /tmp literal this script builds.
    security find-generic-password -s "$CRED_SERVICE" -a "$VAULT_A" "$KEYCHAIN" >/dev/null 2>&1 ||
      security find-generic-password -s "$CRED_SERVICE" -a "/private$VAULT_A" "$KEYCHAIN" >/dev/null 2>&1
  }
  check "this run's sync credentials went to the dedicated test keychain" \
    credentials_landed_in_test_keychain
fi
# The positive control for the wire assertion, and the reason it is not a free
# absence. These phrases exist only in vault A and reached vault B by one road
# — through the store, over the tee. Absent from the capture and present on the
# far side is the whole claim; the first half alone would also be true of a
# phrase that never left. Every canary gets one, prose and metadata alike, and
# the note count stands in for the rest of the forbidden list: a seed note that
# never travelled would be absent from the capture for free.
check "the synthetic session note reached the second device" present_in "$CANARY_ONE" "$VAULT_B"
check "the synthetic release note reached the second device" present_in "$CANARY_TWO" "$VAULT_B"
check "the synthetic admin note reached the second device" present_in "$CANARY_THREE" "$VAULT_B"
check "the canary folder and file name reached the second device as a path" \
  test -f "$VAULT_B/$CANARY_FOLDER/$CANARY_FILE.md"
check "the canary frontmatter tag reached the second device" present_in "$CANARY_TAG" "$VAULT_B"
every_seeded_note_arrived() {
  local landed
  landed=$(find "$VAULT_B" -name '*.md' | wc -l | tr -d ' ')
  (( landed >= SEEDED_NOTES ))
}
check "every seeded note reached the second device (the forbidden list is not a free absence)" \
  every_seeded_note_arrived
# One more thing only an outside reader can say: the store cannot hold more
# objects than the capture watched being uploaded. A second socket the tee
# never sat on would show up here as objects with no wire behind them.
STORE_OBJECTS=$(find "$STORE/objects" -type f ! -name '.tmp-*' 2>/dev/null | wc -l | tr -d ' ')
WIRE_OBJECTS=$(node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
console.log(r.magics.SBO1);
' "$WIRE/wire-report.json" 2>/dev/null || echo -1)
check "every object in the store arrived over the tee ($STORE_OBJECTS stored, $WIRE_OBJECTS uploaded)" \
  test "$STORE_OBJECTS" -le "$WIRE_OBJECTS"

# The bundle itself is written from cleanup(), so a red run leaves one too.
printf '\nstore: %s objects, %s\n' "$STORE_OBJECTS" "$(du -sh "$STORE" | cut -f1)"
printf 'AUTOSYNC-VERIFY PASS — real app (%s), real hosted store, real second device, ciphertext on the wire\n' \
  "$APP_BINARY"
printf 'logs: %s\n' "$SIGNAL"
