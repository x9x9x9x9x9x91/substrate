#!/usr/bin/env bash
# push-gated-main.sh — push the sha the gates passed, never whatever main
# happens to point at now.
#
# Usage: scripts/push-gated-main.sh [--remote NAME] <gated-sha>
#   e.g. scripts/with-merge-lock.sh bash -c '
#          git merge --no-ff sub/foo &&
#          GATED=$(git rev-parse HEAD) &&
#          <run the gate suite on "$GATED"> &&
#          scripts/push-gated-main.sh "$GATED"'
#
# The hole this closes, from the 2026-08-04 drain: batch B12 gated green at
# d11d6294, and between the gate run and the push a DIFFERENT session
# committed docs straight onto main in .worktrees/_main. The batch then ran
# `git push origin main` — which pushes whatever main resolves to AT PUSH
# TIME — so the ungated commit rode along. Nothing was broken that night;
# nothing would have stopped it either.
#
# Two things went wrong and this script fixes both:
#
#   1. The push named a BRANCH, not a commit. Naming the gated sha
#      explicitly (`git push origin <sha>:refs/heads/main`) means the tree
#      that ships is byte-for-byte the tree the gates ran on, even if main
#      moves a millisecond later.
#   2. The divergence was SILENT. A rider is a real event — somebody's
#      ungated work is sitting on main — so it aborts loudly and names the
#      commits instead of quietly shipping them.
#
# The merge lock (scripts/with-merge-lock.sh) serializes merges by
# convention; it cannot stop a plain `git commit` from a session that never
# took it. This script is the backstop for exactly that case: whatever
# happened to main, only the gated commit leaves this machine.
#
# Exit codes: 0 pushed (or already up to date), 1 refused / push failed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/checkout-guard.sh
. "$SCRIPT_DIR/lib/checkout-guard.sh"
guard_checkout_freshness push-gated-main.sh

REMOTE=origin
GATED_ARG=""

usage() {
  printf 'usage: %s [--remote NAME] <gated-sha>\n' "${0##*/}" >&2
}

