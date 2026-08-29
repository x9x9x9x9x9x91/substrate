#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=scripts/lib/checkout-guard.sh
. "$repo_root/scripts/lib/checkout-guard.sh"
guard_checkout_freshness install-git-hooks.sh

common_dir="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)"
hooks_dir="$common_dir/hooks"

# Link from the PRIMARY checkout, not the worktree this ran in. There is one
# hooks dir for every worktree sharing the gitdir, so a link into
# .worktrees/<lane> outlives the lane by exactly as long as it takes someone to
# `git worktree remove` it — after which the link dangles and every worktree's
# hooks are broken at once. The primary checkout is the one tree that is never
# removed. `git worktree list` names it first, by definition.
primary_root="$(git -C "$repo_root" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')"
source_dir="$repo_root/scripts/git-hooks"
if [[ -n "$primary_root" && -d "$primary_root/scripts/git-hooks" ]]; then
  source_dir="$primary_root/scripts/git-hooks"
  if [[ "$primary_root" != "$repo_root" ]]; then
    printf 'hooks: linking from the primary checkout %s (not this worktree — a link into a worktree dangles when it is removed)\n' "$primary_root"
  fi
fi

mkdir -p "$hooks_dir"

hooks=(post-checkout pre-commit pre-merge-commit)

for hook in "${hooks[@]}"; do
  source_path="$source_dir/$hook"
  target_path="$hooks_dir/$hook"

  if [[ -e "$target_path" && ! -L "$target_path" ]]; then
    printf 'hooks: refusing to replace non-symlink %s\n' "$target_path" >&2
    exit 1
  fi

  ln -sfn "$source_path" "$target_path"
  printf 'hooks: linked %s -> %s\n' "$target_path" "$source_path"
done
