#!/usr/bin/env bash
# with-merge-lock.sh — serialize merge→push across parallel sessions.
#
# Ported from a sibling repo's drain_merge.sh, 2026-07-21 audit.
# Usage: scripts/with-merge-lock.sh [--wait[=SECONDS]] [--] <command...>
#   e.g. scripts/with-merge-lock.sh bash -c \
#     'git merge --no-ff sub/foo &&
#      GATED=$(git rev-parse HEAD) &&
#      <run the gate suite on "$GATED"> &&
#      git push origin "$GATED":refs/heads/main'
#
# The push step names the gated COMMIT, never a bare `git push origin main`:
# a branch name resolves at push time, so a commit that lands on main between
# the gate run and the push ships ungated.
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
#
# Preflight (before taking the lock, refuse loudly rather than mutate):
#  - the tree we run in must not be mid-merge (MERGE_HEAD)
#  - no stashes may exist repo-wide (refs/stash is shared across
#    worktrees; a cross-session "pop after merge" stash is a booby trap
#    under concurrent merges) — override with WITH_MERGE_LOCK_IGNORE_STASH=1
# Asked once more with the lock IN HAND, never before it (see the train gate
# below):
#  - local main must not already be AHEAD of origin/main. Somebody merged and
#    has not pushed, so a train is mid-flight (or died mid-flight) and their
#    commits are ungated as far as anything here can tell. Merging on top
#    adopts them: the union gate this run goes on to pass certifies work this
#    session never reviewed, and the push ships it. That is exactly step 2 of
#    the 2026-08-29 incident, where a session took the lock over another
#    session's unpushed union and the whole stack reached origin unverified.
#    The release-time UNPUSHED COMMITS warning below only fires AFTER the
#    damage; this refuses before it. A session RESUMING ITS OWN stranded train
#    (the documented retry after a fleet-busy rc 75) passes with a warning by
#    presenting the resume token that train's release printed —
#    WITH_MERGE_LOCK_RESUME_TRAIN=<token> — which is bound to one tip and one
#    train and is not an override. Deliberately adopting SOMEONE ELSE'S dead
#    train is still the override, WITH_MERGE_LOCK_ALLOW_UNPUSHED_MAIN=1, which
#    prints the commit list either way.
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

main_sha() { git rev-parse -q --verify 'refs/heads/main^{commit}' 2>/dev/null || true; }
origin_main_sha() { git rev-parse -q --verify 'refs/remotes/origin/main^{commit}' 2>/dev/null || true; }

# Was local main already unpushed before we ever took the lock? Then the
# stranded commits at release are not necessarily ours, and the warning says
# so rather than blaming the wrong session.
main_ahead_count() {
  local local_main remote_main
  local_main="$(main_sha)"
  remote_main="$(origin_main_sha)"
  # A missing origin/main reads as "not ahead" — deliberately fail-open. The
  # ref is absent in exactly two situations: a repository that has never
  # fetched (nothing to strand), and a checkout whose remote is unreachable.
  # Neither is evidence of a foreign train, and refusing every merge on a
  # missing tracking ref would wedge the estate on an offline morning.
  if [[ -z "$local_main" || -z "$remote_main" || "$local_main" == "$remote_main" ]]; then
    printf '0'
    return 0
  fi
  git rev-list --count "$remote_main..$local_main" 2>/dev/null || printf '0'
}

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

# The commits the train gate is about. Printed before the one-line reason, in
# the same shape as the release-time UNPUSHED COMMITS block, because "3 commits
# ahead" is not enough to decide anything: whether this is your own stalled
# push or another session's live train is a question only the log answers.
show_foreign_train() {
  local ahead remote_main
  ahead="$(main_ahead_count)"
  [[ "$ahead" =~ ^[0-9]+$ ]] || return 0
  [[ "$ahead" -gt 0 ]] || return 0
  remote_main="$(origin_main_sha)"
  {
    printf '\n'
    printf '=================== UNPUSHED TRAIN ALREADY ON main =====================\n'
    printf 'with-merge-lock: local main is %s commit(s) AHEAD of origin/main before\n' "$ahead"
    printf 'with-merge-lock: this run has merged anything. Someone merged and did not\n'
    printf 'with-merge-lock: push — their train is mid-flight, or it died:\n'
    git log --no-decorate --format='with-merge-lock:   %h %an  %s' -n 10 "$remote_main..refs/heads/main" 2>/dev/null || true
    if [[ "$ahead" -gt 10 ]]; then
      printf 'with-merge-lock:   ... and %s more\n' "$(( ahead - 10 ))"
    fi
    printf 'with-merge-lock:\n'
    printf 'with-merge-lock: Merging on top of those makes them YOUR riders: the union\n'
    printf 'with-merge-lock: gate you run afterwards certifies commits you never\n'
    printf 'with-merge-lock: reviewed, and the push ships them. That is the 2026-08-29\n'
    printf 'with-merge-lock: incident, step 2.\n'
    printf 'with-merge-lock:\n'
    printf 'with-merge-lock: Wait for the owner to push; resume YOUR OWN stranded train\n'
    printf 'with-merge-lock: with the token it printed (WITH_MERGE_LOCK_RESUME_TRAIN); or —\n'
    printf 'with-merge-lock: if the train is dead and you are adopting its commits — re-run\n'
    printf 'with-merge-lock: once with\n'
    printf 'with-merge-lock:   WITH_MERGE_LOCK_ALLOW_UNPUSHED_MAIN=1\n'
    printf 'with-merge-lock: and gate the tip you end up with, not the branch you added.\n'
    printf '=======================================================================\n'
  } >&2
}

