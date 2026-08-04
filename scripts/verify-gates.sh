#!/usr/bin/env bash
# verify-gates.sh — re-run the repo's merge gates and print ACTUAL results.
#
# Handbacks report gate results as prose tables, and a table can be
# affirmatively false (SUB-474: a handback claimed `npm test` pass 825/fail 0
# at a commit whose real result was 824/1). This makes the mandated re-run
# one command, so the verdict step starts from observed numbers.
#
# Run from the worktree whose branch you are adjudicating (any cwd inside it):
#   scripts/verify-gates.sh                    # all five gates
#   scripts/verify-gates.sh --only tsc,lint    # subset while iterating
#   scripts/verify-gates.sh --ref <commit>     # assert HEAD == the claimed commit
#
# Gates (AGENTS.md merge rules): tsc, test, cargo, e2e, lint.
# Exit 0 only if every requested gate passed; per-gate logs are kept in a
# temp dir named at the end for anything that needs a closer look.
set -uo pipefail

# shellcheck source=scripts/lib/checkout-guard.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/checkout-guard.sh"
guard_checkout_freshness verify-gates.sh

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "verify-gates: not inside a git worktree" >&2; exit 2
}
cd "$ROOT"

ONLY="tsc,test,cargo,e2e,lint"
REF=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) [[ $# -ge 2 ]] || { echo "verify-gates: --only needs a value" >&2; exit 2; }
            ONLY="$2"; shift 2 ;;
    --ref)  [[ $# -ge 2 ]] || { echo "verify-gates: --ref needs a value" >&2; exit 2; }
            REF="$2"; shift 2 ;;
    *) echo "verify-gates: unknown arg '$1' (flags: --only tsc,test,cargo,e2e,lint --ref <commit>)" >&2
       exit 2 ;;
  esac
done

for g in ${ONLY//,/ }; do
  case "$g" in tsc|test|cargo|e2e|lint) ;; *)
    echo "verify-gates: unknown gate '$g' (valid: tsc,test,cargo,e2e,lint)" >&2; exit 2 ;;
  esac
done

HEAD_SHA="$(git rev-parse HEAD)"
if [[ -n "$REF" ]]; then
  REF_SHA="$(git rev-parse --verify --quiet "$REF^{commit}")" || {
    echo "verify-gates: --ref '$REF' is not a commit" >&2; exit 2
  }
  if [[ "$REF_SHA" != "$HEAD_SHA" ]]; then
    echo "verify-gates: HEAD is $HEAD_SHA but the claimed commit is $REF_SHA — you are not gating what the handback describes" >&2
    exit 2
  fi
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "verify-gates: tree is dirty — results won't be attributable to $HEAD_SHA" >&2
  exit 2
fi
if [[ ! -x node_modules/.bin/eslint ]]; then
  echo "verify-gates: node_modules incomplete in this worktree — run 'npm ci' first (a fresh worktree ships without deps)" >&2
  exit 2
fi

LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/verify-gates.XXXXXX")"
NAMES=() STATUSES=() SUMMARIES=() TIMES=()
OVERALL=0

# A red gate used to say only "e2e FAIL 91s 1 failed, 707 passed" — never
# WHICH spec (SUB-764), so every red gate cost an ssh into the rig and a grep
# of the per-run log dir. On a red gate we now pull the failing names each
# tool prints, plus its first error line, out of the log we already have.
# Capped deliberately: this is a pointer at the failure, not a log dump — the
# `logs:` line at the end still has everything. Diagnostic only; it runs after
# the gate's rc is captured and never touches it.
FAIL_NAME_CAP=10

print_failure_detail() { # name, log
  local name="$1" log="$2" names="" first="" total shown
  [[ -r "$log" ]] || return 0
  case "$name" in
    tsc)
      names=$(grep -E "error TS[0-9]+" "$log") ;;
    test)
      # node --test: the spec reporter's trailing "✖ failing tests:" block,
      # or, when it emits TAP instead, the "not ok N - <name>" lines.
      names=$(awk '/^✖ failing tests:/ { on = 1; next } on && /^✖ / { print }' "$log")
      [[ -n "$names" ]] || names=$(grep -E "^not ok [0-9]+" "$log")
      first=$(grep -m1 -E "^[[:space:]]+([A-Za-z]+Error|not ok)" "$log") ;;
    cargo)
      # cargo prints "failures:" twice — once heading the per-test stdout
      # dumps, once heading the summary list. Resetting at each header leaves
      # the last block, which is the clean set of names.
      names=$(awk '/^failures:$/ { buf = ""; next }
                   /^[[:space:]]+[A-Za-z_]/ { buf = buf $0 "\n" }
                   END { printf "%s", buf }' "$log")
      first=$(grep -m1 "panicked at" "$log") ;;
    e2e)
      # playwright's numbered failure list: "  1) [chromium] › e2e/x.spec.ts:12:3 › Suite › name ───"
      names=$(grep -E "^[[:space:]]+[0-9]+\) " "$log" | sed 's/[[:space:]]*─*[[:space:]]*$//')
      first=$(grep -m1 -E "^[[:space:]]+(Error:|expect\()" "$log") ;;
    lint)
      # eslint stacks "path" then "  L:C  error  msg  rule"; rejoin them so a
      # name is diagnosable on its own line.
      names=$(awk '/^[^[:space:]]/ { f = $0; next }
                   /^[[:space:]]+[0-9]+:[0-9]+[[:space:]]+error/ { sub(/^[[:space:]]+/, ""); print f ":" $0 }' "$log") ;;
  esac
  names=$(printf '%s' "$names" | sed 's/^[[:space:]]*//' | grep -v '^$' || true)
  [[ -n "$names" ]] || return 0
  total=$(printf '%s\n' "$names" | wc -l | tr -d ' ')
  # Indent per LINE, not per printf arg — one multi-line arg would indent only
  # its first line and leave the rest flush against the summary table.
  shown=$(printf '%s\n' "$names" | head -n "$FAIL_NAME_CAP" | sed 's/^/      /')
  echo "   ↳ $name failures:"
  printf '%s\n' "$shown"
  [[ $total -gt $FAIL_NAME_CAP ]] && echo "      … $((total - FAIL_NAME_CAP)) more (see log)"
  [[ -n "$first" ]] && printf '%s\n' "$(printf '%s' "$first" | sed 's/^[[:space:]]*/      /')"
  return 0
}

