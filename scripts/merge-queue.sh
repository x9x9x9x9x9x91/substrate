#!/usr/bin/env bash
# merge-queue.sh — hand branches to the merge train that is already running.
#
# Usage:
#   scripts/merge-queue.sh append <branch> [--issue ID] [--note TEXT]
#   scripts/merge-queue.sh list
#   scripts/merge-queue.sh claim [--max N]      # prints one branch per line
#   scripts/merge-queue.sh done <branch>
#   scripts/merge-queue.sh drop <branch> [--reason TEXT]
#   scripts/merge-queue.sh release [--all]      # un-claim the train's entries
#   scripts/merge-queue.sh reclaim <branch> [--force]   # operator escape hatch
#   scripts/merge-queue.sh notify               # one-line status, always exits 0
#   scripts/merge-queue.sh prune
#
# THE PROBLEM. scripts/with-merge-lock.sh makes merges serial: while one
# session integrates a train, a second session with reviewed branches is
# refused (or, with --wait, sits in a poll loop for however long the train
# takes — a full gate suite per union). Both outcomes waste a session, and
# the waiting one usually goes stale: main moves under its branches while it
# holds nothing.
#
# THE HANDSHAKE. The second session does not contend at all. It APPENDS its
# branches to a queue the running train reads, and stops. The train picks
# them up at its own integration boundary and lands them in the same union it
# was already going to gate. One gate run absorbs both sessions' work.
#
#   session B:  scripts/merge-queue.sh append sub/foo --issue <id>
#               ... park the issue, stop. B holds no lock and waits for nothing.
#   session A:  (between branches, holding the merge lock)
#               for b in $(scripts/merge-queue.sh claim); do <integrate $b>; done
#               scripts/merge-queue.sh done "$b"     # or: drop "$b" --reason ...
#
# WHERE THE TRAIN PICKS UP. `claim` is called ONLY between integrations —
# after one branch is merged and before the next one starts, or right before
# the union's gate run. Never mid-merge: a claim is refused while ANY worktree
# sharing this gitdir has MERGE_HEAD parked, so the boundary is enforced rather
# than remembered — the queue is common-dir state, so the guard has to be too.
# Anything appended after the train's last claim simply waits for the next
# train; nothing is lost and no union is re-shuffled underneath a gate run that
# already started.
#
# WHAT IS QUEUED IS A SHA, NOT A NAME. Review happens per-commit, so `append`
# records the tip it saw and `claim` refuses the entry if the branch has moved
# since — the entry stays pending, loudly, until a human either re-appends the
# reviewed-again tip or drops it. Silently integrating an unreviewed tip would
# make the whole handshake a lie; silently dropping would lose queued work.
#
# CRASH SAFETY. Every state change is a rename inside one directory, so there
# is no window where an entry is half-anywhere:
#  - the queue lives in the common gitdir but OUTSIDE the merge lock dir, so
#    a stolen or deleted lock (a dead train) never takes queued work with it;
#  - `append` writes to tmp/ and renames into pending/ — an appender killed
#    mid-write leaves a tmp file that no reader looks at (and `prune` removes);
#  - an appender holds NOTHING once the rename lands, so a dead appender
#    cannot wedge, delay, or block the train by any path;
#  - `claim` renames pending/ -> claimed/, which exactly one process can win,
#    and stamps the claiming pid. A train that dies with entries claimed has
#    them returned to pending/ by the next `claim` (its pid is gone), so work
#    survives the crash instead of disappearing into a half-finished train.
#  - a claim is TWO renames, and the entry is only visible after the second:
#    pending/X.entry -> claimed/X.entry.claiming.<host>.<pid> -> claimed/X.entry.
#    An entry a reader can see therefore ALWAYS carries a claim stamp, so no
#    reader ever has to guess whether an unstamped entry is mid-claim or
#    abandoned — a question only answerable by age, and age is unreadable here
#    because rename(2) preserves mtime (an entry's mtime is its APPEND time,
#    however long it then sat in pending/). A claimant killed inside the window
#    leaves the .claiming.<host>.<pid> file instead, which is judged by exactly
#    the same rule as any other claim: same host, pid gone, hand it back;
#  - going back the other way (claimed/ -> pending/, by reclaim or release) is
#    staged through a *.reclaiming name no reader globs, so it too has exactly
#    one winner and an interrupted return is finished by the next claim rather
#    than lost. An entry in pending/ NEVER carries a claim stamp: entry_field
#    reads the first match, so a leftover stamp would mask every later claimant;
#  - liveness is only ever judged for entries claimed on THIS host; a claim
#    stamped by another host is left alone rather than second-guessed.
#
# WHO A CLAIM BELONGS TO. Claims are stamped with the merge-lock HOLDER's pid
# (see claimant_pid), which is the train, not this millisecond-lived script.
# The consequence to know: two sessions claiming under ONE held lock stamp the
# same pid and are indistinguishable afterwards, so a plain `release` from
# either hands back both. That is safe (a released branch is re-served, never
# lost) but surprising — if two sessions really do claim under one lock, they
# are one train and should finish as one.
#
# The queue is advisory: it carries branch names and provenance, never a
# verdict. Whether a branch is ready to land is decided by review before it is
# appended, and by the train's own gates after it is claimed.

set -euo pipefail

