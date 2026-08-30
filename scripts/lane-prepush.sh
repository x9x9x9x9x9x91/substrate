#!/usr/bin/env bash
# lane-prepush.sh — the seconds-cheap checks a lane owes before it pushes.
#
# Usage: bash scripts/lane-prepush.sh [--base <ref>]
#   --base <ref>   what "changed" is measured against (default origin/main)
#
# Runs, in order:
#   1. eslint over the files this branch changed
#   2. the comment-vocabulary check (no internal tracker ids in shipped comments)
#   3. the seed byte-twins, when this branch touched either side of them
#
# Why it exists. Both rules already had a gate — lint and check-comment-vocab
# are legs of the full suite — and both were being discovered ~40 minutes into
# a rig run, three times in three days (the friction journal's 2026-08-09 and
# 2026-08-10 entries). A lane verifies typecheck and the mirror check locally
# and pushes; the suite is then the first thing that reads its new files. That
# is a forty-minute round trip for a class of fault that takes seconds to see.
#
# So this is not a new rule. It is the same rules, moved to where a lane
# already stands. No check here needs a build, a rig or a lock.
#
# It deliberately does NOT run as a git hook. Lanes push `wip:` checkpoints on
# purpose — committed history is the resume point — and a hook that refuses
# those trades a forty-minute round trip for lost work. This is a step in the
# pre-push checklist (AGENTS.md), run when a branch is being parked.
#
# eslint is scoped to changed files, not the tree: the tree's warnings are a
# tracked backlog (eslint.config.js), and the fault this catches is always in
# a file the branch just wrote. Deleted files are dropped from the list, and
# only extensions eslint is configured for are passed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
# shellcheck source=scripts/lib/checkout-guard.sh
. "$SCRIPT_DIR/lib/checkout-guard.sh"
guard_checkout_freshness lane-prepush.sh

BASE=origin/main
while [ $# -gt 0 ]; do
  case "$1" in
    --base) shift; BASE=${1:-}; [ -n "$BASE" ] || { echo "lane-prepush: --base needs a ref" >&2; exit 2; } ;;
    -h|--help) sed -n '2,6p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "lane-prepush: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$ROOT"

if ! git rev-parse -q --verify "$BASE^{commit}" > /dev/null; then
  echo "lane-prepush: no such base ref: $BASE" >&2
  echo "  (fetch first, or pass --base <ref> — the changed-file list is measured from it)" >&2
  exit 2
fi

# Three-dot: the files THIS branch changed, not the ones main changed under it.
# Committed work only — an uncommitted edit is not what gets pushed, and the
# checklist runs at parking time when the tree is clean anyway.
CHANGED=$(git diff --name-only --diff-filter=d "$BASE...HEAD" -- \
  '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs')

RC=0

if [ -z "$CHANGED" ]; then
  echo "lane-prepush: eslint — no changed JS/TS files against $BASE, nothing to lint"
else
  COUNT=$(printf '%s\n' "$CHANGED" | wc -l | tr -d ' ')
  echo "lane-prepush: eslint over $COUNT changed file(s) against $BASE"
  # Files are passed as arguments rather than piped, so a path with a space
  # stays one path. `--no-error-on-unmatched-pattern` covers a file that is
  # tracked but sits outside eslint's configured roots.
  if ! printf '%s\n' "$CHANGED" | tr '\n' '\0' \
    | xargs -0 npx eslint --no-error-on-unmatched-pattern --; then
    RC=1
  fi
fi

# Runs even when eslint failed: a lane fixing one of these wants to see both,
# not discover the second on the next pass. The exit code carries both verdicts.
echo "lane-prepush: comment vocabulary"
if ! node scripts/check-comment-vocab.ts; then
  RC=1
fi

# The three agent files the app seeds also ship verbatim in the demo vault, and
# example-vault.test.ts asserts they are byte-identical. That coupling lives
# nowhere a seed-editing lane has a reason to open, so the drift is discovered
# on the rig: a whole suite red on one assertion a `cmp` answers here. Only
# checked when the branch touched a side of it, so the usual lane pays nothing.
TWINS="src-tauri/src/seed/AGENTS.md:examples/vault/AGENTS.md
src-tauri/src/seed/CLAUDE.md:examples/vault/CLAUDE.md
src-tauri/src/seed/setup-skill.md:examples/vault/.claude/skills/setup/SKILL.md"

if [ -n "$(git diff --name-only "$BASE...HEAD" -- src-tauri/src/seed examples/vault)" ]; then
  echo "lane-prepush: seed byte-twins"
  while IFS=: read -r SRC DST; do
    if ! cmp -s "$SRC" "$DST"; then
      echo "lane-prepush: $DST has drifted from $SRC — copy the seed across" >&2
      RC=1
    fi
  done <<TWIN_LIST
$TWINS
TWIN_LIST
fi

if [ "$RC" -ne 0 ]; then
  echo >&2
  echo "lane-prepush: FAILED — fix the above before pushing." >&2
  exit 1
fi

echo "lane-prepush: checks clean"