run_gate() { # name, command...
  local name="$1"; shift
  local log="$LOGDIR/$name.log" start end rc
  echo "── $name: $*"
  start=$(date +%s)
  "$@" >"$log" 2>&1; rc=$?
  end=$(date +%s)
  local summary
  case "$name" in
    tsc)
      local errs; errs=$(grep -c "error TS" "$log" || true)
      summary=$([[ $rc -eq 0 ]] && echo "clean" || echo "$errs type errors") ;;
    test)
      # node --test TAP summary: "# pass N" / "# fail N" (spec reporter: "ℹ pass N")
      local p f
      p=$(grep -Eo "pass [0-9]+" "$log" | tail -1 | awk '{print $2}')
      f=$(grep -Eo "fail [0-9]+" "$log" | tail -1 | awk '{print $2}')
      summary="pass ${p:-?} / fail ${f:-?}" ;;
    cargo)
      summary=$(grep "^test result:" "$log" | sed 's/^test result: //' | paste -sd '; ' -)
      summary=${summary:-"no test-result line (see log)"} ;;
    e2e)
      summary=$(grep -E "^[[:space:]]*[0-9]+ (passed|failed|flaky|skipped|interrupted)" "$log" \
                | sed 's/^[[:space:]]*//' | paste -sd ', ' -)
      summary=${summary:-"no playwright summary (see log)"} ;;
    lint)
      summary=$([[ $rc -eq 0 ]] && echo "clean" || grep "✖" "$log" | tail -1)
      summary=${summary:-"exit $rc (see log)"} ;;
  esac
  NAMES+=("$name"); TIMES+=("$((end - start))s"); SUMMARIES+=("$summary")
  if [[ $rc -eq 0 ]]; then
    STATUSES+=("PASS")
  else
    STATUSES+=("FAIL"); OVERALL=1
    print_failure_detail "$name" "$log"
  fi
}

# The shared compile cache lives under the CURRENT user's home. The repo's
# .cargo/config.toml has to hardcode one machine's absolute path (cargo config
# expands neither ~ nor env vars), so the gate pins the env override, which
# beats the config on every machine — dev Mac and QA rigs alike (SUB-1014).
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/substrate-cargo-target}"

for g in ${ONLY//,/ }; do
  case "$g" in
    tsc)   run_gate tsc   npx tsc --noEmit ;;
    test)  run_gate test  npm test ;;
    cargo) run_gate cargo cargo test --lib --manifest-path src-tauri/Cargo.toml ;;
    e2e)   run_gate e2e   npm run e2e ;;
    lint)  run_gate lint  npm run lint ;;
  esac
done

echo
echo "verify-gates @ ${HEAD_SHA:0:10} ($(git branch --show-current 2>/dev/null || echo detached))"
for i in "${!NAMES[@]}"; do
  printf "  %-5s  %-4s  %-8s  %s\n" "${NAMES[$i]}" "${STATUSES[$i]}" "${TIMES[$i]}" "${SUMMARIES[$i]}"
done
echo "  logs: $LOGDIR"
exit $OVERALL
