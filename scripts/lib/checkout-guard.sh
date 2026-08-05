#!/usr/bin/env bash
# checkout-guard.sh — refuse to run tooling out of a stale checkout.
#
# Source this from every executable entry point in scripts/. It answers one
# question: is the copy of the code you are about to run the copy main has?
#
# The primary checkout (~/Coding/substrate) is deliberately detached and
# read-mostly, so its scripts/ directory is pinned to whatever commit it was
# parked at — often days behind. Invoking a script through it (the natural
# `../../scripts/foo.sh` from a worktree) silently runs that old code. The
# 2026-07-25 case was loud only by luck: share-mirror.sh's newer bundle-id
# rewrite was missing, so the mirror's own denylist caught the "leak". A
# stale script whose change is permissive instead of restrictive — a new
# private path added to share-exclude.txt, say — would have shipped it.
#
# Bail with SUBSTRATE_ALLOW_STALE_SCRIPTS=1 when running an old script on
# purpose (bisecting, reproducing a past mirror).

# Usage: guard_checkout_freshness <tool-name>
guard_checkout_freshness() {
  local tool=${1:-${0##*/}}
  [ "${SUBSTRATE_ALLOW_STALE_SCRIPTS:-0}" = "1" ] && return 0

  # Locate the tree this FILE came from, not the caller's cwd — that is the
  # tree whose code is about to run.
  local here root
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || return 0
  root=$(git -C "$here" rev-parse --show-toplevel 2>/dev/null) || return 0

  # Only detached checkouts are suspect. A named branch is somebody's work;
  # being behind main there is normal and none of this guard's business.
  git -C "$root" symbolic-ref -q HEAD >/dev/null && return 0

  local head main
  head=$(git -C "$root" rev-parse -q --verify HEAD 2>/dev/null) || return 0
  main=$(git -C "$root" rev-parse -q --verify 'origin/main^{commit}' 2>/dev/null) || return 0
  [ "$head" = "$main" ] && return 0

  if git -C "$root" merge-base --is-ancestor "$head" "$main" 2>/dev/null; then
    printf '%s: refusing to run — this checkout is detached at %s, behind origin/main (%s).\n' \
      "$tool" "$(git -C "$root" rev-parse --short HEAD)" "$(git -C "$root" rev-parse --short "$main")" >&2
    printf '  %s\n' \
      "You are about to run that older copy of scripts/, not main's (SUB-509)." >&2

    local main_tree
    main_tree=$(git -C "$root" worktree list --porcelain 2>/dev/null | awk '
      $1 == "worktree" { path = substr($0, 10) }
      $1 == "branch" && $2 == "refs/heads/main" { print path; exit }
    ')
    if [[ -n "$main_tree" ]]; then
      printf '  %s\n' \
        "Invoke it from the main worktree instead:" \
        "    cd $main_tree && bash scripts/${tool}" >&2
    elif git -C "$root" show-ref --verify --quiet refs/heads/main; then
      printf '  %s\n' \
        "Fresh clone? Bootstrap the read-mostly checkout with:" \
        "    git checkout main" \
        "    npm run hooks:install" \
        "    git checkout --detach origin/main" >&2
    else
      printf '  %s\n' \
        "Create or enter a current main worktree, then run scripts/${tool} there." >&2
    fi
    printf '  %s\n' "Deliberate? Re-run with SUBSTRATE_ALLOW_STALE_SCRIPTS=1." >&2
    exit 1
  fi

  # Detached but NOT an ancestor: some commit off main's line. Can't call it
  # stale, but it isn't main's tooling either — say so and carry on.
  printf '%s: WARNING: running from a detached checkout at %s, which is not on origin/main (%s).\n' \
    "$tool" "$(git -C "$root" rev-parse --short HEAD)" "$(git -C "$root" rev-parse --short "$main")" >&2
}
