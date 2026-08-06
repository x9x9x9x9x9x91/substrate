#!/usr/bin/env bash
# with-merge-lock.sh — serialize merge→push across parallel sessions.
#
# Ported from a sibling repo's drain_merge.sh, 2026-07-21 audit.
# Usage: scripts/with-merge-lock.sh [--wait[=SECONDS]] [--] <command...>
#   e.g. scripts/with-merge-lock.sh bash -c \
#     'git merge --no-ff sub/foo &&
#      GATED=$(git rev-parse HEAD) &&
#      <run the gate suite on "$GATED"> &&
#      scripts/push-gated-main.sh "$GATED"'
#
# The push step is scripts/push-gated-main.sh, never a bare
# `git push origin main`: the branch name resolves at push time,
# so a commit landing on main between the gate run and the push ships
# ungated. push-gated-main.sh pushes the gated COMMIT and aborts loudly if
# main moved under the run.
#
# Runs <command...> while holding an exclusive on-disk mutex in the repo's
# common gitdir, so two sessions merging concurrently queue instead of
# interleaving index.lock/MERGE_HEAD in the shared main tree. Uncontended
# it adds nothing — a single session behaves exactly as before. A LIVE
# holder is a refusal (merges are serial ACROSS sessions, not just within
# one); a dead holder's leftover lock is stolen with a warning so a crashed
# session never wedges the merge train.
#
# --wait turns that refusal into a blocking acquire: poll until
# the holder releases, then take the lock. Refusal stays the DEFAULT — a
# flagless run behaves exactly as it did. Without it every caller hand-rolls
# its own retry loop, which is what the 2026-08-04 batch did for ~40 min
# (docs/agent-friction.md, merge-lock ping-pong entry). Bare --wait waits
# WITH_MERGE_LOCK_WAIT_DEFAULT seconds (1800 = 30 min, longer than a full
# gate suite under the lock); --wait=SECONDS sets it explicitly. A timeout
# exits 75 — the repo's "resource busy, nothing was done" code, same as
# with-gates-lock.sh and verify-gates-remote.sh — never 1, so a caller can
# tell "I waited and the train is jammed" from "I refused on sight".
#
# At RELEASE, local main being ahead of origin/main is called out loudly.
# merge→gates→push atomicity is convention only, and on
# 2026-08-04 a session merged locally, released the lock, and left main 2-3
# commits unpushed for ~25 min — which breaks the next caller's
# `git pull --rebase origin main` with "Cannot rebase onto multiple
# branches". This is a WARNING, never a refusal: the lock must always come
# off, and a session that genuinely cannot push (offline, rejected) still
# needs its exit code intact.
# A session that cannot take the lock does not have to wait for it: it can
# append its reviewed branches to the running train instead
# (the merge-queue handshake, scripts/merge-queue.sh). This script only points
# at that queue — it prints what is waiting when the lock is taken and again
# when it is released, so a train never finishes without seeing branches that
# arrived under it. Claiming them is the train's own call, at its own integration
# boundary; merge-queue.sh owns the protocol and the crash-safety rules.
#
# Preflight (before taking the lock, refuse loudly rather than mutate):
#  - the tree we run in must not be mid-merge (MERGE_HEAD)
#  - no stashes may exist repo-wide (refs/stash is shared across
#    worktrees; a cross-session "pop after merge" stash is a booby trap
#    under concurrent merges) — override with WITH_MERGE_LOCK_IGNORE_STASH=1
#

set -euo pipefail

die() { printf 'with-merge-lock: %s\n' "$*" >&2; exit 1; }

# shellcheck source=scripts/lib/checkout-guard.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/checkout-guard.sh"
guard_checkout_freshness with-merge-lock.sh

USAGE="usage: with-merge-lock.sh [--wait[=SECONDS]] [--] <command...>"

# Leading flags only. Parsing stops at the first non-flag (or an explicit
# --), so a wrapped command keeps every argument of its own — including one
# spelled --wait.
WAIT_SECONDS=""  # empty = refuse on contention (the default, unchanged)
# Tracked separately from the value: an empty --wait= must be a usage error,
# not a silent collapse onto the same empty string that means "no flag" (which
# would validate nothing and quietly hand the caller refuse-mode).
WAIT_GIVEN=0
# Which knob actually supplied the value, so a bad one is blamed on whoever set
# it: `--wait` with a garbage WITH_MERGE_LOCK_WAIT_DEFAULT in the environment is
# the env var's fault, and telling the caller their correct flag is wrong sends
# them looking in the wrong place.
WAIT_SOURCE="--wait"

