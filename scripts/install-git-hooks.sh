#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=scripts/lib/checkout-guard.sh
. "$repo_root/scripts/lib/checkout-guard.sh"
guard_checkout_freshness install-git-hooks.sh

common_dir="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)"
hooks_dir="$common_dir/hooks"
source_dir="$repo_root/scripts/git-hooks"

mkdir -p "$hooks_dir"

for hook in post-checkout pre-commit; do
  source_path="$source_dir/$hook"
  target_path="$hooks_dir/$hook"

  if [[ -e "$target_path" && ! -L "$target_path" ]]; then
    printf 'hooks: refusing to replace non-symlink %s\n' "$target_path" >&2
    exit 1
  fi

  ln -sfn "$source_path" "$target_path"
  printf 'hooks: linked %s -> %s\n' "$target_path" "$source_path"
done