# The train marker. One line in the common gitdir naming the train this machine
# left in flight: time, the tip it was stranded at, a resume token, the pid that
# stranded it, the host. Written at release when main is ahead, removed when it
# is level again.
#
# It exists for exactly one case the refusal above would otherwise wedge: a run
# that merged, was told the fleet was busy (rc 75) before it could gate and
# push, and comes back to finish ITS OWN train. Without a marker that run is
# indistinguishable from a stranger adopting someone else's commits, and the
# only way through would be the override — which teaches the operator to reach
# for the override on the ordinary retry path, and an override reached for
# routinely stops being read.
#
# The token is bound to one train and one tip: it is printed only in that run's
# own release block, never in a refusal, so a stranger looking at a refused
# console cannot adopt a dead train from what it says. Same trust boundary as
# the gate-evidence receipt — an unsigned file on disk stops the accident, not
# an actor who is trying.
TRAIN_MARKER="$GITDIR/substrate-merge-train"

train_marker_field() { # 1=time 2=tip 3=token 4=pid 5=host
  head -n 1 "$TRAIN_MARKER" 2>/dev/null | cut -f"$1"
}

mint_train_token() {
  local token
  token="$(od -An -tx1 -N6 /dev/urandom 2>/dev/null | tr -d ' \n')"
  [[ -n "$token" ]] || token="$(printf '%04x%04x%04x' "$RANDOM" "$RANDOM" "$RANDOM")"
  printf '%s' "$token"
}

PREFLIGHT="$(preflight_reason)"
if [[ -n "$PREFLIGHT" ]]; then
  die "$PREFLIGHT"
fi

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

warn_unpushed_main() { # resume-token
  local ahead remote_main token="${1:-}"
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
    printf 'with-merge-lock:   git push origin "$GATED":refs/heads/main\n'
    printf 'with-merge-lock: (push the gated COMMIT, not the branch name — a plain\n'
    printf 'with-merge-lock:  `git push origin main` ships whatever landed on main\n'
    printf 'with-merge-lock:  since the gate run, ungated.)\n'
    if [[ -n "$token" ]]; then
      printf 'with-merge-lock:\n'
      printf 'with-merge-lock: If the fleet was busy (rc 75) and you are coming BACK to\n'
      printf 'with-merge-lock: finish this same train, the next run resumes it with\n'
      printf 'with-merge-lock:   WITH_MERGE_LOCK_RESUME_TRAIN=%s\n' "$token"
      printf 'with-merge-lock: That token is good for this tip only, and is not an\n'
      printf 'with-merge-lock: override — it says "these commits are mine", nothing more.\n'
    fi
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

# Did the train gate below let this run proceed? Until it does, this run has no
# claim on whatever is sitting unpushed on main, so it neither mints a marker
# for it nor prints the UNPUSHED COMMITS block: a run refused at the gate that
# stamped its own token over the marker would hand the stranded train away to
# the very session the gate just turned back.
TRAIN_OK=0
RESUME_TOKEN=""

release() {
  local owner
  owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ "$owner" == "$$" ]]; then
    # The lock names us, so we hold it — a fact that is true from the instant
    # the lock exists, because the pid file arrives in the same rename as the
    # directory. That is the whole reason ownership decides this and not a flag.
    settle_train || true
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
    settle_train || true
  fi
}