# Whole seconds, no leading zeros: "08" passes a bare [0-9]+ test and then dies
# in arithmetic context, where bash reads a leading zero as octal.
valid_seconds() { [[ "$1" =~ ^(0|[1-9][0-9]*)$ ]]; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait)
      if [[ -n "${WITH_MERGE_LOCK_WAIT_DEFAULT:-}" ]]; then
        WAIT_SECONDS="$WITH_MERGE_LOCK_WAIT_DEFAULT"
        WAIT_SOURCE="WITH_MERGE_LOCK_WAIT_DEFAULT"
      else
        WAIT_SECONDS=1800
      fi
      WAIT_GIVEN=1; shift ;;
    --wait=*) WAIT_SECONDS="${1#--wait=}"; WAIT_GIVEN=1; WAIT_SOURCE="--wait"; shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done

if [[ "$WAIT_GIVEN" -eq 1 ]] && ! valid_seconds "$WAIT_SECONDS"; then
  if [[ "$WAIT_SOURCE" == "WITH_MERGE_LOCK_WAIT_DEFAULT" ]]; then
    die "WITH_MERGE_LOCK_WAIT_DEFAULT takes a whole number of seconds (no leading zeros), got '$WAIT_SECONDS' — unset it or pass --wait=SECONDS"
  fi
  die "--wait takes a whole number of seconds (no leading zeros), got '$WAIT_SECONDS' — $USAGE"
fi

# Validated here rather than at first use: an unusable value otherwise kills
# the waiter through set -e on sleep's failure, AFTER it has announced it is
# waiting and with exit 1 instead of the 75 a caller reads as "still busy".
POLL_SECONDS="${WITH_MERGE_LOCK_POLL_SECONDS:-5}"
if ! valid_seconds "$POLL_SECONDS" || [[ "$POLL_SECONDS" -lt 1 ]]; then
  die "WITH_MERGE_LOCK_POLL_SECONDS takes a positive whole number of seconds, got '$POLL_SECONDS' — $USAGE"
fi

