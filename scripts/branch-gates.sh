#!/usr/bin/env bash
# branch-gates.sh — run the branch-level gates the diff can actually affect.
#
# The per-branch gate run exists so a red merge train can name its culprit
# without bisecting at ~an hour per run — and that attribution only needs the
# gates the diff can influence: a Rust-only branch cannot break tsc, and a
# docs-only branch cannot break anything the suite measures (the prose-only
# exception already lets those ride the train). This script generalizes it into a
# diff→gates mapping, so a branch pays for the suites it can plausibly have
# broken and nothing else. The merge train's union run still covers all six
# gates before main moves — nothing lands ungated.
#
# Usage (from the worktree being gated):
#   scripts/branch-gates.sh                    # classify diff vs origin/main, run the subset remotely
#   scripts/branch-gates.sh --local            # ...via with-gates-lock.sh verify-gates.sh instead
#   scripts/branch-gates.sh --print-only       # print the computed subset, run nothing
#   scripts/branch-gates.sh --classify F...    # classify the named paths instead of the git diff
#   scripts/branch-gates.sh --detach --no-wait # unknown flags pass through to the runner
#
# Tiers (first match wins per file; the run is the union over all files, and
# any full-tier file forces all six):
#   docs/**, site/**, root-level *.md   none            inert prose rides the merge train
#   gate/build config (see full list)   full            these shape every gate's meaning
#   src-tauri/**                        cargo,ios,test  `test` kept: the TS↔Rust contract
#                                                       tests (check-ipc and friends) live
#                                                       there; e2e skipped — it drives the
#                                                       vite mock frontend, so no Rust is in
#                                                       that loop at all
#   e2e/**, playwright.config.*         e2e,lint        specs are outside tsc's include
#   src/**                              tsc,test,cargo,e2e,lint
#                                                       cargo: a Rust test reads
#                                                       src/lib/kinds.ts to hold the built-in
#                                                       kind lists in lockstep
#   scripts/**                          tsc,test,lint   tsconfig includes scripts/
#   cookbook/**                         test            the recipe suite walks that tree
#   examples/**                         test,cargo      the example-vault suite parses it and
#                                                       a Rust test opens it as a demo vault
#   CHANGELOG.md                        test            the changelog staleness test reads it
#   anything else                       full            unclassifiable = conservative
#
# Exit: --print-only/--classify exit 0 after printing; otherwise the runner's
# exit code (verify-gates-remote semantics: 75 all-rigs-busy, 76 detached
# no-verdict-yet), or 0 immediately for a docs-only diff.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=scripts/lib/checkout-guard.sh
. "$SCRIPT_DIR/lib/checkout-guard.sh"
guard_checkout_freshness branch-gates.sh

# Canonical gate order (verify-gates.sh): tsc, test, cargo, ios, e2e, lint.
ALL_GATES="tsc test cargo ios e2e lint"

gates_for() { # path -> "none" | "full" | space-separated gate names
  local p="$1"
  # Inert prose is the two doc trees plus root-level *.md. Markdown deeper in
  # the tree is usually DATA, not prose — the seeded vault, the cookbook
  # recipes and the example vault are all read and asserted by suites — so a
  # nested .md falls through to whatever its tree's tier is.
  case "$p" in
    docs/*|site/*) echo none; return ;;
    CHANGELOG.md)  echo test; return ;;
    */*)           ;;
    *.md)          echo none; return ;;
  esac
  case "$p" in
    package.json|package-lock.json|tsconfig.json|tsconfig.node.json|\
    eslint.config.js|vite.config.*|\
    src-tauri/Cargo.toml|src-tauri/Cargo.lock|\
    scripts/verify-gates.sh|scripts/verify-gates-remote.sh|\
    scripts/with-gates-lock.sh|scripts/with-merge-lock.sh|\
    scripts/branch-gates.sh|scripts/lib/*)
      echo full; return ;;
  esac
  case "$p" in
    src-tauri/*)                echo "cargo ios test" ;;
    e2e/*|playwright.config.*)  echo "e2e lint" ;;
    src/*)                      echo "tsc test cargo e2e lint" ;;
    scripts/*)                  echo "tsc test lint" ;;
    cookbook/*)                 echo "test" ;;
    examples/*)                 echo "test cargo" ;;
    *)                          echo full ;;
  esac
}

LOCAL=0
PRINT_ONLY=0
CLASSIFY=0
FILES=()
PASS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)      LOCAL=1; shift ;;
    --print-only) PRINT_ONLY=1; shift ;;
    --classify)   CLASSIFY=1; shift; while [[ $# -gt 0 ]]; do FILES+=("$1"); shift; done ;;
    *)            PASS+=("$1"); shift ;;
  esac
done

if [[ $CLASSIFY -eq 0 ]]; then
  git rev-parse --verify --quiet origin/main >/dev/null || {
    echo "branch-gates: origin/main not found — fetch first" >&2; exit 2
  }
  BASE="$(git merge-base origin/main HEAD)" || {
    echo "branch-gates: no merge-base with origin/main" >&2; exit 2
  }
  while IFS= read -r f; do FILES+=("$f"); done < <(git diff --name-only "$BASE"..HEAD)
  if [[ ${#FILES[@]} -eq 0 ]]; then
    echo "branch-gates: no diff vs origin/main (merge-base ${BASE:0:12}) — nothing to gate"
    exit 0
  fi
fi

# Union the per-file tiers. Plain flag variables, not associative arrays —
# the rigs' /bin/bash is 3.2.
w_tsc=0; w_test=0; w_cargo=0; w_ios=0; w_e2e=0; w_lint=0
FULL=0
for f in "${FILES[@]}"; do
  tier="$(gates_for "$f")"
  printf '  %-18s %s\n' "${tier// /,}" "$f"
  case "$tier" in
    none) ;;
    full) FULL=1 ;;
    *) for g in $tier; do eval "w_$g=1"; done ;;
  esac
done

if [[ $FULL -eq 1 ]]; then
  GATES="${ALL_GATES// /,}"
else
  GATES=""
  for g in $ALL_GATES; do
    eval "on=\$w_$g"
    [[ "$on" -eq 1 ]] && GATES="${GATES:+$GATES,}$g"
  done
fi

if [[ -z "$GATES" ]]; then
  echo "branch-gates: gates = none — inert prose only; gates ride the merge train's union run"
  exit 0
fi
echo "branch-gates: gates = $GATES"

[[ $PRINT_ONLY -eq 1 || $CLASSIFY -eq 1 ]] && exit 0

if [[ $LOCAL -eq 1 ]]; then
  exec "$SCRIPT_DIR/with-gates-lock.sh" "$SCRIPT_DIR/verify-gates.sh" --only "$GATES" ${PASS[@]+"${PASS[@]}"}
fi
exec "$SCRIPT_DIR/verify-gates-remote.sh" --only "$GATES" ${PASS[@]+"${PASS[@]}"}
