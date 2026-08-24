#!/usr/bin/env bash
# drop-rider.sh — the sanctioned way to unwind rider commits from local main.
#
# Usage: scripts/drop-rider.sh [--remote NAME] <target-sha>
#   e.g. scripts/drop-rider.sh 0c28ecde5
#
# The case this exists for: push-gated-main.sh refused a landing because local
# main carries commits ABOVE the sha the gates ran on — someone committed
# straight onto main in .worktrees/_main while a train was mid-flight. The
# push is safe (only the gated commit ever leaves the machine), but the train
# stays stalled until local main is put back onto the gated tip, and that is a
# `git reset --hard` — a command an unattended session is not allowed to run
# free-hand, for good reason. So the reset lives here, behind guards that make
# the only reachable outcome the narrow one: local main lands exactly on a
# commit that origin already has (or that sits above it), with nothing else
# lost.
#
# <target-sha> is an object name, full or abbreviated — resolved here, so a
# stalled landing can hand over the short sha it recorded. Any rev git accepts
# works; what gets reset to is the sha it resolved to at THIS moment, printed
# before anything moves.
#
# Every guard below is checked BEFORE the reset, and each refusal names the
# one condition that failed:
#   (a) the target resolves, and is an ancestor of (or equal to) local main —
#       otherwise this is not a rider drop, it is a rewrite;
#   (b) after a fresh `git fetch`, the target is a descendant of (or equal to)
#       origin/main — resetting BELOW what origin already published would put
#       the local branch behind the published history;
#   (c) the worktree is clean and no merge is parked (MERGE_HEAD) — a hard
#       reset would take uncommitted work with it;
#   (d) we are on branch main, attached — the _main worktree, not a feature
#       branch and not a detached primary checkout;
#   (e) nobody ELSE is mid-train — the same merge-lock guard the commit hooks
#       run: a hard reset of main under a foreign live lock rewinds the
#       train's merge out from under it. The holder's own recovery passes
#       (token/ancestry), which is exactly the sanctioned case: the stalled
#       train unwinding a rider abort it hit itself.
#
# The commits coming off main are printed first, and put on a branch named
# rescue/riders-<UTC stamp> pointing at the old tip BEFORE the reset runs —
# they are somebody's work, and a printed suggestion to save them is not the
# same as saving them. A rescue branch that cannot be created refuses the
# reset, so there is no path here that makes a commit unreachable.
#
# Guard (e) is asked twice: once up front, and again as the last step before
# the reset. The fetch in guard (b) is a network-sized window in which another
# session can take the merge lock, and a reset of main under a train that
# started meanwhile is the case the guard exists for. The sanctioned wrapped
# invocation holds the lock across the whole recovery instead:
#   scripts/with-merge-lock.sh --wait bash -c 'scripts/drop-rider.sh <sha>'
#
# Exit codes: 0 reset (or already at the target), 1 refused.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/checkout-guard.sh
. "$SCRIPT_DIR/lib/checkout-guard.sh"
guard_checkout_freshness drop-rider.sh

REMOTE=origin
TARGET_ARG=""

usage() {
  printf 'usage: %s [--remote NAME] <target-sha>\n' "${0##*/}" >&2
}

die() {
  printf 'drop-rider: %s\n' "$1" >&2
  exit 1
}