[[ $# -ge 1 ]] || die "$USAGE"

GITDIR="$(git rev-parse --path-format=absolute --git-common-dir)" \
  || die "not inside a git repository"

# Prints the refusal reason if the repo is not in a state we may merge in, and
# nothing at all when it is. A function because --wait has to ask twice: once
# before queueing, once after the lock is finally in hand (see below).
preflight_reason() {
  if [[ -e "$(git rev-parse --absolute-git-dir)/MERGE_HEAD" ]]; then
    printf '%s' "an unfinished merge (MERGE_HEAD) is parked in this tree — conclude or abort it first"
    return 0
  fi
  if [[ "${WITH_MERGE_LOCK_IGNORE_STASH:-0}" != "1" && -n "$(git stash list)" ]]; then
    printf '%s' "stash entries exist (git stash list) — refs/stash is shared across all worktrees (SUB-293); disposition them or set WITH_MERGE_LOCK_IGNORE_STASH=1"
    return 0
  fi
}

PREFLIGHT="$(preflight_reason)"
[[ -z "$PREFLIGHT" ]] || die "$PREFLIGHT"

LOCK_DIR="$GITDIR/substrate-merge.lock"


on_exit() {
  local rc=$?
  release
  # A run killed mid-steal leaks the steal mutex otherwise, and the next
  # FLAGLESS run then refuses outright ("could not take the merge lock") instead
  # of stealing the stale lock it can plainly see: take_steal_lock clears a dead
  # stealer's mutex but asks its caller to come back around, and a flagless
  # caller has nowhere to come back around to. Defined below this handler, like
  # release: bash resolves function names at call time, not at trap time.
  drop_steal_lock
  clear_own_scratch
}

# Signals are routed through EXIT rather than handled separately: bash dying to
# an unhandled signal skips the EXIT trap entirely, which would both leak the
# lock and swallow the verdict.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

main_sha() { git rev-parse -q --verify 'refs/heads/main^{commit}' 2>/dev/null || true; }
origin_main_sha() { git rev-parse -q --verify 'refs/remotes/origin/main^{commit}' 2>/dev/null || true; }

# Was local main already unpushed before we ever took the lock? Then the
# stranded commits at release are not necessarily ours, and the warning says
# so rather than blaming the wrong session.
main_ahead_count() {
  local local_main remote_main
  local_main="$(main_sha)"
  remote_main="$(origin_main_sha)"
  if [[ -z "$local_main" || -z "$remote_main" || "$local_main" == "$remote_main" ]]; then
    printf '0'
    return 0
  fi
  git rev-list --count "$remote_main..$local_main" 2>/dev/null || printf '0'
}

warn_unpushed_main() {
  local ahead remote_main
  ahead="$(main_ahead_count)"
  [[ "$ahead" =~ ^[0-9]+$ ]] || return 0
  [[ "$ahead" -gt 0 ]] || return 0
  remote_main="$(origin_main_sha)"
  {
    printf '\n'
    printf '===================== UNPUSHED COMMITS ON LOCAL main ====================\n'
    printf 'with-merge-lock: releasing the merge lock with local main %s commit(s)\n' "$ahead"
    printf 'with-merge-lock: AHEAD of origin/main. These commits are NOT pushed:\n'
    git log --no-decorate --format='with-merge-lock:   %h %s' -n 10 "$remote_main..refs/heads/main" 2>/dev/null || true
    if [[ "$ahead" -gt 10 ]]; then
      printf 'with-merge-lock:   ... and %s more\n' "$(( ahead - 10 ))"
    fi
    if [[ "$PRE_AHEAD" -gt 0 ]]; then
      printf 'with-merge-lock: (main was ALREADY %s commit(s) ahead when this run took\n' "$PRE_AHEAD"
      printf 'with-merge-lock:  the lock — some or all of these belong to an earlier session.)\n'
    fi
    printf 'with-merge-lock: the next session that pulls will hit "Cannot rebase onto\n'
    printf 'with-merge-lock: multiple branches", and the merge train stalls until this\n'
    printf 'with-merge-lock: lands. Gate this tip and push it:\n'
    printf 'with-merge-lock:   GATED=$(git rev-parse refs/heads/main)\n'
    printf 'with-merge-lock:   run the gate suite on "$GATED"\n'
    printf 'with-merge-lock:   scripts/push-gated-main.sh "$GATED"\n'
    printf 'with-merge-lock: (push-gated-main.sh pushes the gated commit, not the\n'
    printf 'with-merge-lock:  branch name — a plain `git push origin main` ships\n'
    printf 'with-merge-lock:  whatever landed on main since, ungated. SUB-1070.)\n'
    printf '========================================================================\n'
  } >&2
}

# ---------------------------------------------------------------------------
# Atomic claim
#
# A lock is CLAIMED by building it complete in a private scratch dir and then
# renaming that dir onto the lock path. rename(2) is atomic, so the lock path
# only ever goes absent -> fully-formed; it is never observable half-built the
# way an `mkdir` followed by a separate pid write is. That single property is
# what retires the machinery this file used to carry: there is no nameless
# window to grant grace for, no inode identity to track across a handover, and
# no post-write ownership verify to catch a rival that overwrote us mid-claim.
# A rival cannot get inside a rename.
#
# The one wrinkle is that the tool is mv(1) rather than rename(2) directly:
# given an EXISTING directory as its destination, mv moves the source INSIDE it
# instead of failing (rename(2) itself would return ENOTEMPTY, since a built
# lock always holds a pid file). So a claim is confirmed by reading the pid
# back: ours means the rename landed on a free name and the lock is ours,
# anything else means we nested into somebody's lock and lost. That read is not
# the old ownership verify wearing a new hat — it cannot be raced, because the
# nested path carries our own pid and no other session ever writes it.
#
# Removal is the same trick backwards: rename the lock out of the way first,
# then take the renamed copy apart at leisure. An in-place teardown would leave
# the lock path briefly EMPTY, and empty is the one state a claim can never
# produce — keeping it impossible is what lets everything below treat a
# pid-less lock as unambiguous garbage instead of a possible live claimant.
#
# DESTRUCTIVE-PATH DISCIPLINE. Nothing here removes a path directly, and
# nothing here uses `rm -rf`. Every removal goes through
# remove_lock_shaped_dir, which takes a `pid` file out by name and then rmdir's
# the directory — rmdir refuses a directory that holds anything unexpected, so
# the worst a wrong path can do is delete a stray `pid` and then fail loudly,
# rather than flatten a tree. Composed paths are guarded on BOTH halves with
# `${var:?}`, which aborts the run on an empty or unset component instead of
# expanding it into a root-shaped argument. This is structural on purpose: a
# lock script is exactly where a path variable ends up empty (a known failure — a
# release path deleting a stealer's fresh lock), and the guard has to hold on
# the day nobody is reading the diff.

# Takes apart one of our lock-shaped dirs: a `pid` file, plus at most one level
# of nested scrap left by claimants that lost a race into it. Returns 0 when
# the directory is gone, 1 when it held something unexpected and was left
# standing. Refuses an empty or unset path loudly (parameter-expansion abort).
remove_lock_shaped_dir() {
  local dir="${1:?remove_lock_shaped_dir: refusing an empty path}" child
  [[ -d "$dir" ]] || return 0
  rm -f "${dir:?}/pid"
  for child in "${dir:?}"/*; do
    [[ -d "$child" ]] || continue
    rm -f "${child:?}/pid"
    rmdir "${child:?}" 2>/dev/null || true
  done
  rmdir "${dir:?}" 2>/dev/null || return 1
  return 0
}

# Test hook for the guard above. It only ever runs on the day something has
# already gone wrong, so it gets a directed test rather than a hope. Not a
# user-facing flag.
case "${WITH_MERGE_LOCK_SELFTEST_REMOVE:-}" in
  '') ;;
  empty) remove_lock_shaped_dir ""; exit 0 ;;
  unset) remove_lock_shaped_dir; exit 0 ;;
  *) die "unknown WITH_MERGE_LOCK_SELFTEST_REMOVE: ${WITH_MERGE_LOCK_SELFTEST_REMOVE}" ;;
esac

# Builds $1 in a private scratch dir and installs it atomically.
# Returns 0 holding it, 1 having left nothing behind that outlives the call.
claim_dir() {
  local target="${1:?claim_dir: refusing an empty target}" parent base build
  case "$target" in
    */?*) ;;
    *) die "claim_dir: refusing a target with no parent directory: $target" ;;
  esac
  parent="${target%/*}"
  base="${target##*/}.build.$$"
  build="${parent:?}/${base:?}"
  remove_lock_shaped_dir "$build" || true
  mkdir "$build" 2>/dev/null || return 1
  # The contents are complete BEFORE the name exists — that is the whole point.
  # (set -e does not help in here: these helpers are called as `if claim_dir`,
  # which suppresses it inside the body, so every step is checked by hand.)
  if ! printf '%s\n' "$$" >"$build/pid" 2>/dev/null; then
    remove_lock_shaped_dir "$build" || true
    return 1
  fi
  if ! mv "${build:?}" "${target:?}" 2>/dev/null; then
    remove_lock_shaped_dir "$build" || true
    return 1
  fi
  if [[ "$(cat "$target/pid" 2>/dev/null || true)" == "$$" ]]; then
    return 0
  fi
  # Nested: the target already existed, so mv put our scratch dir inside it.
  # (Or it was ours for an instant and the holder released it out from under
  # the read — either way we do not hold it, and must not act as if we do.)
  remove_lock_shaped_dir "${target:?}/${base:?}" || true
  return 1
}

