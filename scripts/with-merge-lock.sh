#!/usr/bin/env bash
# with-merge-lock.sh — serialize merge→push across parallel sessions.
#
# Ported from a sibling repo's drain_merge.sh, 2026-07-21 audit.
# Usage: scripts/with-merge-lock.sh [--wait[=SECONDS]] [--] <command...>
#   e.g. scripts/with-merge-lock.sh bash -c \
#     'git merge --no-ff sub/foo && npm test && git push origin main'
#
# Runs <command...> while holding an exclusive on-disk mutex in the repo's
# common gitdir, so two sessions merging concurrently queue instead of
# interleaving index.lock/MERGE_HEAD in the shared main tree. Uncontended
# it adds nothing — a single session behaves exactly as before. A LIVE
# holder is a refusal (merges are serial ACROSS sessions, not just within
# one); a dead holder's leftover lock is stolen with a warning so a crashed
# session never wedges the merge train.
#
# --wait (SUB-1051) turns that refusal into a blocking acquire: poll until
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
# At RELEASE, local main being ahead of origin/main is called out loudly
# (SUB-1051 half 2). merge→gates→push atomicity is convention only, and on
# 2026-08-04 a session merged locally, released the lock, and left main 2-3
# commits unpushed for ~25 min — which breaks the next caller's
# `git pull --rebase origin main` with "Cannot rebase onto multiple
# branches". This is a WARNING, never a refusal: the lock must always come
# off, and a session that genuinely cannot push (offline, rejected) still
# needs its exit code intact.
#
# Preflight (before taking the lock, refuse loudly rather than mutate):
#  - the tree we run in must not be mid-merge (MERGE_HEAD)
#  - no stashes may exist repo-wide (SUB-293: refs/stash is shared across
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
    printf 'with-merge-lock: lands. Push now:  git push origin main\n'
    printf '========================================================================\n'
  } >&2
}

STEAL_LOCK_DIR="$LOCK_DIR.steal"

# Stealing a dead holder's lock is a read ("is pid X alive?") followed by a
# write ("then this lock is mine"), and nothing in the filesystem makes that
# pair atomic. Serialize the stealers instead: while this mutex is held, the
# judgement cannot be invalidated, because the only things that remove a lock
# dir are its own (here: dead) holder and another stealer.
# Consecutive polls that have found the steal mutex nameless. The mutex has the
# same mkdir→pid-write window as the merge lock, so it gets the same rule: one
# nameless reading is almost always a winner mid-write, and only a mutex still
# nameless a poll later is treated as a corpse.
STEAL_EMPTY_SEEN=0
# Which dir those consecutive readings were OF. A grace counted across a
# handover is a grace granted to the wrong dir: corpse cleared, rival's fresh
# mkdir lands, and the newcomer inherits a count it never served, so a lock
# microseconds old is judged abandoned. Inode is the identity — it changes on
# every mkdir, and `ls -di` reads it identically on macOS and Linux, where
# stat(1)'s flags do not. Residual: a filesystem free to recycle an inode
# number immediately can still hand the new dir the old identity, so this
# narrows the window rather than closing it.
STEAL_EMPTY_IDENT=""

dir_inode() {
  local out
  out="$(ls -di "$1" 2>/dev/null || true)"
  printf '%s' "$out" | awk '{print $1}'
}

steal_lock_is_ours() {
  [[ "$(cat "$STEAL_LOCK_DIR/pid" 2>/dev/null || true)" == "$$" ]]
}

