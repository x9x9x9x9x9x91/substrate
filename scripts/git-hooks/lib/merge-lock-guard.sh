#!/usr/bin/env bash
# merge-lock-guard.sh — refuse a commit on main while another live process
# holds the merge lock.
#
# Sourced by the pre-commit and pre-merge-commit hooks. Both paths matter:
# git runs pre-commit for an ordinary `git commit` (including the one that
# concludes a conflicted merge) and pre-merge-commit for the automatic merge
# commit, so a guard installed on only one of them is a guard with a hole.
#
# The hole it closes: the merge lock (scripts/with-merge-lock.sh) serializes
# merge trains by convention, but a session that never took it can still
# `git commit` straight onto main in .worktrees/_main mid-train. That commit
# becomes an ungated rider on the train's push — push-gated-main.sh catches it
# and aborts, which is correct but leaves the train stalled and the recovery
# (resetting local main back to the gated tip) is a hard reset a session may
# not perform unattended. Refusing the commit is the cheap end of that.
#
# What it does NOT cover: only paths that create a commit run a commit hook, so
# a fast-forward merge, a `git reset --hard`, a `git branch -f main`, and a
# rebase that moves main all advance the ref with no hook firing at all — the
# fast-forward one is a convention gap rather than a bug, since `--no-ff` is
# the mandated merge recipe and it does produce a commit.
#
# The lock's own semantics are mirrored, deliberately, so the two never
# disagree about who holds what:
#   - the lock is the directory <common gitdir>/substrate-merge.lock, and its
#     `pid` file names the holder;
#   - a DEAD holder is not a holder — with-merge-lock steals such a lock with
#     a warning, so this guard lets the commit through rather than wedging
#     every commit on main behind a crashed session's corpse;
#   - a lock with no readable pid is the same unambiguous garbage the lock
#     script treats it as, and is not a refusal either.
#
# The holder's OWN commits must pass: with-merge-lock runs the train's merge
# commit under the lock it holds, so a guard that refused everything would
# break every train. Two independent handshakes say "this commit belongs to
# the holder", and either one is enough:
#   1. the token with-merge-lock exports into the wrapped command's
#      environment (SUBSTRATE_MERGE_LOCK_PID), matched against the pid the
#      lock file actually names — a stale token from an older run names a pid
#      that no longer holds the lock, so it cannot let a foreigner through;
#   2. process ancestry — the holder is an ancestor of this hook. This
#      survives an env-stripping wrapper (`env -i`, a sudo, a Makefile that
#      scrubs the environment) which would lose the token.
#
# Neither alone is reliable: a wrapped command that daemonizes loses the
# ancestry, an env-scrubbing one loses the token. Together they cover both.

# Walks the process tree up from this hook, looking for a given pid. A cap on
# hops keeps a cycle (or a ps that reports nonsense) from spinning forever.
merge_lock_guard_has_ancestor() {
  local target="$1" pid="$$" hops=0
  while [ "$hops" -lt 64 ]; do
    case "$pid" in ''|*[!0-9]*) return 1 ;; esac
    [ "$pid" = "$target" ] && return 0
    [ "$pid" -le 1 ] && return 1
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    hops=$((hops + 1))
  done
  return 1
}

# Exits 1 (refusing the commit) when the merge lock is held by another live
# process and we are on main. Returns 0 in every other case, so a hook can
# call it and carry on with its own checks. Callers other than the commit
# hooks pass what they were about to do ("reset") so the refusal names it;
# with no argument the message keeps its commit wording and recipe.
merge_lock_guard() {
  local action="${1:-commit}" branch common_raw common lock holder

  branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null)" || return 0
  [ "$branch" = "main" ] || return 0

  common_raw="$(git rev-parse --git-common-dir 2>/dev/null)" || return 0
  common="$(cd "$common_raw" 2>/dev/null && pwd -P)" || return 0
  lock="$common/substrate-merge.lock"

  holder="$(cat "$lock/pid" 2>/dev/null || true)"
  case "$holder" in ''|*[!0-9]*) return 0 ;; esac
  kill -0 "$holder" 2>/dev/null || return 0

  [ "${SUBSTRATE_MERGE_LOCK_PID:-}" = "$holder" ] && return 0
  merge_lock_guard_has_ancestor "$holder" && return 0

  if [ "${SUBSTRATE_ALLOW_FOREIGN_MERGE_LOCK:-0}" = "1" ]; then
    printf 'WARNING: %s on main under another session'"'"'s merge lock (pid %s) — override was set.\n' \
      "$action" "$holder" >&2
    return 0
  fi

  printf '%s\n' \
    "ERROR: refusing $action on main — another live process holds the merge lock (pid $holder)." \
    "  lock: $lock" \
    "A merge train is mid-flight there." >&2
  if [ "$action" = commit ]; then
    printf '%s\n' \
      "A commit landing on main now is an ungated" \
      "rider on that train's push: the push aborts, and unwinding it takes a hard reset" \
      "of local main (scripts/drop-rider.sh)." \
      "" \
      "Wait for pid $holder to finish, or route this commit through the lock:" \
      "  scripts/with-merge-lock.sh --wait bash -c 'git commit -m \"docs: …\"'" \
      "Deliberate? Re-run once with SUBSTRATE_ALLOW_FOREIGN_MERGE_LOCK=1." >&2
  else
    # No override hint off the commit path. A refused commit is a thing you can
    # reasonably decide to force; a refused reset is a hard reset of local main
    # under someone else's live train, and printing the escape hatch next to
    # that refusal reads as a sanctioned recovery step. The variable still
    # works if a human reaches for it deliberately — it just is not offered.
    printf '%s\n' \
      "Wait for pid $holder to release the lock, then re-run." >&2
  fi
  exit 1
}