# Removes $1 without ever exposing it half-removed: rename first, take apart
# second. 0 = gone, 1 = still standing and left alone.
evict_dir() {
  local target="${1:?evict_dir: refusing an empty target}" gone
  gone="${target:?}.gone.$$"
  remove_lock_shaped_dir "$gone" || true
  mv "${target:?}" "${gone:?}" 2>/dev/null || return 1
  remove_lock_shaped_dir "$gone" || true
  return 0
}

# Sweeps `.gone.<pid>` scraps left by sessions killed between the rename and
# the teardown. Only DEAD owners' scraps: a live session's scrap may still be
# on its way back (see the restore in take_steal_lock), and removing that would
# destroy a lock rather than tidy up after one.
sweep_gone() {
  local prefix="${1:?sweep_gone: refusing an empty prefix}" scrap owner
  for scrap in "${prefix:?}".gone.*; do
    [[ -d "$scrap" ]] || continue
    owner="${scrap##*.}"
    if ! [[ "$owner" =~ ^[1-9][0-9]*$ ]]; then continue; fi
    if kill -0 "$owner" 2>/dev/null; then continue; fi
    remove_lock_shaped_dir "$scrap" || true
  done
}

STEAL_LOCK_DIR="$LOCK_DIR.steal"

# Judging a holder dead is a read ("is pid X alive?"); clearing its lock is a
# write; nothing in the filesystem makes the pair atomic. Between the two,
# another session can clear the same corpse and claim it, and our write would
# then evict a LIVE holder. Serialize the stealers so that cannot interleave:
# while this mutex is held, the only sessions that may remove a lock dir are
# its own holder (dead, here) and another stealer (excluded, here).
#
# The mutex is claimed with the same atomic primitive as the lock itself, so it
# needs nothing beyond the claim: no nameless grace, no inode identity, no
# post-write verify, and no recheck before the destructive step — nobody evicts
# a mutex whose owner is alive, and its owner is us.
steal_lock_is_ours() {
  [[ "$(cat "$STEAL_LOCK_DIR/pid" 2>/dev/null || true)" == "$$" ]]
}