# Returns 0 having taken it, 1 if someone else is mid-steal.
take_steal_lock() {
  local sp gone
  if mkdir "$STEAL_LOCK_DIR" 2>/dev/null; then
    # mkdir only reserves the name; the pid write is what claims it, and a rival
    # that looked in between can rename the dir out from under us. Neither half
    # may be assumed: this function is called as `if take_steal_lock`, which
    # suppresses set -e inside the body, so a failed printf would otherwise fall
    # straight through to `return 0` and hand the caller a mutex it never held.
    if ! printf '%s\n' "$$" >"$STEAL_LOCK_DIR/pid" 2>/dev/null; then
      return 1
    fi
    # Verify after write: the dir on disk must still carry OUR pid.
    steal_lock_is_ours || return 1
    STEAL_EMPTY_SEEN=0
    return 0
  fi
  sp="$(cat "$STEAL_LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -z "$sp" ]]; then
    sleep 1  # same grace as holder_pid: let a winner's pid write land
    sp="$(cat "$STEAL_LOCK_DIR/pid" 2>/dev/null || true)"
  fi
  if [[ -n "$sp" ]]; then
    STEAL_EMPTY_SEEN=0
    STEAL_EMPTY_IDENT=""
    if kill -0 "$sp" 2>/dev/null; then
      return 1
    fi
  else
    local ident
    ident="$(dir_inode "$STEAL_LOCK_DIR")"
    if [[ "$ident" != "$STEAL_EMPTY_IDENT" ]]; then
      STEAL_EMPTY_SEEN=0            # different dir than last poll — its grace starts now
      STEAL_EMPTY_IDENT="$ident"
    fi
    STEAL_EMPTY_SEEN=$(( STEAL_EMPTY_SEEN + 1 ))
    if [[ "$STEAL_EMPTY_SEEN" -lt 2 ]]; then
      return 1  # nameless, but not yet nameless for long enough to judge
    fi
  fi
  # Held by nobody: a steal takes microseconds, so a mutex whose owner is gone
  # was left by a session killed mid-steal. Clear it by RENAME and go back
  # around rather than stealing on the spot. A rename can still evict a live
  # stealer; the post-write pid verify NARROWS that window rather than closing
  # it — an evicted stealer that stalls between its own mkdir and its pid write
  # for the two nameless polls this arm needs can still be judged gone and
  # co-enter with its evictor. Closing it properly means retiring the
  # rename dance for an atomic claim (write pid into a private build dir, then
  # `mv` the whole dir into place, so a mutex is never observable nameless),
  # which would delete most of this machinery — a rewrite, not a patch.
  gone="$STEAL_LOCK_DIR.gone.$$"
  rm -rf "$gone"
  if mv "$STEAL_LOCK_DIR" "$gone" 2>/dev/null; then
    rm -rf "$gone"
  fi
  # Sweep any .gone.* a session died in the middle of removing. The pair is
  # microseconds, and a dir already renamed out of the way is destined for
  # deletion whoever gets to it, so clearing another evictor's copy is harmless.
  rm -rf "$STEAL_LOCK_DIR".gone.* 2>/dev/null || true
  STEAL_EMPTY_SEEN=0
  return 1
}

drop_steal_lock() {
  # Same ownership guard as release(): never remove a mutex that is no longer
  # ours (we were judged dead and someone else took it).
  if steal_lock_is_ours; then
    rm -rf "$STEAL_LOCK_DIR"
  fi
}

# Set the moment our own mkdir wins, so release() can tell "a nameless lock we
# created and never got to sign" from "a nameless lock belonging to someone
# else mid-write".
LOCK_CREATED=0

release() {
  warn_unpushed_main || true
  local owner
  owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  # Only ever remove a lock we still own. A session whose lock was stolen out
  # from under it (a dead-looking pid, an empty pid-file window) would
  # otherwise delete the CURRENT holder's lock on its way out and admit a
  # third session mid-merge — one collision cascading into an open lock.
  if [[ "$owner" == "$$" ]]; then
    rm -rf "$LOCK_DIR"
  elif [[ -z "$owner" && "$LOCK_CREATED" -eq 1 && -e "$LOCK_DIR" ]]; then
    # Killed between our mkdir and our pid write: the dir is ours, it just never
    # got our name on it, and leaving it would wedge the train until a waiter
    # times it out and steals. This arm cannot tell our unsigned dir from a
    # stealer's brand-new one — the claim path IS mkdir, so a rival's fresh
    # nameless dir looks identical. What makes it safe is the WINDOW, not the
    # reading: LOCK_CREATED is cleared the moment our pid write verifies, so by
    # construction this arm only ever runs inside the microseconds between our
    # own mkdir and that verify, before any steal of ours can have happened.
    rm -rf "$LOCK_DIR"
  fi
}

# Returns 0 having taken the lock (and armed the release), 1 if the mkdir
# was lost to someone else.
take_lock() {
  mkdir "$LOCK_DIR" 2>/dev/null || return 1
  # Arm the release on the mkdir, not on the pid write: from here a lock dir
  # exists in our name, and a signal landing in the gap below would otherwise
  # skip EXIT entirely and leave it behind.
  LOCK_CREATED=1
  trap on_exit EXIT
  # Unchecked, a failed pid write leaves a NAMELESS lock: release() refuses to
  # clean a lock that is not ours by pid, so it would outlive this run and every
  # waiter would have to time out on it. (set -e does not help here — the
  # function is called as `if take_lock`, which suppresses it inside the body.)
  if ! printf '%s\n' "$$" >"$LOCK_DIR/pid" 2>/dev/null; then
    rm -rf "$LOCK_DIR"
    LOCK_CREATED=0
    trap - EXIT
    return 1
  fi
  # Verify after write, same as the steal mutex: if a stealer got here first we
  # do not own this lock, and must not arm a release for it.
  if [[ "$(cat "$LOCK_DIR/pid" 2>/dev/null || true)" != "$$" ]]; then
    LOCK_CREATED=0
    trap - EXIT
    return 1
  fi
  # The nameless window is over: the dir on disk carries our pid, so release()'s
  # first arm (owner == "$$") is what covers us from here. Leaving the flag set
  # would keep release()'s second arm armed for the whole run — and a nameless
  # lock found at exit is then far more likely to be a STEALER's brand-new dir,
  # mid-write, than our own unsigned one. Clearing it here bounds that arm to
  # the microseconds it documents.
  LOCK_CREATED=0
  PRE_AHEAD="$(main_ahead_count)"
  return 0
}

