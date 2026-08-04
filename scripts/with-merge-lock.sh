#!/usr/bin/env bash
# with-merge-lock.sh — serialize merge→push across parallel sessions.
#
# Ported from a sibling repo's drain_merge.sh, 2026-07-21 audit.
# Usage: scripts/with-merge-lock.sh <command...>
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

[[ $# -ge 1 ]] || die "usage: with-merge-lock.sh <command...>"

GITDIR="$(git rev-parse --path-format=absolute --git-common-dir)" \
  || die "not inside a git repository"

if [[ -e "$(git rev-parse --absolute-git-dir)/MERGE_HEAD" ]]; then
  die "an unfinished merge (MERGE_HEAD) is parked in this tree — conclude or abort it first"
fi
if [[ "${WITH_MERGE_LOCK_IGNORE_STASH:-0}" != "1" && -n "$(git stash list)" ]]; then
  die "stash entries exist (git stash list) — refs/stash is shared across all worktrees (SUB-293); disposition them or set WITH_MERGE_LOCK_IGNORE_STASH=1"
fi

LOCK_DIR="$GITDIR/substrate-merge.lock"

cleanup_lock() { rm -rf "$LOCK_DIR"; }


on_exit() {
  local rc=$?
  cleanup_lock
}

# Signals are routed through EXIT rather than handled separately: bash dying to
# an unhandled signal skips the EXIT trap entirely, which would both leak the
# lock and swallow the verdict.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

acquire() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" >"$LOCK_DIR/pid"
    trap on_exit EXIT
    return 0
  fi
  local owner
  owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -z "$owner" ]]; then
    sleep 1  # the other mkdir may have just won; let its pid write land
    owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  fi
  if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then
    die "another session holds the merge lock (pid $owner, $LOCK_DIR) — merges are serial across sessions; wait and re-run"
  fi
  printf 'with-merge-lock: WARNING: stealing stale lock left by dead pid %s\n' "${owner:-<unknown>}" >&2
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" || die "could not take the merge lock at $LOCK_DIR"
  printf '%s\n' "$$" >"$LOCK_DIR/pid"
  trap on_exit EXIT
}

acquire


status=0
"$@" || status=$?


exit "$status"
