#!/usr/bin/env bash
# nightly-work-lock.sh — the lock a nightly takes on its OWN work clone, on
# the driving machine, for the whole run.
#
# Why this exists: each nightly keeps a single clone under its cache home
# (~/.cache/substrate-nightly/work, ~/.cache/substrate-linux-canary/work) and
# starts every run by resetting, cleaning and detaching it at the ref it means
# to judge. launchd single-instances the SCHEDULED path and nothing else, so an
# attended `nightly-mac-pass.sh --ref v0.X.Y` fired while the 03:17 job is
# still running shares that clone with it: the second run's `git reset --hard`
# / `git clean -fdxq` / `checkout --detach` moves the tree out from under the
# first, and both nights then report against a tree neither of them chose.
# That is the 2026-08-24 rig work-clone race one level up — the rig side is
# already covered by ~/substrate-ci/.lock; this is the local half.
#
# The lock is a directory (mkdir is the atomic test-and-set every POSIX
# filesystem gives you), taken before the first line that touches the clone and
# released when the run ends however it ends. A second run that meets it held
# does NOT wait and does NOT go red: a night that never got the clone made no
# claim about main, so its caller mints NO-VERDICT.
#
# Stale-break has the same shape as the rig lock's: a lock is broken only when
# it is BOTH older than the budget AND its owner pid is gone. Age alone would
# break a live long night; a dead pid alone would race a run that has just
# taken the lock and not yet written its owner file. The owner line's third
# field is the pid, matching the rig lock's `<host> pid <n> …` layout, and the
# owner is on THIS machine, so `kill -0` is a real liveness answer here.
#
# Usage:
#   . "$SCRIPT_DIR/lib/nightly-work-lock.sh"
#   nightly_work_lock "$NIGHTLY_HOME/.work.lock" nightly-mac-pass \
#     || no_verdict_prerun work-lock "$NIGHTLY_WORK_LOCK_REASON"

# 6 hours. A mac pass that meets a busy rig on every attempt spends its retry
# budget and then builds, covers and shoots — comfortably under this — and the
# canary is shorter still, so nothing legitimate is ever this old. It is well
# under the 24h between firings, so a run killed hard (a reboot, a SIGKILL)
# never costs more than one night.
NIGHTLY_WORK_LOCK_STALE_S="${SUBSTRATE_NIGHTLY_LOCK_STALE_S:-21600}"

# Set by nightly_work_lock on refusal — the sentence the caller puts in the
# report, naming who holds the clone. Read by the sourcing script, not here.
NIGHTLY_WORK_LOCK_REASON=""
# The lock this process holds, if any. The release path reads it, so an
# unlock before a lock (or a second one after) is a no-op rather than an
# `rm -rf` of something this run never took.
NIGHTLY_WORK_LOCK_HELD=""

nightly_work_unlock() {
  [ -n "${NIGHTLY_WORK_LOCK_HELD:-}" ] || return 0
  rm -rf "$NIGHTLY_WORK_LOCK_HELD"
  NIGHTLY_WORK_LOCK_HELD=""
}

nightly_work_lock() { # lockdir label — 0 = taken (released at exit), 1 = busy
  local lock="$1" label="$2" started age owner owner_pid now
  NIGHTLY_WORK_LOCK_REASON=""
  mkdir -p "$(dirname "$lock")" 2>/dev/null || true

  if [ -d "$lock" ]; then
    now=$(date +%s)
    started=$(cat "$lock/started" 2>/dev/null || echo "")
    # A half-written lock (mkdir landed, the owner and started files did not
    # yet) reads as age 0 with no owner: brand new, so it is respected rather
    # than broken. The run that is mid-take gets its files written a
    # microsecond later.
    case "$started" in ''|*[!0-9]*) started="$now" ;; esac
    age=$(( now - started ))
    owner_pid=$(awk '{print $3}' "$lock/owner" 2>/dev/null || echo "")
    case "$owner_pid" in ''|*[!0-9]*) owner_pid="" ;; esac
    if [ "$age" -gt "$NIGHTLY_WORK_LOCK_STALE_S" ] \
       && { [ -z "$owner_pid" ] || ! kill -0 "$owner_pid" 2>/dev/null; }; then
      echo "$label: breaking stale work-clone lock (${age}s old, owner dead)" >&2
      rm -rf "$lock"
    fi
  fi

  if ! mkdir "$lock" 2>/dev/null; then
    owner=$(cat "$lock/owner" 2>/dev/null || echo '?')
    # Read by the caller, which shellcheck cannot see from here.
    # shellcheck disable=SC2034
    NIGHTLY_WORK_LOCK_REASON="another run holds the work clone (lock $lock held by $owner) — this run never touched the tree"
    return 1
  fi

  printf '%s pid %s %s\n' "$(hostname -s 2>/dev/null || echo host)" "$$" "$label" > "$lock/owner"
  date +%s > "$lock/started"
  NIGHTLY_WORK_LOCK_HELD="$lock"
  # EXIT covers every ordinary end including the no-verdict paths' own exits;
  # the signal traps release and then leave, because a handler that only
  # cleans up would drop the run back where it was interrupted.
  trap 'nightly_work_unlock' EXIT
  trap 'nightly_work_unlock; exit 130' INT
  trap 'nightly_work_unlock; exit 143' TERM
  trap 'nightly_work_unlock; exit 129' HUP
  return 0
}