# Returns 0 having taken it, 1 if someone else is mid-steal — or if we just
# cleared a dead stealer's mutex and the caller should come back around.
take_steal_lock() {
  local sp gone moved
  claim_dir "$STEAL_LOCK_DIR" && return 0
  sp="$(cat "$STEAL_LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -n "$sp" ]] && kill -0 "$sp" 2>/dev/null; then
    return 1
  fi
  if [[ ! -e "$STEAL_LOCK_DIR" ]]; then
    return 1  # released while we looked; race for it next time around
  fi
  # Held by nobody: a steal takes microseconds, so a mutex whose owner is gone
  # was left by a session killed mid-steal. Clear it and go back around rather
  # than stealing on the spot.
  #
  # Residual, stated plainly: THIS read-then-evict is the one that is not
  # serialized — it is the bottom of the recursion. A mutex whose corpse
  # another session clears and re-claims in the gap can still be renamed away
  # while live. The check after the rename is a compensator, not a fix: if what
  # we moved turns out not to be the corpse we judged, it goes straight back.
  gone="${STEAL_LOCK_DIR:?}.gone.$$"
  remove_lock_shaped_dir "$gone" || true
  if mv "${STEAL_LOCK_DIR:?}" "${gone:?}" 2>/dev/null; then
    moved="$(cat "$gone/pid" 2>/dev/null || true)"
    if [[ -n "$moved" && "$moved" != "$sp" ]] && kill -0 "$moved" 2>/dev/null; then
      mv "${gone:?}" "${STEAL_LOCK_DIR:?}" 2>/dev/null || remove_lock_shaped_dir "$gone" || true
    else
      remove_lock_shaped_dir "$gone" || true
    fi
  fi
  sweep_gone "$STEAL_LOCK_DIR"
  return 1
}

drop_steal_lock() {
  if steal_lock_is_ours; then
    evict_dir "$STEAL_LOCK_DIR" || true
  fi
}

# Did this run ever hold the lock? This gates the unpushed-main warning ONLY — a
# run that was refused on sight never merged anything, so blaming it for commits
# an earlier session stranded would send the operator to the wrong log. Whether
# to REMOVE the lock is decided by ownership below, never by this flag: any flag
# has to be assigned on some line after the claim, and a run killed in that gap
# would hold the lock while believing it did not.
HELD=0
PRE_AHEAD=0

release() {
  local owner
  owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ "$owner" == "$$" ]]; then
    # The lock names us, so we hold it — a fact that is true from the instant
    # the lock exists, because the pid file arrives in the same rename as the
    # directory. That is the whole reason ownership decides this and not a flag.
    warn_unpushed_main || true
    # Leaving the lock standing on a failed evict is the safe failure: it still
    # carries our pid, and the next session steals it once we are gone. Tearing
    # it down in place instead would expose the empty state nothing else here has
    # to reason about.
    evict_dir "$LOCK_DIR" || true
    return 0
  fi
  # Not ours, or no longer ours. Never remove it: a session whose lock was
  # stolen out from under it would otherwise delete the CURRENT holder's lock on
  # its way out and admit a third session mid-merge. It did merge under the lock
  # though, so it still owes the warning.
  if [[ "$HELD" -eq 1 ]]; then
    warn_unpushed_main || true
  fi
}