holder_pid() {
  local owner
  owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -z "$owner" ]]; then
    sleep 1  # the other mkdir may have just won; let its pid write land
    owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  fi
  printf '%s' "$owner"
}

PRE_AHEAD=0

# Shared tail for every "not ours, not a steal" path.
#   $1 = the deadline, empty for a flagless run
#   $2 = what a flagless run dies with; empty means "look once more instead",
#        for the paths where refusing outright would strand a wedged lock
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
  local deadline="" owner announced=0 stolen empty_seen=0 empty_ident="" refusal
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
    if [[ -z "$owner" ]]; then
      # A lock with no pid is either a session that died between its mkdir and
      # its pid write, or one that is mid-write right now — one look cannot
      # tell them apart, and stealing from the second puts two sessions inside
      # the mutex. Only a lock still nameless a poll later is called abandoned;
      # a real holder announces itself in microseconds.
      #
      # "Still nameless" has to mean the SAME dir, not merely a nameless one:
      # a corpse cleared and instantly replaced by a rival's fresh mkdir would
      # otherwise hand the newcomer a grace it never served, and a lock
      # microseconds old would be judged abandoned. See dir_inode for what
      # identity means here, and for the inode-reuse residual it leaves.
      local ident
      ident="$(dir_inode "$LOCK_DIR")"
      if [[ "$ident" != "$empty_ident" ]]; then
        empty_seen=0
        empty_ident="$ident"
      fi
      empty_seen=$(( empty_seen + 1 ))
      if [[ "$empty_seen" -lt 2 ]]; then
        # No refusal here even without --wait: refusing would leave a genuinely
        # wedged lock unrecoverable, which is what the steal exists to prevent.
        # One extra poll, then it is judged abandoned.
        requeue_or_die "$deadline" ""
        continue
      fi
    else
      empty_seen=0
      empty_ident=""
    fi

    # A crashed session's leftover. The readings above are stale by the time
    # they are acted on — between judging that pid dead and clearing the lock,
    # another waiter can steal it and create a LIVE lock in its place, and
    # wiping THAT puts two sessions inside the mutex. So do the whole
    # judge-then-clear under the steal mutex: while it is held, the lock dir
    # cannot change hands, because the only things that remove one are its own
    # holder (dead here) and another stealer (excluded here).
    refusal="could not take the merge lock at $LOCK_DIR"
    if take_steal_lock; then
      stolen="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
      if [[ ! -e "$LOCK_DIR" ]]; then
        # Released while we queued. Go back around and race the plain mkdir —
        # falling through to the refusal would make a flagless run EXIT on
        # finding the lock free, which is the one case it should win outright.
        drop_steal_lock
        continue
      elif [[ -n "$stolen" ]] && kill -0 "$stolen" 2>/dev/null; then
        # A live session owns it after all — leave it completely alone, and
        # refuse with the same informative text the live-holder path uses.
        refusal="another session holds the merge lock (pid $stolen, $LOCK_DIR) — merges are serial across sessions; wait and re-run, or pass --wait to block"
      elif [[ -z "$stolen" && "$empty_seen" -lt 2 ]]; then
        : # still nameless, but not yet nameless for long enough to judge
      elif ! steal_lock_is_ours; then
        # Our mutex was evicted while we were judging, so another stealer may
        # already be acting on the same lock. Touch nothing and go back around.
        :
      else
        # Last check before the destructive step: the whole judgement above is
        # only safe while the steal mutex is still ours. The WARNING prints
        # inside it, not before — announcing a steal that the recheck then
        # cancels leaves an operator reading a log of steals that never
        # happened, hunting a lock nobody took.
        if steal_lock_is_ours; then
          printf 'with-merge-lock: WARNING: stealing stale lock left by dead pid %s\n' "${stolen:-<unknown>}" >&2
          rm -rf "$LOCK_DIR"
          if take_lock; then
            drop_steal_lock
            return 0
          fi
        fi
      fi
      drop_steal_lock
    fi
    # Lost the steal mutex, found a live owner behind it, or lost the mkdir to
    # a plain contender. Someone else owns the lock now.
    requeue_or_die "$deadline" "$refusal"
  done
}

acquire

# The preflight above ran BEFORE the lock. Flagless, that check-then-act gap
# is milliseconds. With --wait it is the whole budget — up to 30 minutes of
# another session doing exactly what the preflight refuses: parking a
# MERGE_HEAD, leaving a repo-wide stash (SUB-293). Ask again now that the lock
# is actually in hand, and refuse the same way rather than merge on a reading
# taken half an hour ago. Unconditional, not --wait-gated: a flagless run can
# also wait — a nameless lock costs it two polls, a steal costs it more — and
# the re-check is two local git commands.
PREFLIGHT="$(preflight_reason)"
if [[ -n "$PREFLIGHT" ]]; then
  release
  trap - EXIT
  die "$PREFLIGHT (it appeared while this run was waiting for the lock)"
fi


status=0
"$@" || status=$?


exit "$status"