die() { printf 'merge-queue: %s\n' "$*" >&2; exit 1; }
note() { printf 'merge-queue: %s\n' "$*" >&2; }

# shellcheck source=scripts/lib/checkout-guard.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/checkout-guard.sh"
guard_checkout_freshness merge-queue.sh

USAGE="usage: merge-queue.sh append|list|claim|done|drop|release|reclaim|notify|prune [...]"

# A flag whose value is the argument that isn't there: `shift 2` on a one-element
# argv fails, and under `set -e` that exits 1 without printing anything at all.
need_value() { [[ $# -ge 2 ]] || die "$1 needs a value — $USAGE"; }

[[ $# -ge 1 ]] || die "$USAGE"
CMD="$1"; shift

GITDIR="$(git rev-parse --path-format=absolute --git-common-dir)" \
  || die "not inside a git repository"

QUEUE_DIR="${SUBSTRATE_MERGE_QUEUE_DIR:-$GITDIR/substrate-merge-queue}"
PENDING="$QUEUE_DIR/pending"
CLAIMED="$QUEUE_DIR/claimed"
DONE="$QUEUE_DIR/done"
TMP="$QUEUE_DIR/tmp"
LOCK_DIR="$GITDIR/substrate-merge.lock"

HOST="$(hostname -s 2>/dev/null || hostname 2>/dev/null || printf 'unknown')"

mkdir -p "$PENDING" "$CLAIMED" "$DONE" "$TMP"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Reads one field out of an entry file. Absent field prints nothing.
entry_field() {
  local file="$1" key="$2" line
  line="$(grep -m1 "^$key=" "$file" 2>/dev/null || true)"
  printf '%s' "${line#*=}"
}

# Entries sort by filename, which starts with a zero-padded epoch, so a glob
# expansion is already FIFO order. Prints nothing when the dir is empty (the
# unmatched-glob path bash leaves as a literal).
# The `.entry` suffix is load-bearing: both in-flight names (`*.entry.reclaiming`
# on the way back to pending, `*.entry.claiming.<host>.<pid>` on the way in) end
# past it, so a half-finished transition is invisible to every reader here.
entries_in() {
  local dir="$1" f
  for f in "$dir"/*.entry; do
    [[ -e "$f" ]] || continue
    printf '%s\n' "$f"
  done
}

count_in() {
  local f n=0
  while IFS= read -r f; do
    if [[ -n "$f" ]]; then n=$(( n + 1 )); fi
  done < <(entries_in "$1")
  printf '%s' "$n"
}

# A branch name is part of a filename, so anything path-shaped in it has to
# survive the trip out and back — `/` is the only such character git branch
# names allow next to the ones already banned.
slug() { printf '%s' "$1" | sed 's|/|__|g'; }

pid_alive() { kill -0 "$1" 2>/dev/null; }

# The one place in this script that HOLDS something. `append` decides whether a
# branch is already queued by reading the queue and then writing it, and nothing
# in the filesystem makes that pair atomic; the consequences and why reconciling
# after the fact cannot replace this are spelled out at the call site.
#
# Scope kept as small as the bug demands: taken by appenders only, never by the
# train, and never around anything slower than one directory scan and one
# rename. An appender therefore still cannot delay, wedge, or contend with a
# running merge — it is not the merge lock and knows nothing about it.
APPEND_LOCK="$QUEUE_DIR/append.lock"
APPEND_LOCK_WAIT_SECONDS="${SUBSTRATE_MERGE_QUEUE_LOCK_WAIT:-10}"
APPEND_LOCK_HELD=0

# link(2) is the atomic create-if-absent primitive here: it fails when the name
# exists, and — the part mkdir cannot do — the file it publishes already has its
# contents. A reader therefore never sees a lock whose owner it cannot read,
# which matters because the fallback for an unreadable owner would be file age,
# and age is not a signal this queue can use (see CRASH SAFETY). flock(1) would
# be the obvious tool and is not one: macOS does not ship it.
append_lock_acquire() {
  local mine="$TMP/append.lock.$$" owner gone deadline
  printf '%s\n' "$$" >"$mine" || die "cannot write $mine"
  deadline=$(( $(date -u +%s) + APPEND_LOCK_WAIT_SECONDS ))
  while :; do
    if ln "$mine" "$APPEND_LOCK" 2>/dev/null; then
      rm -f "$mine"
      APPEND_LOCK_HELD=1
      return 0
    fi
    owner="$(cat "$APPEND_LOCK" 2>/dev/null || true)"
    owner="${owner//[$'\n\r']/}"
    if [[ "$owner" =~ ^[0-9]+$ ]] && ! pid_alive "$owner"; then
      # An appender killed inside its critical section. Clearing that is a
      # read ("is the owner dead?") followed by a write, so it is staged
      # through a name nobody else can be holding and the owner is re-read
      # after the move: two waiters racing the same corpse cannot then have
      # the slower one delete a lock the faster one has already retaken.
      #
      # The residual this does NOT close, stated plainly: a lock RETAKEN
      # between the death judgement and the mv can still be moved aside. If
      # another waiter clears this corpse and a third appender acquires in
      # that gap, the mv below moves a LIVE lock away; the re-read spots the
      # mismatch and links it back, but mv and ln are not one operation, so
      # the name is briefly free. Accepted: it needs an appender killed inside
      # a section that takes microseconds AND a waiter preempted across the
      # gap, which is far rarer than the duplicate this lock exists to stop.
      # The release path is where that residual is contained — see there.
      gone="$APPEND_LOCK.gone.$$"
      rm -f "$gone"
      if mv "$APPEND_LOCK" "$gone" 2>/dev/null; then
        if [[ "$(cat "$gone" 2>/dev/null | tr -d '\n\r')" == "$owner" ]]; then
          rm -f "$gone"
          note "cleared an append lock left by dead pid $owner"
        else
          # Not the corpse we judged — put it back, unless someone took the
          # name meanwhile, in which case the scrap is just litter.
          ln "$gone" "$APPEND_LOCK" 2>/dev/null || true
          rm -f "$gone"
        fi
      fi
      continue
    fi
    if [[ "$(date -u +%s)" -ge "$deadline" ]]; then
      rm -f "$mine"
      die "another append has held $APPEND_LOCK for over ${APPEND_LOCK_WAIT_SECONDS}s (owner pid ${owner:-<unreadable>}) — refusing rather than queueing a possible duplicate a train would serve twice. If no append is running, remove that file and re-run."
    fi
    sleep 0.05
  done
}

append_lock_release() {
  [[ "$APPEND_LOCK_HELD" -eq 1 ]] || return 0
  APPEND_LOCK_HELD=0
  local owner
  owner="$(cat "$APPEND_LOCK" 2>/dev/null | tr -d '\n\r' || true)"
  # Only ever remove a lock we still own. The flag above records that this
  # process once acquired, not that it still holds: an appender whose lock was
  # moved aside by the dead-owner path would otherwise delete the CURRENT
  # holder's lock on its way out and admit a second appender into the section
  # this lock exists to keep single-file — the very duplicate it prevents.
  [[ "$owner" == "$$" ]] || return 0
  rm -f "$APPEND_LOCK"
}
# Every exit path releases, including die() and a bare `return 0` from the
# duplicate check — a lock this script forgets to drop stalls every later
# append by the full wait above.
trap append_lock_release EXIT

lock_holder() {
  local owner
  owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -n "$owner" ]] && pid_alive "$owner"; then
    printf '%s' "$owner"
  fi
}

# Who a claim belongs to. NOT this invocation: merge-queue.sh exits in
# milliseconds, and stamping its own pid would make every claim look
# abandoned to the next reader. The owner is the train — the merge-lock
# holder — and, when a claim happens outside the lock, the shell that called
# us, which is the longest-lived process we can honestly name.
claimant_pid() {
  local holder
  holder="$(lock_holder)"
  if [[ -n "$holder" ]]; then
    printf '%s' "$holder"
  else
    printf '%s' "$PPID"
  fi
}

# The ref a queued branch IS, for every purpose in this script: origin's copy,
# never the local one. A branch that is not pushed cannot have been reviewed,
# and a local ref that is ahead of origin points at a commit no reviewer saw —
# pinning it would let an unpushed amend ride a train under a review that was
# never given, silently and in the dangerous direction. Nothing here fetches,
# so "origin" means this checkout's last-known origin; `append` additionally
# refuses when the local ref disagrees, which is the case that catches a
# remote-tracking ref too stale to trust.
branch_ref() {
  local b="$1"
  if git rev-parse -q --verify "refs/remotes/origin/$b^{commit}" >/dev/null 2>&1; then
    printf 'refs/remotes/origin/%s' "$b"
  fi
}

# True when a ref already landed. Both mains are consulted: local main lags
# origin/main on every box that is not the one merging, and a branch that landed
# elsewhere must not be handed to a train as a no-op merge.
already_in_main() {
  local ref="$1" m
  for m in refs/heads/main refs/remotes/origin/main; do
    git rev-parse -q --verify "$m^{commit}" >/dev/null 2>&1 || continue
    git merge-base --is-ancestor "$ref" "$m" 2>/dev/null && return 0
  done
  return 1
}

# Prints the worktree parking an unfinished merge, if any. The queue is
# common-dir state shared by every worktree, so a worktree-local MERGE_HEAD
# check would pass vacuously for a train merging in a sibling tree.
merging_tree() {
  local d gitdir tree
  if [[ -e "$GITDIR/MERGE_HEAD" ]]; then
    tree="${GITDIR%/.git}"
    [[ "$tree" != "$GITDIR" ]] || tree="$GITDIR"
    printf '%s' "$tree"
    return 0
  fi
  for d in "$GITDIR"/worktrees/*; do
    [[ -d "$d" ]] || continue
    [[ -e "$d/MERGE_HEAD" ]] || continue
    gitdir="$(cat "$d/gitdir" 2>/dev/null || true)"
    tree="${gitdir%/.git}"
    printf '%s' "${tree:-$d}"
    return 0
  done
}

# Finds a live (pending or claimed) entry for a branch; prints its path.
find_entry() {
  local branch="$1" dir f
  for dir in "$PENDING" "$CLAIMED"; do
    while IFS= read -r f; do
      [[ -n "$f" ]] || continue
      if [[ "$(entry_field "$f" branch)" == "$branch" ]]; then
        printf '%s' "$f"
        return 0
      fi
    done < <(entries_in "$dir")
  done
}

archive_entry() {
  # $1 = entry path, $2 = result, $3 = reason (may be empty)
  local f="$1" result="$2" reason="${3:-}" base
  base="$(basename "$f")"
  # Rename FIRST, stamp the destination second — the same rule every other state
  # change here follows. Appending to the source path first would recreate it as
  # a three-line stub whenever the entry moved between find_entry and now (a
  # concurrent done/drop, or a claim publishing pending → claimed), and the mv
  # would then land THAT stub in done/ on top of a real archived record while the
  # live entry carried on elsewhere. Losing the rename means someone else already
  # moved it, which is exactly when we must not write anything.
  if ! mv "$f" "$DONE/$base" 2>/dev/null; then
    # A failed archive leaves a resolved entry sitting in claimed/, where the next
    # `claim` re-offers it (and `already_in_main` catches it only once main has
    # moved). Callers print "marked merged" from their own return path, so the
    # only place that can tell the operator otherwise is right here.
    note "WARNING: could not archive $base into done/ — it was moved or resolved by another session; nothing was written, check done/ and claimed/ by hand"
    return 1
  fi
  {
    printf 'result=%s\n' "$result"
    printf 'result_reason=%s\n' "$reason"
    printf 'resolved_at=%s\n' "$(now_iso)"
  } >>"$DONE/$base"
}

cmd_append() {
  local branch="" issue="" text=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --issue) need_value "$@"; issue="$2"; shift 2 ;;
      --issue=*) issue="${1#--issue=}"; shift ;;
      --note) need_value "$@"; text="$2"; shift 2 ;;
      --note=*) text="${1#--note=}"; shift ;;
      --) shift ;;
      -*) die "unknown flag $1 — $USAGE" ;;
      *) [[ -z "$branch" ]] || die "append takes one branch — $USAGE"; branch="$1"; shift ;;
    esac
  done
  [[ -n "$branch" ]] || die "append needs a branch name — $USAGE"

  # A queued branch nobody can resolve is a train failure deferred by hours,
  # so the ref is checked here, where the appender is still around to fix it.
  local ref
  ref="$(branch_ref "$branch")"
  [[ -n "$ref" ]] || die "no such branch on origin: $branch (looked for refs/remotes/origin/$branch) — push it first; an unpushed branch cannot have been reviewed"

  # A local branch ahead of (or beside) origin means the tip this checkout would
  # queue is not the tip a reviewer read. Refusing here is cheap and loud; the
  # alternative is a train integrating an unreviewed commit and nobody noticing.
  local local_sha origin_sha
  if git rev-parse -q --verify "refs/heads/$branch^{commit}" >/dev/null 2>&1; then
    local_sha="$(git rev-parse "refs/heads/$branch")"
    origin_sha="$(git rev-parse "$ref")"
    if [[ "$local_sha" != "$origin_sha" ]]; then
      die "local $branch ($(printf '%.12s' "$local_sha")) and origin/$branch ($(printf '%.12s' "$origin_sha")) disagree — push (or fetch) first; the queue pins what origin has, which is what a reviewer could read"
    fi
  fi

  if already_in_main "$ref"; then
    note "$branch is already merged into main — nothing to queue"
    return 0
  fi

  # Everything from here to the commit rename is one decision — "this branch is
  # not queued, therefore queue it" — and it has to be indivisible. Reading the
  # queue and then writing to it is check-then-act: two appends of one branch in
  # the same instant both read an empty queue and both land, and the loser's
  # orphan is served to a train long after the winner merged.
  #
  # This used to be settled AFTER the commit rename instead: re-scan once both
  # entries are visible and keep the lowest filename. That cannot work, and the
  # reason is worth keeping. The re-scan is not a barrier — the earlier racer
  # can run it before the later one commits, so it sees only itself and stays.
  # And the tiebreak does not order what it claims to: ids are
  # <epoch>-<seq>-<pid>-<slug>, two appends in the same second on an empty queue
  # both compute seq=0, so lowest-filename decides on pid, which has nothing to
  # do with who committed first. Whenever the later committer happened to hold
  # the lower pid, both racers judged themselves the keeper and both stayed —
  # observed under load, not theorised. Ordering after the fact needs an order
  # the filenames do not carry, so the check is made atomic instead and the
  # re-scan is gone.
  #
  # The git checks above stay outside: they are the slow part, they touch
  # nothing another appender can see, and holding a lock across them would make
  # a fetch-stalled appender everyone else's problem.
  append_lock_acquire

  local existing
  existing="$(find_entry "$branch")"
  if [[ -n "$existing" ]]; then
    note "$branch is already queued ($(basename "$existing")) — leaving the existing entry in place"
    return 0
  fi

  # Newline-free: the entry file is line-oriented key=value, and a note is the
  # one field a human types freely.
  issue="$(printf '%s' "$issue" | tr -d '\n\r')"
  text="$(printf '%s' "$text" | tr -d '\n\r')"

  # Entry names ARE the queue order, so they must sort FIFO with second-level
  # clocks: two appends inside one second tie on the epoch, and a pid is not a
  # tiebreak (pid 10001 sorts before pid 9998). A per-second sequence, taken
  # from what is already queued for this second, restores the order; the pid
  # only keeps two genuinely simultaneous appends from picking one filename.
  local epoch seq id tmpfile f pinned_sha
  # Held in a variable rather than inlined below because it is also printed: the
  # ref this resolves is a remote-tracking ref nothing here refreshes, so a
  # stale checkout can pin a sha nobody reviewed. Showing it is what lets the
  # operator catch that at append time, while they still remember the review.
  pinned_sha="$(git rev-parse "$ref")"
  epoch="$(date -u +%s)"
  seq=0
  while IFS= read -r f; do
    if [[ "$(basename "$f")" == "$epoch-"* ]]; then seq=$(( seq + 1 )); fi
  done < <(entries_in "$PENDING")
  while :; do
    id="$(printf '%010d-%03d-%s-%s' "$epoch" "$seq" "$$" "$(slug "$branch")")"
    # done/ counts too: a branch resolved and re-appended inside one second
    # would otherwise regenerate an identical id and the archive rename would
    # overwrite the audit record of the first pass.
    [[ -e "$PENDING/$id.entry" || -e "$TMP/$id.entry" || -e "$DONE/$id.entry" ]] || break
    seq=$(( seq + 1 ))
  done
  tmpfile="$TMP/$id.entry"
  {
    printf 'branch=%s\n' "$branch"
    printf 'ref=%s\n' "$ref"
    printf 'sha=%s\n' "$pinned_sha"
    printf 'issue=%s\n' "$issue"
    printf 'note=%s\n' "$text"
    printf 'appended_at=%s\n' "$(now_iso)"
    printf 'appended_by_pid=%s\n' "$$"
    printf 'appended_by_host=%s\n' "$HOST"
  } >"$tmpfile"
  # The rename is the commit point: before it the entry does not exist for any
  # reader, after it the appender's own fate no longer matters.
  mv "$tmpfile" "$PENDING/$id.entry"
  # Released the instant the entry is visible — the reporting below reads the
  # queue but decides nothing, so no other appender need wait for it.
  append_lock_release

  local holder position
  holder="$(lock_holder)"
  position="$(count_in "$PENDING")"
  if [[ -n "$holder" ]]; then
    printf 'merge-queue: appended %s @ %s to the running train (merge lock held by pid %s); %s branch(es) now pending\n' \
      "$branch" "$pinned_sha" "$holder" "$position"
    printf 'merge-queue: the train picks it up at its next integration boundary — nothing else to do here.\n'
  else
    printf 'merge-queue: appended %s @ %s; %s branch(es) pending, but NO train is running right now\n' \
      "$branch" "$pinned_sha" "$position"
    printf 'merge-queue: start one (scripts/with-merge-lock.sh ...) or the queue just waits for the next coordinator.\n'
  fi
}

cmd_list() {
  local f count=0
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    count=$(( count + 1 ))
    printf 'pending  %-28s %s %s\n' "$(entry_field "$f" branch)" \
      "$(entry_field "$f" issue)" "$(entry_field "$f" appended_at)"
  done < <(entries_in "$PENDING")
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    count=$(( count + 1 ))
    local cpid chost state
    cpid="$(entry_field "$f" claimed_by_pid)"
    chost="$(entry_field "$f" claimed_by_host)"
    state="live"
    if [[ -z "$cpid" || -z "$chost" ]]; then
      # A claim made by this script is stamped before it is visible, so an
      # unstamped entry here came from an older copy of the script (see
      # reclaim_dead). Saying "live" would point a human at a pid that was
      # never written down.
      state="UNSTAMPED claim from an older merge-queue.sh — reclaimed after ${RECLAIM_GRACE_MIN}min"
    elif [[ "$chost" == "$HOST" ]] && ! pid_alive "$cpid"; then
      state="DEAD claimant"
    fi
    printf 'claimed  %-28s %s by pid %s (%s)\n' "$(entry_field "$f" branch)" \
      "$(entry_field "$f" issue)" "$cpid" "$state"
  done < <(entries_in "$CLAIMED")

  # In-flight names are invisible to entries_in by design, which is right for
  # every decision the queue makes and wrong for the one human who has to
  # notice that something is stuck. A transition that is genuinely in flight
  # lives for microseconds; anything a human sees listed here is residue.
  local s name
  for s in "$CLAIMED"/*.entry.reclaiming "$CLAIMED"/*.entry.claiming.*; do
    [[ -e "$s" ]] || continue
    name="$(basename "$s")"
    count=$(( count + 1 ))
    printf 'IN FLIGHT %-28s %s\n' "$(entry_field "$s" branch)" \
      "$name (a transition caught mid-rename; the next \`claim\` finishes or hands it back)"
  done

  [[ "$count" -gt 0 ]] || printf 'merge-queue: queue empty\n'
}

cmd_notify() {
  local pending
  pending="$(count_in "$PENDING")"
  if [[ "$pending" -gt 0 ]]; then
    printf 'merge-queue: %s branch(es) appended by other sessions are waiting — claim them at your\n' "$pending" >&2
    printf 'merge-queue: next integration boundary:  bash scripts/merge-queue.sh claim\n' >&2
    cmd_list >&2 || true
  fi
  return 0
}

# Legacy-only, and deliberately kept: how long an UNSTAMPED claimed entry —
# which only an older copy of this script can produce — is left alone before it
# is handed back. Do not read this as slack for a slow claimant: mtime survives
# rename(2), so a queued entry's mtime is when it was appended, and a branch
# that waited ten minutes in pending/ is "old" the instant it is claimed. That
# is why the unstamped state was removed instead of timed (see CRASH SAFETY);
# the grace remains as the least-bad handling of an entry left by a checkout
# still running the old code.
RECLAIM_GRACE_MIN=5

# Finishes a staged return: strips the claim stamp and commits into pending/.
# Idempotent, because it is also the crash-recovery path — the caller may be a
# later run picking up a *.reclaiming file whose owner died.
finish_reclaim() {
  local staged="$1" base="$2" tmpfile
  # Already committed; only the cleanup was interrupted.
  if [[ -e "$PENDING/$base" || -e "$CLAIMED/$base" ]]; then
    rm -f "$staged"
    return 0
  fi
  tmpfile="$TMP/$base.reclaiming.$$"
  # A pending entry must carry no claim stamp: entry_field takes the first
  # match, so a leftover would shadow the next claimant's — the same branch
  # handed out at every boundary, release matching nobody, list stuck on DEAD.
  grep -v '^claimed_' "$staged" >"$tmpfile" 2>/dev/null || true
  [[ -s "$tmpfile" ]] || { rm -f "$tmpfile"; return 1; }
  mv "$tmpfile" "$PENDING/$base" 2>/dev/null || { rm -f "$tmpfile"; return 1; }
  rm -f "$staged"
}

# Moves one claimed entry back to pending. Staged through a name no reader
# globs (*.entry.reclaiming), so the rename still picks exactly one winner and
# an interrupted return is recoverable instead of stranded.
reclaim_entry() {
  local f="$1" base staged
  base="$(basename "$f")"
  staged="$CLAIMED/$base.reclaiming"
  mv "$f" "$staged" 2>/dev/null || return 1
  finish_reclaim "$staged" "$base"
}

recover_staged_reclaims() {
  local s base
  for s in "$CLAIMED"/*.entry.reclaiming; do
    [[ -e "$s" ]] || continue
    base="$(basename "$s")"
    finish_reclaim "$s" "${base%.reclaiming}" || true
  done
}

# The inbound counterpart: hands back a claim that died between its two renames.
# The staging name carries the claimant's host and pid, so this is judged by the
# same rule as a finished claim — same host, pid gone, hand it back — with no
# appeal to file age (which would be meaningless: rename(2) keeps mtime, so an
# entry's mtime is when it was APPENDED, not when it was claimed).
recover_dead_claiming() {
  local s name rest chost cpid base
  for s in "$CLAIMED"/*.entry.claiming.*; do
    [[ -e "$s" ]] || continue
    name="$(basename "$s")"
    rest="${name#*.entry.claiming.}"
    chost="${rest%.*}"
    cpid="${rest##*.}"
    [[ "$cpid" =~ ^[0-9]+$ ]] || continue
    [[ "$chost" == "$HOST" ]] || continue
    pid_alive "$cpid" && continue
    base="${name%.claiming.*}"
    # Reuse the outbound staging name so an interruption here lands in the path
    # recover_staged_reclaims already knows how to finish.
    mv "$s" "$CLAIMED/$base.reclaiming" 2>/dev/null || continue
    if finish_reclaim "$CLAIMED/$base.reclaiming" "$base"; then
      note "reclaimed $(entry_field "$PENDING/$base" branch) — claim from pid $cpid died before it was stamped"
    fi
  done
}

# Returns claimed-but-abandoned entries to pending. Only same-host claims are
# judged: another host's pid number means nothing here.
reclaim_dead() {
  local f cpid chost branch
  recover_staged_reclaims
  recover_dead_claiming
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    branch="$(entry_field "$f" branch)"
    chost="$(entry_field "$f" claimed_by_host)"
    cpid="$(entry_field "$f" claimed_by_pid)"
    if [[ -z "$chost" || -z "$cpid" ]]; then
      # Legacy shape only. A claim by THIS script is stamped before it becomes
      # visible, so an unstamped *.entry in claimed/ can now only have been put
      # there by a pre-two-rename copy of this script running from another
      # worktree — mid-rollout, or a checkout nobody updated. Age is the only
      # signal such an entry carries, and it is a bad one (mtime is the append
      # time, so the grace is usually already spent), which is exactly why the
      # state was removed rather than timed. Waiting the grace out is still the
      # least-wrong thing to do with one: reclaiming it immediately would race
      # the old script's stamp and hand the branch to two trains, the very bug
      # this fixes.
      if [[ -n "$(find "$f" -mmin +"$RECLAIM_GRACE_MIN" 2>/dev/null)" ]] \
         && reclaim_entry "$f"; then
        note "reclaimed ${branch:-$(basename "$f")} — claimed but never stamped (a pre-2026-08 merge-queue.sh claimed this; check for an outdated checkout)"
      fi
      continue
    fi
    [[ "$chost" == "$HOST" ]] || continue
    pid_alive "$cpid" && continue
    if reclaim_entry "$f"; then
      note "reclaimed $branch from dead claimant pid $cpid"
    fi
  done < <(entries_in "$CLAIMED")
}

cmd_claim() {
  local max=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --max) need_value "$@"; max="$2"; shift 2 ;;
      --max=*) max="${1#--max=}"; shift ;;
      --) shift ;;
      *) die "unknown argument $1 — $USAGE" ;;
    esac
  done
  [[ "$max" =~ ^[0-9]+$ ]] || die "--max takes a whole number, got '$max'"

  # The boundary, enforced: a claim mid-merge would grow a union that is
  # already half-integrated, which is exactly the state this handshake exists
  # to keep branches out of. Every worktree on this gitdir counts — they all
  # share the one queue, and the train usually merges in a different tree from
  # the one a claim is issued from.
  local merging
  merging="$(merging_tree)"
  if [[ -n "$merging" ]]; then
    die "an unfinished merge (MERGE_HEAD) is parked in $merging — claim only BETWEEN integrations"
  fi
  [[ -n "$(lock_holder)" ]] || note "WARNING: no live merge-lock holder — the train claiming branches should hold the merge lock"

  reclaim_dead

  local CLAIMANT
  CLAIMANT="$(claimant_pid)"

  local f branch ref taken=0 base staging queued_sha current_sha
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    [[ "$max" -eq 0 || "$taken" -lt "$max" ]] || break
    branch="$(entry_field "$f" branch)"
    # The ref the append pinned, not a fresh guess: if that exact ref is gone,
    # this entry is stale in a way a re-resolution would paper over (a deleted
    # local branch silently becoming origin's, with a different tip, reported
    # as "its tip moved" about a branch that never moved).
    ref="$(entry_field "$f" ref)"
    [[ -n "$ref" ]] || ref="$(branch_ref "$branch")"   # pre-`ref=` entries
    if [[ -z "$ref" ]] || ! git rev-parse -q --verify "$ref^{commit}" >/dev/null 2>&1; then
      # REFUSED, not dropped, for the same reason a moved sha is: "the ref is
      # gone" is one more way of saying this is not what was reviewed, and
      # queued work is not this script's to throw away on that basis. A branch
      # genuinely finished with is removed by a human with `drop`.
      note "REFUSING $branch — the ref it was queued against (${ref:-none}) no longer resolves, so nothing here can be verified against what was reviewed"
      note "  It stays PENDING and will be refused again. To clear it:"
      note "    bash scripts/merge-queue.sh drop $branch --reason ref-gone"
      continue
    fi
    if already_in_main "$ref"; then
      note "$branch is already in main — dropping it from the queue"
      # A lost archive means another session moved this entry first; it has
      # already warned, and either way this train is not taking the branch. Not
      # fatal: one contended entry must not abort a claim over the whole queue.
      archive_entry "$f" merged "already-in-main" || true
      continue
    fi
    # What was reviewed is a sha, not a branch name. A tip that moved after the
    # append was never reviewed, so it is REFUSED rather than integrated — and
    # left pending rather than dropped, because queued work is not this
    # script's to throw away. The refusal repeats at every boundary until a
    # human resolves it, which is the point: it is not losable by inattention.
    queued_sha="$(entry_field "$f" sha)"
    current_sha="$(git rev-parse "$ref" 2>/dev/null || true)"
    if [[ -n "$queued_sha" && -n "$current_sha" && "$queued_sha" != "$current_sha" ]]; then
      note "REFUSING $branch — its tip moved after it was appended, so what is queued was never reviewed"
      note "  appended: $queued_sha"
      note "  now:      $current_sha"
      note "  It stays PENDING and will be refused again. Once the new tip is reviewed:"
      note "    bash scripts/merge-queue.sh drop $branch --reason sha-moved"
      note "    bash scripts/merge-queue.sh append $branch --issue $(entry_field "$f" issue)"
      continue
    fi
    base="$(basename "$f")"
    staging="$CLAIMED/$base.claiming.$HOST.$$"
    # Exactly one process can win this rename, so two trains claiming at the
    # same moment split the queue instead of both integrating a branch. It
    # lands on a name no reader globs: the entry becomes visible only in the
    # second rename below, already stamped, so no reader ever sees a claim it
    # has to date to interpret.
    mv "$f" "$staging" 2>/dev/null || continue
    {
      printf 'claimed_at=%s\n' "$(now_iso)"
      printf 'claimed_by_pid=%s\n' "$CLAIMANT"
      printf 'claimed_by_host=%s\n' "$HOST"
    } >>"$staging"
    # Publication. Nothing can lose this rename — the target name is ours alone
    # until it exists — so an entry in claimed/ is always a stamped entry.
    mv "$staging" "$CLAIMED/$base"
    printf '%s\n' "$branch"
    taken=$(( taken + 1 ))
  done < <(entries_in "$PENDING")
}

resolve_branch() {
  # $1 = branch, $2 = result, $3 = reason
  local branch="$1" result="$2" reason="${3:-}" f
  [[ -n "$branch" ]] || die "$result needs a branch name — $USAGE"
  f="$(find_entry "$branch")"
  [[ -n "$f" ]] || { note "$branch is not in the queue — nothing to resolve"; return 0; }
  # The "marked" line is the operator's receipt, so it is owed only to an
  # archive that actually happened. archive_entry has already said what went
  # wrong; a non-zero exit here is what makes it visible to a caller.
  archive_entry "$f" "$result" "$reason" || return 1
  printf 'merge-queue: %s marked %s\n' "$branch" "$result"
}

cmd_drop() {
  local branch="" reason=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --reason) need_value "$@"; reason="$2"; shift 2 ;;
      --reason=*) reason="${1#--reason=}"; shift ;;
      --) shift ;;
      -*) die "unknown flag $1 — $USAGE" ;;
      *) branch="$1"; shift ;;
    esac
  done
  resolve_branch "$branch" dropped "$(printf '%s' "$reason" | tr -d '\n\r')"
}

cmd_release() {
  local all=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --all) all=1; shift ;;
      --) shift ;;
      *) die "unknown argument $1 — $USAGE" ;;
    esac
  done

  local f released=0 others=0 mine
  mine="$(claimant_pid)"
  recover_staged_reclaims
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    [[ "$(entry_field "$f" claimed_by_host)" == "$HOST" ]] || continue
    if [[ "$all" -eq 0 && "$(entry_field "$f" claimed_by_pid)" != "$mine" ]]; then
      others=$(( others + 1 ))
      continue
    fi
    reclaim_entry "$f" || continue
    released=$(( released + 1 ))
  done < <(entries_in "$CLAIMED")
  printf 'merge-queue: released %s claim(s) back to pending\n' "$released"
  if [[ "$others" -gt 0 ]]; then
    # A claim made under the merge lock is stamped with the TRAIN's pid, so a
    # release issued after the lock is gone matches nothing and used to say so
    # only by printing 0.
    printf 'merge-queue: %s other claim(s) on this host are stamped with a different pid (this run: %s)\n' \
      "$others" "$mine"
    printf 'merge-queue: if that train is finished, hand them all back:  bash scripts/merge-queue.sh release --all\n'
  fi
}

# Operator escape hatch for the case pid liveness gets wrong: a recycled pid,
# or a claimant on a host that is never coming back. `claim` handles dead
# claimants by itself; this is for when it cannot tell.
cmd_reclaim() {
  local branch="" force=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force) force=1; shift ;;
      --) shift ;;
      -*) die "unknown flag $1 — $USAGE" ;;
      *) [[ -z "$branch" ]] || die "reclaim takes one branch — $USAGE"; branch="$1"; shift ;;
    esac
  done
  [[ -n "$branch" ]] || die "reclaim needs a branch name — $USAGE"

  recover_staged_reclaims
  local f cpid chost
  f="$(find_entry "$branch")"
  [[ -n "$f" ]] || die "$branch is not in the queue"
  case "$f" in
    "$PENDING"/*) note "$branch is already pending — nothing to reclaim"; return 0 ;;
  esac
  cpid="$(entry_field "$f" claimed_by_pid)"
  chost="$(entry_field "$f" claimed_by_host)"
  if [[ "$force" -eq 0 && "$chost" == "$HOST" && -n "$cpid" ]] && pid_alive "$cpid"; then
    die "$branch is claimed by pid $cpid, which is still alive on $HOST — reclaiming it now would hand a branch to a second train. Pass --force if that process is not a merge train."
  fi
  reclaim_entry "$f" || die "could not reclaim $branch — something else moved the entry"
  printf 'merge-queue: reclaimed %s back to pending (was claimed by pid %s on %s)\n' \
    "$branch" "${cpid:-<unstamped>}" "${chost:-<unstamped>}"
}

cmd_prune() {
  local f removed=0
  # Resolved entries are an audit trail, not state: a fortnight is long enough
  # to answer "who queued that?" after the fact.
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    if [[ -n "$(find "$f" -mtime +14 2>/dev/null)" ]]; then
      rm -f "$f"; removed=$(( removed + 1 ))
    fi
  done < <(entries_in "$DONE")
  # A tmp file is a half-written append. An hour is far longer than the rename
  # it was seconds away from.
  for f in "$TMP"/*; do
    [[ -e "$f" ]] || continue
    if [[ -n "$(find "$f" -mmin +60 2>/dev/null)" ]]; then
      rm -f "$f"; removed=$(( removed + 1 ))
    fi
  done
  # `.gone.<pid>` scraps are left by an appender killed between the rename and
  # the removal that follows it. Dead owners only: a live owner's scrap may be
  # on its way back to the lock name, and removing that destroys a lock rather
  # than tidying up after one.
  local owner
  for f in "$APPEND_LOCK".gone.*; do
    [[ -e "$f" ]] || continue
    owner="${f##*.}"
    [[ "$owner" =~ ^[1-9][0-9]*$ ]] || continue
    if pid_alive "$owner"; then continue; fi
    rm -f "$f"; removed=$(( removed + 1 ))
  done
  printf 'merge-queue: pruned %s file(s)\n' "$removed"
}

case "$CMD" in
  append) cmd_append "$@" ;;
  list) cmd_list "$@" ;;
  claim) cmd_claim "$@" ;;
  done) resolve_branch "${1:-}" merged "" ;;
  drop) cmd_drop "$@" ;;
  release) cmd_release "$@" ;;
  reclaim) cmd_reclaim "$@" ;;
  notify) cmd_notify "$@" ;;
  prune) cmd_prune "$@" ;;
  -h|--help|help) printf '%s\n' "$USAGE" ;;
  *) die "unknown subcommand '$CMD' — $USAGE" ;;
esac