# Removes the scratch names that carry our pid. Nothing else ever touches them,
# so this needs no ownership check and cannot race.
clear_own_scratch() {
  local scrap
  for scrap in "${LOCK_DIR:?}.build.$$" "${LOCK_DIR:?}.gone.$$" \
               "${STEAL_LOCK_DIR:?}.build.$$" "${STEAL_LOCK_DIR:?}.gone.$$"; do
    remove_lock_shaped_dir "$scrap" || true
  done
}

# Returns 0 having taken the lock, 1 if the claim was lost.
take_lock() {
  # Both of these are read BEFORE the claim on purpose. The count is a read-only
  # git query, and a run that loses the claim never reads it back — while a run
  # killed in the instant after the claim now still reports honestly, because
  # there is no line between "the lock is ours" and the state describing it.
  PRE_AHEAD="$(main_ahead_count)"
  claim_dir "$LOCK_DIR" || return 1
  # Test seam. The instant right here used to leak the lock: it existed on disk
  # while the flag that release consulted had not been assigned yet, so a signal
  # landing in the gap freed nothing. It is a sub-millisecond window no test can
  # aim at from outside — setting this to a whole number of seconds holds the run
  # still inside it so a test can kill it there deliberately. Never set in normal
  # use; ignored unless it parses as a positive integer.
  if [[ "${WITH_MERGE_LOCK_TEST_PAUSE_AFTER_CLAIM:-}" =~ ^[1-9][0-9]*$ ]]; then
    sleep "$WITH_MERGE_LOCK_TEST_PAUSE_AFTER_CLAIM"
  fi
  HELD=1
  return 0
}

holder_pid() {
  # No grace, no sleep: the pid file and the lock path arrive in the same
  # rename, so a lock that exists always carries its holder's name. A pid-less
  # lock is NOT a session mid-claim — that state is unreachable now — it is the
  # residue of a teardown that was interrupted, and is garbage.
  cat "$LOCK_DIR/pid" 2>/dev/null || true
}

# Shared tail for every "not ours, not a steal" path.
#   $1 = the deadline, empty for a flagless run
#   $2 = what a flagless run dies with; empty means "look once more instead"
# A waiting run owes its deadline the same 75 the live-holder path exits with.
requeue_or_die() {
  local deadline="$1" reason="${2:-}"
  if [[ -z "$deadline" ]]; then
    [[ -z "$reason" ]] || die "$reason"
  elif [[ "$(date +%s)" -ge "$deadline" ]]; then
    printf 'with-merge-lock: gave up after %ss waiting for the merge lock (%s) — nothing was done\n' \
      "$WAIT_SECONDS" "$LOCK_DIR" >&2
    exit 75
  fi
  sleep "$POLL_SECONDS"
}