check_remote_value() {
  case "$1" in
    "") die "--remote needs a non-empty value." ;;
    -*) die "--remote value \"$1\" looks like an option, not a remote." ;;
  esac
  # A configured remote NAME only — git would accept a raw URL here, and a
  # caller-chosen URL would let the published-tip comparison run against an
  # arbitrary repository instead of where main actually publishes.
  git remote get-url "$1" >/dev/null 2>&1 \
    || die "--remote \"$1\" is not a configured remote of this repository."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)
      [[ $# -ge 2 ]] || die "--remote needs a value"
      check_remote_value "$2"
      REMOTE="$2"
      shift 2
      ;;
    --remote=*)
      check_remote_value "${1#--remote=}"
      REMOTE="${1#--remote=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      printf 'drop-rider: unknown option: %s\n' "$1" >&2
      usage
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

if [[ $# -gt 0 ]]; then
  TARGET_ARG="$1"
  shift
fi

if [[ -z "$TARGET_ARG" || $# -gt 0 ]]; then
  printf 'drop-rider: exactly one target sha is required.\n' >&2
  printf '  Pass the commit local main should end up on — the sha the gates ran on.\n' >&2
  usage
  exit 1
fi

# (d) branch main, attached. Checked first: every other guard reads "local
# main" as the thing being moved, and on a feature branch that reading is
# already wrong.
BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ -z "$BRANCH" ]]; then
  die "guard (d) failed: HEAD is detached. Run this in the main worktree (.worktrees/_main), on branch main."
fi
if [[ "$BRANCH" != "main" ]]; then
  die "guard (d) failed: on branch '$BRANCH', not main. Only local main's riders are dropped here — a feature branch is its owner's to rewind."
fi

# (e) the merge lock: the same guard the commit hooks run, refusing while a
# foreign live process holds it; the holder's own recovery passes through.
# Unlike the hooks, a missing guard must REFUSE here — falling open past a
# failed source would put the hard reset behind the weakest check of all.
GUARD_LIB="$SCRIPT_DIR/git-hooks/lib/merge-lock-guard.sh"
[[ -r "$GUARD_LIB" ]] || die "guard (e) failed: cannot read $GUARD_LIB — this checkout is missing the merge-lock guard, so nothing was reset."
# shellcheck source=scripts/git-hooks/lib/merge-lock-guard.sh
. "$GUARD_LIB"
merge_lock_guard "reset"

LOCAL_MAIN="$(git rev-parse -q --verify 'refs/heads/main^{commit}' 2>/dev/null || true)"
[[ -n "$LOCAL_MAIN" ]] || die "no local refs/heads/main to move."

# (a) resolves, and is at or below local main.
TARGET="$(git rev-parse -q --verify "${TARGET_ARG}^{commit}" 2>/dev/null || true)"
if [[ -z "$TARGET" ]]; then
  die "guard (a) failed: '$TARGET_ARG' is not a commit in this repository. Pass more characters of the sha, or fetch first."
fi
if ! git merge-base --is-ancestor "$TARGET" "$LOCAL_MAIN" 2>/dev/null; then
  die "guard (a) failed: $(git rev-parse --short "$TARGET") is not an ancestor of local main ($(git rev-parse --short "$LOCAL_MAIN")) — that is a rewrite, not a rider drop."
fi

# (c) nothing uncommitted, no parked merge. Untracked files survive a hard
# reset untouched, so they are not counted here.
if [[ -e "$(git rev-parse --absolute-git-dir)/MERGE_HEAD" ]]; then
  die "guard (c) failed: an unfinished merge (MERGE_HEAD) is parked in this tree — conclude or abort it first."
fi
DIRTY="$(git status --porcelain --untracked-files=no 2>/dev/null || true)"
if [[ -n "$DIRTY" ]]; then
  {
    printf 'drop-rider: guard (c) failed: the worktree has uncommitted changes; a hard reset would take them with it.\n'
    printf '%s\n' "$DIRTY" | sed 's/^/drop-rider:   /'
  } >&2
  exit 1
fi

# (b) at or above what origin publishes — asked fresh, because the local
# tracking ref is a cache and the whole point is to not fall behind a main
# that moved while this recovery was being decided.
if ! git fetch -q "$REMOTE" main 2>/dev/null; then
  die "guard (b) failed: could not fetch $REMOTE main — the published tip is unknown, so nothing here is safe to reset to."
fi
REMOTE_MAIN="$(git rev-parse -q --verify FETCH_HEAD^{commit} 2>/dev/null || true)"
[[ -n "$REMOTE_MAIN" ]] || die "guard (b) failed: $REMOTE has no main to compare against."
if ! git merge-base --is-ancestor "$REMOTE_MAIN" "$TARGET" 2>/dev/null; then
  die "guard (b) failed: $(git rev-parse --short "$TARGET") is not at or above $REMOTE/main ($(git rev-parse --short "$REMOTE_MAIN")) — resetting there would put local main behind published history."
fi

if [[ "$TARGET" == "$LOCAL_MAIN" ]]; then
  printf 'drop-rider: local main is already at %s — nothing to drop.\n' "$(git rev-parse --short "$TARGET")"
  exit 0
fi

# The clean-tree check and the tip were read before the fetch above opened a
# network-sized window — re-read both here, before anything is announced or
# moved, so nothing that appeared meanwhile is taken by the reset.
[[ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]] \
  || die "the worktree changed while the guards ran — nothing was reset; re-run."
[[ "$(git rev-parse -q --verify 'refs/heads/main^{commit}' 2>/dev/null)" == "$LOCAL_MAIN" ]] \
  || die "local main moved while the guards ran — nothing was reset; re-run."

DROPPED="$(git rev-list --count "$TARGET..$LOCAL_MAIN" 2>/dev/null || printf '?')"

# (e) again, as the last thing before anything is created or moved. The first
# call ran before the fetch above, and a fetch is a network-sized window in
# which another session can claim the lock and start a train; resetting main
# out from under it is exactly what guard (e) exists to refuse. Everything
# between here and the reset is local and takes milliseconds.
merge_lock_guard "reset"

# The riders are put on a branch BEFORE the reset, so this tool never makes a
# commit unreachable — it moves main and leaves the old tip named. A branch
# that cannot be created is a refusal, not a warning: the whole point is that
# the reset below has nothing left to destroy.
RESCUE="rescue/riders-$(date -u +%Y%m%dT%H%M%SZ)"
git branch "$RESCUE" "$LOCAL_MAIN" >/dev/null 2>&1 \
  || die "could not create the rescue branch $RESCUE at $(git rev-parse --short "$LOCAL_MAIN") — nothing was reset, so the riders are still on main."

{
  printf '\n'
  printf '========================= DROPPING RIDERS FROM main ====================\n'
  printf 'drop-rider: local main %s -> %s\n' \
    "$(git rev-parse --short "$LOCAL_MAIN")" "$(git rev-parse --short "$TARGET")"
  printf 'drop-rider: %s commit(s) come off main:\n' "$DROPPED"
  git log --no-decorate --format='drop-rider:   %h %an  %s' "$TARGET..$LOCAL_MAIN" 2>/dev/null || true
  printf 'drop-rider:\n'
  printf 'drop-rider: they are kept on a branch — nothing here becomes unreachable:\n'
  printf 'drop-rider:   %s -> %s\n' "$RESCUE" "$(git rev-parse --short "$LOCAL_MAIN")"
  printf '========================================================================\n'
} >&2

git reset --hard "$TARGET" || die "the reset itself failed — local main is unchanged at $(git rev-parse --short "$LOCAL_MAIN")."

printf 'drop-rider: local main is now %s (dropped %s commit(s); they are on %s).\n' \
  "$(git rev-parse --short "$TARGET")" "$DROPPED" "$RESCUE"
