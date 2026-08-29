#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
pre_commit="$repo_root/scripts/git-hooks/pre-commit"
post_checkout="$repo_root/scripts/git-hooks/post-checkout"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/substrate-hooks.XXXXXX")"
primary="$scratch/primary"
linked="$scratch/linked"
trap 'rm -rf "$scratch"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

git init -q -b main "$primary"
git -C "$primary" config user.name "Hook Test"
git -C "$primary" config user.email "hooks@example.test"
printf 'base\n' >"$primary/file.txt"
git -C "$primary" add file.txt
git -C "$primary" commit -qm "initial"
initial="$(git -C "$primary" rev-parse HEAD)"
ln -s "$pre_commit" "$primary/.git/hooks/pre-commit"
ln -s "$post_checkout" "$primary/.git/hooks/post-checkout"

git -C "$primary" checkout -q --detach
printf 'blocked\n' >>"$primary/file.txt"
git -C "$primary" add file.txt
if git -C "$primary" commit -qm "detached blocked" >"$scratch/blocked.out" 2>&1; then
  fail "detached commit in primary checkout was allowed"
fi
grep -Fq "refusing commit on detached HEAD" "$scratch/blocked.out" ||
  fail "detached commit did not print the guard message"
printf 'ok: detached commit in primary was blocked\n'

SUBSTRATE_ALLOW_DETACHED=1 git -C "$primary" commit -qm "detached allowed"
printf 'ok: detached commit escape hatch was allowed\n'

git -C "$primary" worktree add -q "$linked" main
printf 'linked\n' >>"$linked/file.txt"
git -C "$linked" add file.txt
git -C "$linked" commit -qm "linked allowed"
printf 'ok: commit in linked worktree was allowed\n'

git -C "$primary" update-ref refs/remotes/origin/main refs/heads/main
checkout_output="$(git -C "$primary" checkout --detach "$initial" 2>&1)"
printf '%s\n' "$checkout_output" | grep -Fq \
  "WARNING: primary checkout detached HEAD is 1 commit(s) behind origin/main" ||
  fail "post-checkout did not warn about the stale detached HEAD"
printf 'ok: post-checkout warned when primary was behind origin/main\n'

# A fresh worktree is where a bare `cargo build` used to write its own
# src-tauri/target, so post-checkout pins the tree at creation.
mkdir -p "$linked/scripts/lib" "$linked/src-tauri"
cp "$repo_root/scripts/lib/cargo-target.sh" "$linked/scripts/lib/cargo-target.sh"
: >"$linked/src-tauri/Cargo.toml"
git -C "$linked" add scripts/lib/cargo-target.sh src-tauri/Cargo.toml
git -C "$linked" commit -qm "cargo target lib"
pinned="$scratch/pinned"
# -u CARGO_TARGET_DIR: a gate run exports one, and the pin deliberately
# declines to write an ad-hoc override into a checkout.
env -u CARGO_TARGET_DIR XDG_CACHE_HOME="$scratch/cache" \
  git -C "$primary" worktree add -q "$pinned" -b pinned-branch main
[[ -f "$pinned/.cargo/config.toml" ]] ||
  fail "post-checkout did not pin the new worktree's cargo target dir"
grep -Fq "target-dir = \"$scratch/cache/substrate-cargo-target\"" "$pinned/.cargo/config.toml" ||
  fail "pinned config does not point at the shared cache"
printf 'ok: post-checkout pinned a new worktree to the shared cargo target dir\n'