acquire() {
  local deadline="" owner announced=0 stolen refusal
  # `if`, not `[[ ... ]] && ...`: a false test as a bare statement is a nonzero
  # command under set -e, which would abort the run before the loop.
  if [[ -n "$WAIT_SECONDS" ]]; then
    deadline=$(( $(date +%s) + WAIT_SECONDS ))
  fi
  while :; do
    if take_lock; then return 0; fi
    owner="$(holder_pid)"
    if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then
      if [[ -z "$deadline" ]]; then
        die "another session holds the merge lock (pid $owner, $LOCK_DIR) — merges are serial across sessions; wait and re-run, or pass --wait to block"
      fi
      if [[ "$announced" -eq 0 ]]; then
        printf 'with-merge-lock: merge lock held by pid %s — waiting up to %ss (polling every %ss)\n' \
          "$owner" "$WAIT_SECONDS" "$POLL_SECONDS" >&2
        announced=1
      fi
      if [[ "$(date +%s)" -ge "$deadline" ]]; then
        printf 'with-merge-lock: gave up after %ss waiting for the merge lock (still held by pid %s, %s) — nothing was done\n' \
          "$WAIT_SECONDS" "$owner" "$LOCK_DIR" >&2
        exit 75
      fi
      sleep "$POLL_SECONDS"
      continue
    fi

    # Either a dead holder's corpse, or a pid-less dir left by an interrupted
    # teardown. Both are garbage, and both are cleared under the steal mutex —
    # the readings above are stale by the time they are acted on, and clearing
    # a lock another waiter has just replaced with a LIVE one would put two
    # sessions inside the mutex.
    refusal="could not take the merge lock at $LOCK_DIR"
    if take_steal_lock; then
      # Test seam. The two branches below turn on what the lock looks like in
      # the instant AFTER the mutex is in hand — a sub-millisecond window that
      # no test can aim at from outside. Setting this to a whole number of
      # seconds holds the run still there so a test can move the lock
      # underneath it deliberately. Never set in normal use; ignored unless it
      # parses as a positive integer.
      if [[ "${WITH_MERGE_LOCK_TEST_PAUSE_AFTER_MUTEX:-}" =~ ^[1-9][0-9]*$ ]]; then
        sleep "$WITH_MERGE_LOCK_TEST_PAUSE_AFTER_MUTEX"
      fi
      if [[ ! -e "$LOCK_DIR" ]]; then
        # Freed while we queued. Go back around and race the claim — falling
        # through to the refusal would make a flagless run EXIT on finding the
        # lock free, which is the one case it should win outright.
        drop_steal_lock
        continue
      fi
      stolen="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
      if [[ -n "$stolen" ]] && kill -0 "$stolen" 2>/dev/null; then
        # A live session owns it after all — leave it completely alone, and
        # refuse with the same informative text the live-holder path uses.
        refusal="another session holds the merge lock (pid $stolen, $LOCK_DIR) — merges are serial across sessions; wait and re-run, or pass --wait to block"
      else
        # The WARNING prints here rather than earlier: under the mutex the
        # judgement can no longer be cancelled, so an operator never reads a
        # log of steals that did not happen.
        printf 'with-merge-lock: WARNING: stealing stale lock left by dead pid %s\n' "${stolen:-<unknown>}" >&2
        evict_dir "$LOCK_DIR" || true
        sweep_gone "$LOCK_DIR"
        if take_lock; then
          drop_steal_lock
          return 0
        fi
      fi
      drop_steal_lock
    fi
    # Lost the steal mutex, found a live owner behind it, or lost the claim to
    # a plain contender. Someone else owns the lock now.
    requeue_or_die "$deadline" "$refusal"
  done
}

# Armed BEFORE the claim, not after it. The claim installs the lock with a
# rename, so there is no instant where the lock exists and the trap does not —
# arming it afterwards would leave exactly that window, and a run killed inside
# it would strand the lock for the next session to steal. Arming it early is
# free: release only ever removes a lock whose pid file names this run, and the
# scratch sweep only ever touches names carrying our own pid.
trap on_exit EXIT

acquire

# The preflight above ran BEFORE the lock. Flagless, that check-then-act gap
# is milliseconds. With --wait it is the whole budget — up to 30 minutes of
# another session doing exactly what the preflight refuses: parking a
# MERGE_HEAD, leaving a repo-wide stash. Ask again now that the lock
# is actually in hand, and refuse the same way rather than merge on a reading
# taken half an hour ago. Unconditional, not --wait-gated: a flagless run can
# also wait — losing a claim race costs it a poll, a steal costs it more — and
# the re-check is two local git commands.
PREFLIGHT="$(preflight_reason)"
if [[ -n "$PREFLIGHT" ]]; then
  release
  trap - EXIT
  die "$PREFLIGHT (it appeared while this run was waiting for the lock)"
fi
# Branches other sessions appended to the merge queue while we were queueing.
# Printed, never acted on: what the train integrates stays the train's
# decision. Never fatal — a broken queue must not take a merge down with it.
QUEUE_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/merge-queue.sh"
merge_queue_notice() {
  [[ -f "$QUEUE_SCRIPT" ]] || return 0
  bash "$QUEUE_SCRIPT" notify || true
}
merge_queue_notice


status=0
"$@" || status=$?


# Late arrivals: a branch appended while the wrapped command ran would
# otherwise be seen by nobody until the next train happened to start.
merge_queue_notice

exit "$status"