# At release: is a train still in flight, and whose is it? Level with
# origin/main means the train landed and the marker is stale, so it goes.
# Ahead means these commits are stranded under this run's name — record the
# marker (keeping the token we resumed with, so a train that takes three
# attempts keeps one token) and print the block that carries it.
settle_train() {
  local ahead token
  [[ "$TRAIN_OK" -eq 1 ]] || return 0
  ahead="$(main_ahead_count)"
  if [[ ! "$ahead" =~ ^[0-9]+$ || "$ahead" -eq 0 ]]; then
    rm -f "$TRAIN_MARKER" 2>/dev/null || true
    return 0
  fi
  token="$RESUME_TOKEN"
  [[ -n "$token" ]] || token="$(mint_train_token)"
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(main_sha)" "$token" "$$" \
    "$(hostname -s 2>/dev/null || printf 'unknown')" \
    >"$TRAIN_MARKER" 2>/dev/null || true
  warn_unpushed_main "$token" || true
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

# The train gate. Asked HERE and nowhere earlier, on purpose: asked before the
# queue it turned "another session is mid-train" into an immediate exit 1, so a
# --wait caller that should have queued for thirty minutes and retried instead
# died with a code its callers read as "broken", not as "busy". The condition it
# refuses is also the condition that resolves itself while you wait — the owner
# pushes — so the answer taken before queueing was the one most likely to be
# stale by the time it mattered.
#
# Cases, exhaustively. Let AHEAD be local main's lead over origin/main at this
# moment:
#   AHEAD == 0                                   -> pass, silent.
#   ALLOW_UNPUSHED_MAIN=1                        -> pass, loud (adoption).
#   RESUME_TRAIN=<token>, marker matches token
#     AND marker tip == current main tip         -> pass, loud (resumption).
#   RESUME_TRAIN set, no marker / wrong token /
#     tip moved on                               -> refuse, naming which.
#   AHEAD > 0, nothing presented                 -> refuse.
train_gate() {
  local ahead tip supplied m_tip m_token m_pid m_time mismatch
  ahead="$(main_ahead_count)"
  if [[ ! "$ahead" =~ ^[0-9]+$ || "$ahead" -eq 0 ]]; then
    TRAIN_OK=1
    return 0
  fi

  if [[ "${WITH_MERGE_LOCK_ALLOW_UNPUSHED_MAIN:-0}" == "1" ]]; then
    # The override is never silent. Same reasoning as the gate-evidence guard:
    # the failure mode is a session that adopted someone else's commits without
    # noticing, and a quiet escape hatch reproduces it exactly.
    show_foreign_train
    printf 'with-merge-lock: WITH_MERGE_LOCK_ALLOW_UNPUSHED_MAIN=1 — adopting the %s commit(s) above.\n' "$ahead" >&2
    TRAIN_OK=1
    return 0
  fi

  tip="$(main_sha)"
  m_time="$(train_marker_field 1)"
  m_tip="$(train_marker_field 2)"
  m_token="$(train_marker_field 3)"
  m_pid="$(train_marker_field 4)"
  supplied="${WITH_MERGE_LOCK_RESUME_TRAIN:-}"

  if [[ -n "$supplied" ]]; then
    if [[ -z "$m_token" ]]; then
      mismatch="no train marker exists on this machine ($TRAIN_MARKER) — the stranded commits were not left by a run that recorded one"
    elif [[ "$supplied" != "$m_token" ]]; then
      mismatch="the token does not match the train recorded on this machine"
    elif [[ "$m_tip" != "$tip" ]]; then
      mismatch="the token names a train stranded at ${m_tip:0:12}, but main is at ${tip:0:12} now — main moved, so this is no longer the same train"
    else
      {
        printf '\n'
        printf '============== RESUMING A TRAIN THIS MACHINE STRANDED =================\n'
        printf 'with-merge-lock: local main is %s commit(s) ahead of origin/main, and\n' "$ahead"
        printf 'with-merge-lock: the resume token matches the train stranded at %s\n' "${m_tip:0:12}"
        printf 'with-merge-lock: on %s by pid %s. Proceeding on top of it.\n' "$m_time" "$m_pid"
        printf 'with-merge-lock: Those commits become riders on whatever you gate and\n'
        printf 'with-merge-lock: push next — gate the TIP you end up with.\n'
        printf '=======================================================================\n'
      } >&2
      RESUME_TOKEN="$supplied"
      TRAIN_OK=1
      return 0
    fi
  fi

  show_foreign_train
  {
    if [[ -n "$m_token" ]]; then
      printf 'with-merge-lock: a train marker records pid %s stranding main at %s on %s.\n' \
        "$m_pid" "${m_tip:0:12}" "$m_time"
    fi
    if [[ -n "$supplied" ]]; then
      printf 'with-merge-lock: WITH_MERGE_LOCK_RESUME_TRAIN was presented and REFUSED: %s.\n' "$mismatch"
    else
      printf 'with-merge-lock: resuming your OWN train after a busy-fleet rc 75 needs the\n'
      printf 'with-merge-lock: token that run printed in its own UNPUSHED COMMITS block:\n'
      printf 'with-merge-lock:   WITH_MERGE_LOCK_RESUME_TRAIN=<token>\n'
      printf 'with-merge-lock: (it is deliberately not repeated here — a console someone\n'
      printf 'with-merge-lock:  else is looking at must not hand them a live train.)\n'
    fi
  } >&2
  return 1
}

if ! train_gate; then
  release
  trap - EXIT
  die "local main is ahead of origin/main — an unpushed train is already in progress (listed above)"
fi


# The handshake the main commit guard reads (scripts/git-hooks/lib/
# merge-lock-guard.sh). That hook refuses a commit on main while another live
# process holds this lock; the holder's OWN merge commit must still pass, and
# it says so by carrying this token. It names the pid, not a secret: the hook
# accepts it only when it equals the pid the lock file currently names, so a
# token left over in some longer-lived environment goes stale the moment the
# lock changes hands. Exported here, after the lock is in hand, so nothing
# upstream of the claim can inherit it.
export SUBSTRATE_MERGE_LOCK_PID="$$"

status=0
"$@" || status=$?




exit "$status"