# An empty remote name, or one shaped like a flag, means the caller's quoting
# went wrong — `--remote --help` would otherwise swallow the next option as
# the remote. Say so here rather than letting git report it three steps later.
check_remote_value() {
  case "$1" in
    "")
      printf 'push-gated-main: --remote needs a non-empty value.\n' >&2
      exit 1
      ;;
    -*)
      printf 'push-gated-main: --remote value "%s" looks like an option, not a remote.\n' "$1" >&2
      exit 1
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)
      [[ $# -ge 2 ]] || { printf 'push-gated-main: --remote needs a value\n' >&2; exit 1; }
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
      printf 'push-gated-main: unknown option: %s\n' "$1" >&2
      usage
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

if [[ $# -gt 0 ]]; then
  GATED_ARG="$1"
  shift
fi

if [[ -z "$GATED_ARG" || $# -gt 0 ]]; then
  printf 'push-gated-main: exactly one gated sha is required.\n' >&2
  printf '  Pass the sha the gates actually ran on — the one you ran the gate\n' >&2
  printf '  suite against. Not HEAD, not "main".\n' >&2
  usage
  exit 1
fi

refuse_moving_name() {
  printf 'push-gated-main: refusing to push "%s" — that is a moving name, not a gated commit.\n' "$GATED_ARG" >&2
  printf '  Capture the sha BEFORE the gates run and pass that:\n' >&2
  printf '      GATED=$(git rev-parse HEAD)\n' >&2
  printf '      run the gate suite on "$GATED"\n' >&2
  printf '      scripts/push-gated-main.sh "$GATED"\n' >&2
  exit 1
}

# A gated commit has exactly one honest spelling: its object name. Every other
# spelling — `main`, `HEAD`, `@`, `heads/main`, a tag, `main@{0}`, `main^{0}`,
# `refs/heads/main^{commit}` — is re-resolved every time git reads it, which
# is the whole defect this script exists to close. A refusal by spelling alone
# missed the last four; require a hex object name instead, and keep the
# symbolic check as a second net for a ref that happens to be hex-shaped.
if [[ ! "$GATED_ARG" =~ ^[0-9a-fA-F]{4,40}$ ]]; then
  refuse_moving_name
fi
if [[ "$(git rev-parse -q --symbolic-full-name "$GATED_ARG" 2>/dev/null || true)" == "refs/heads/main" ]]; then
  refuse_moving_name
fi

GATED="$(git rev-parse -q --verify "${GATED_ARG}^{commit}" 2>/dev/null || true)"
if [[ -z "$GATED" ]]; then
  printf 'push-gated-main: %s is not a commit in this repository.\n' "$GATED_ARG" >&2
  exit 1
fi

LOCAL_MAIN="$(git rev-parse -q --verify 'refs/heads/main^{commit}' 2>/dev/null || true)"
if [[ -z "$LOCAL_MAIN" ]]; then
  printf 'push-gated-main: no local refs/heads/main to check the gated sha against.\n' >&2
  exit 1
fi

# The loud abort. main moved between gating and pushing, so SOMETHING is on
# main that no gate ever saw (or the merge that was gated has been undone).
if [[ "$LOCAL_MAIN" != "$GATED" ]]; then
  {
    printf '\n'
    printf '======================= UNGATED COMMITS ON main ========================\n'
    printf 'push-gated-main: REFUSING TO PUSH.\n'
    printf 'push-gated-main: gates ran on %s\n' "$(git rev-parse --short "$GATED")"
    printf 'push-gated-main: local main is now %s\n' "$(git rev-parse --short "$LOCAL_MAIN")"
    if git merge-base --is-ancestor "$GATED" "$LOCAL_MAIN" 2>/dev/null; then
      local_ahead="$(git rev-list --count "$GATED..$LOCAL_MAIN" 2>/dev/null || printf '?')"
      printf 'push-gated-main: %s commit(s) landed on main AFTER the gate run:\n' "$local_ahead"
      git log --no-decorate --format='push-gated-main:   %h %an  %s' -n 10 "$GATED..$LOCAL_MAIN" 2>/dev/null || true
      printf 'push-gated-main:\n'
      printf 'push-gated-main: `git push origin main` would have shipped those as an\n'
      printf 'push-gated-main: ungated rider (the 2026-08-04 B12 case, SUB-1070).\n'
      printf 'push-gated-main:\n'
      printf 'push-gated-main: Re-gate the new tip and push THAT, or move the rider\n'
      printf 'push-gated-main: onto a branch and reset main back to the gated sha.\n'
      printf 'push-gated-main: Whoever wrote it must hold the merge lock (AGENTS.md).\n'
    elif git merge-base --is-ancestor "$LOCAL_MAIN" "$GATED" 2>/dev/null; then
      printf 'push-gated-main: main is BEHIND the gated sha — it was reset or\n'
      printf 'push-gated-main: re-created after the gate run. Nothing is safe to push.\n'
    else
      printf 'push-gated-main: main and the gated sha have DIVERGED — main was\n'
      printf 'push-gated-main: rewritten under this run. Nothing is safe to push.\n'
    fi
    printf '========================================================================\n'
  } >&2
  exit 1
fi


# Ask the REMOTE, not the local tracking ref. `refs/remotes/<remote>/main` is
# a cache: if it is stale-equal — the remote was rewound, or a previous run
# wrote it and its push was later undone — trusting it reports "nothing to
# push" for a commit that never shipped, which reads as success in a train.
REMOTE_MAIN="$(git ls-remote --heads "$REMOTE" main 2>/dev/null | awk 'NR==1 {print $1}')"
if [[ -n "$REMOTE_MAIN" && "$REMOTE_MAIN" == "$GATED" ]]; then
  printf 'push-gated-main: %s/main is already at %s — nothing to push.\n' \
    "$REMOTE" "$(git rev-parse --short "$GATED")"
  exit 0
fi

# Push the COMMIT, not the branch name. If main moves after this line, the
# remote still gets exactly the gated tree.
printf 'push-gated-main: pushing gated %s -> %s/main\n' "$(git rev-parse --short "$GATED")" "$REMOTE"
git push "$REMOTE" "${GATED}:refs/heads/main"
status=$?
if (( status != 0 )); then
  printf 'push-gated-main: push failed (exit %s). Nothing shipped.\n' "$status" >&2
  printf '  A non-fast-forward here means %s/main moved — fetch, re-gate the\n' "$REMOTE" >&2
  printf '  new tip, and push that. Do NOT force.\n' >&2
  exit 1
fi
exit 0
