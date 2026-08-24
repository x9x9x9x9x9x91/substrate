#!/usr/bin/env bash
# branch-gates.sh — run the branch-level gates the diff can actually affect.
#
# The per-branch gate run exists so a red merge train can name its culprit
# without bisecting at ~an hour per run — and that attribution only needs the
# gates the diff can influence: a Rust-only branch cannot break tsc, and a
# docs-only branch cannot break anything the suite measures (the prose-only
# exception already lets those ride the train). This script generalizes it into a
# diff→gates mapping, so a branch pays for the suites it can plausibly have
# broken and nothing else. The merge train's union run still covers all seven
# gates before main moves — nothing lands ungated.
#
# Usage (from the worktree being gated):
#   scripts/branch-gates.sh                    # classify diff vs origin/main, run the subset remotely
#   scripts/branch-gates.sh --local            # ...via with-gates-lock.sh verify-gates.sh instead
#   scripts/branch-gates.sh --print-only       # print the computed subset, run nothing
#   scripts/branch-gates.sh --classify F...    # classify the named paths instead of the git diff
#   scripts/branch-gates.sh --detach --no-wait # unknown flags pass through to the runner
#   scripts/branch-gates.sh --print-plan --mac-free 0
#                                              # print the single/split plan for an
#                                              #  injected probe answer, run nothing
#
# Tiers (first match wins per file; the run is the union over all files, and
# any full-tier file forces all seven):
#   docs/**, site/**, root-level *.md   none            inert prose rides the merge train
#   gate/build config (see full list)   full            these shape every gate's meaning
#   src-tauri/**                        cargo,ios,test,macsmoke
#                                                       `test` kept: the TS↔Rust contract
#                                                       tests (check-ipc and friends) live
#                                                       there; macsmoke: only Rust diffs can
#                                                       break the cfg(macos) build it
#                                                       certifies; e2e skipped — it drives the
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
# Auto-split on a saturated Mac fleet: `ios` needs the iPhoneOS SDK and
# `macsmoke` needs a Darwin host, so a gate set carrying either excludes the
# Linux rigs by CLASS (verify-gates-remote's class_candidates) — and with every
# Mac busy the whole set became unschedulable, fell back to the local
# with-gates-lock queue with no bound on when it would start, and left the
# Linux fleet idle the entire time (docs/agent-friction.md 2026-08-21). One
# macOS-only leg must not make the other five unschedulable. So when the
# classified set needs a Mac and no Mac is free at probe time, the run is cut
# in two at the host-class line and both legs gate the SAME sha:
#
#   leg A  the linux-servable subset (tsc,test,cargo,e2e,lint) — detached,
#          normal fleet routing, which puts it on the free Linux rigs: class
#          order already prefers them for a set with no mac-only leg, and the
#          Macs are exactly the ones that just probed busy. It lands on a Mac
#          only when no Linux rig is free either, and then leg B just waits for
#          the next one;
#   leg B  the mac-only subset (ios and/or macsmoke) — its own detached leg,
#          retried on a bounded budget until a Mac frees up.
#
# The verdict names BOTH runs and is green only when both are; a leg without a
# verdict is never a pass. The split introduces NO new local-compute path: it
# is off entirely under --local (which is already the local route) and a leg
# that never launches is reported, never run here. Every rig-side decision —
# probing, launching, polling — is verify-gates-remote's own, called as a
# subprocess; this script only decides the cut and reads the two verdicts.
#
#   SUBSTRATE_MAC_LEG_WAIT   seconds to keep hunting a Mac for leg B (default
#                            1800 — longer than a typical Mac gate leg, so a
#                            rig busy now is likely free inside the budget).
#                            A caller that passed --no-wait asked not to block,
#                            so its default is 0: one attempt, then report.
#   SUBSTRATE_MAC_LEG_RETRY  seconds between those attempts (default 60).
#
# Exit: --print-only/--classify/--print-plan exit 0 after printing; otherwise
# the runner's exit code (verify-gates-remote semantics: 75 all-rigs-busy, 76
# detached no-verdict-yet), or 0 immediately for a docs-only diff. Under a
# split those same codes speak for the pair: 0 both legs green, 75 a leg never
# ran, 76 launched with no verdict yet, anything else the failing leg's own.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=scripts/lib/checkout-guard.sh
. "$SCRIPT_DIR/lib/checkout-guard.sh"
guard_checkout_freshness branch-gates.sh

# Canonical gate order (verify-gates.sh): tsc, test, cargo, ios, e2e, lint, macsmoke.
ALL_GATES="tsc test cargo ios e2e lint macsmoke"

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
    src-tauri/*)                echo "cargo ios test macsmoke" ;;
    e2e/*|playwright.config.*)  echo "e2e lint" ;;
    src/*)                      echo "tsc test cargo e2e lint" ;;
    scripts/*)                  echo "tsc test lint" ;;
    cookbook/*)                 echo "test" ;;
    examples/*)                 echo "test cargo" ;;
    *)                          echo full ;;
  esac
}

# ── The split decision ──────────────────────────────────────────────────────
# The gates that need a Darwin host, and therefore the ones a Linux rig can
# never take. Everything else in ALL_GATES is linux-servable, which is what
# makes the cut below a partition rather than a filter.
MAC_ONLY_GATES="ios macsmoke"

# The decision itself: gate subset plus one fact about the fleet, in; a plan,
# out. No git, no ssh, no clock — so --print-plan can hand it an injected probe
# answer and get the same plan the real run would take.
#
# Prints "single" or "split <leg-A> <leg-B>". Three ways a set stays single,
# each a case where splitting buys nothing:
#   - no mac-only gate: the Linux rigs were candidates all along;
#   - a Mac is free right now: the ordinary single run reaches a verdict, and
#     one run beats two whenever it can be had;
#   - nothing BUT mac-only gates: there is no second leg to hand the Linux
#     fleet, so the wait for a Mac is the whole job either way.
split_plan() { # gates-csv mac-free(0|1) -> "single" | "split A B"
  local gates="$1" mac_free="$2" a="" b="" g
  for g in ${gates//,/ }; do
    case " $MAC_ONLY_GATES " in
      *" $g "*) b="${b:+$b,}$g" ;;
      *)        a="${a:+$a,}$g" ;;
    esac
  done
  if [[ -z "$b" || "$mac_free" == "1" || -z "$a" ]]; then echo single; return; fi
  echo "split $a $b"
}

print_plan() { # plan -> the operator-facing plan lines
  # shellcheck disable=SC2086
  set -- $1
  if [[ "$1" == single ]]; then
    echo "branch-gates: plan = single"
    return
  fi
  echo "branch-gates: plan = split"
  echo "branch-gates: leg A (linux-servable) = $2"
  echo "branch-gates: leg B (mac-only) = $3"
}

needs_mac() { # gates-csv -> 0 when the set carries a gate only a Mac can run
  local g
  for g in ${1//,/ }; do
    case " $MAC_ONLY_GATES " in *" $g "*) return 0 ;; esac
  done
  return 1
}

pass_has() { # flag -> 0 when the caller passed it through
  local f
  for f in ${PASS[@]+"${PASS[@]}"}; do [[ "$f" == "$1" ]] && return 0; done
  return 1
}

LOCAL=0
PRINT_ONLY=0
CLASSIFY=0
PRINT_PLAN=0
MAC_FREE=""
FILES=()
PASS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)      LOCAL=1; shift ;;
    --print-only) PRINT_ONLY=1; shift ;;
    # The seam the split decision is tested through: the probe answer comes in
    # as a value instead of from the fleet, so the plan is checkable without a
    # rig anywhere near it.
    --print-plan) PRINT_PLAN=1; shift ;;
    --mac-free)   [[ $# -ge 2 ]] || { echo "branch-gates: --mac-free needs 0 or 1" >&2; exit 2; }
                  MAC_FREE="$2"; shift 2 ;;
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
w_tsc=0; w_test=0; w_cargo=0; w_ios=0; w_e2e=0; w_lint=0; w_macsmoke=0
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

if [[ $PRINT_PLAN -eq 1 ]]; then
  case "$MAC_FREE" in 0|1) ;; *)
    echo "branch-gates: --print-plan needs --mac-free 0|1 — the fleet answer to plan from" >&2
    exit 2 ;;
  esac
  print_plan "$(split_plan "$GATES" "$MAC_FREE")"
  exit 0
fi

[[ $PRINT_ONLY -eq 1 || $CLASSIFY -eq 1 ]] && exit 0

if [[ $LOCAL -eq 1 ]]; then
  exec "$SCRIPT_DIR/with-gates-lock.sh" "$SCRIPT_DIR/verify-gates.sh" --only "$GATES" ${PASS[@]+"${PASS[@]}"}
fi

# ── Running a split ─────────────────────────────────────────────────────────
# Everything below delegates to verify-gates-remote: --pick-only is its probe,
# --detach --no-wait its launcher, --attach its poller. Nothing here reimplements
# rig selection, host classes or locking, so the split can only ever route work
# the same way an ordinary run would.

# "Could not split — run the ordinary way instead." Never an exit code of this
# script: it is the one answer the caller below turns back into the old path.
SPLIT_UNAVAILABLE=70

mac_is_free() { # mac-gates-csv -> 0 a usable Mac | 1 all busy | 2 the probe itself failed
  local rc=0
  # Selection only; the marker line it prints is not a run and must not read
  # like one, so only its reasoning (stderr) reaches the operator.
  "$SCRIPT_DIR/verify-gates-remote.sh" --only "$1" --pick-only >/dev/null || rc=$?
  case $rc in
    0)  return 0 ;;
    75) return 1 ;;
    *)  return 2 ;;
  esac
}

launch_leg() { # gates-csv -> prints the run id | rc 75 nobody free | other launch failure
  local only="$1" log id rc=0
  log="$(mktemp "${TMPDIR:-/tmp}/branch-gates-leg.XXXXXX")" || return 2
  "$SCRIPT_DIR/verify-gates-remote.sh" --only "$only" --ref "$HEAD_SHA" --detach --no-wait \
    ${PASS[@]+"${PASS[@]}"} >"$log" 2>&1 || rc=$?
  cat "$log" >&2
  id="$(sed -n 's/^rig_gates_detached_run=//p' "$log" | tail -n1)"
  rm -f "$log"
  # A launched leg always names itself; the exit code alone cannot say so
  # (--detach --no-wait reaches "launched, no verdict yet" as 76, not 0).
  [[ -n "$id" ]] || return $rc
  printf '%s' "$id"
}

run_split() { # legA legB -> the pair's verdict, or SPLIT_UNAVAILABLE
  local a="$1" b="$2" ida idb rca=0 rcb=0 rc=0 n now wait_budget retry deadline
  echo "branch-gates: every Mac is busy and [$b] needs one — [$a] goes to the fleet that is free and [$b] waits for a Mac, both gating ${HEAD_SHA:0:12}"

  ida="$(launch_leg "$a")" || rc=$?
  if [[ -z "$ida" ]]; then
    echo "branch-gates: no rig took leg A [$a] either (rc $rc) — there is no idle fleet to split onto; running the whole set the ordinary way" >&2
    return $SPLIT_UNAVAILABLE
  fi
  echo "branch-gates: leg A [$a] — rig_gates_detached_run=$ida"

  # A caller that passed --no-wait asked not to block, so it gets one attempt
  # at a Mac rather than the hunting budget.
  wait_budget="${SUBSTRATE_MAC_LEG_WAIT:-}"
  if [[ -z "$wait_budget" ]]; then
    wait_budget=1800
    pass_has --no-wait && wait_budget=0
  fi
  retry="${SUBSTRATE_MAC_LEG_RETRY:-60}"
  # Whole seconds or nothing: a typo'd budget must be a loud refusal, never an
  # arithmetic error that leaves the loop with no deadline to honour.
  for n in "$wait_budget" "$retry"; do
    case "$n" in ''|*[!0-9]*)
      echo "branch-gates: SUBSTRATE_MAC_LEG_WAIT/RETRY must be whole seconds, got '$n' — leg A is gating as $ida (collect: scripts/verify-gates-remote.sh --attach $ida)" >&2
      return 2 ;;
    esac
  done
  deadline=$(( $(date +%s) + wait_budget ))
  while :; do
    rcb=0
    idb="$(launch_leg "$b")" || rcb=$?
    [[ -n "$idb" ]] && break
    if [[ $rcb -ne 75 ]]; then
      echo "branch-gates: leg B [$b] could not launch (rc $rcb) — leg A is still gating as $ida; collect it with scripts/verify-gates-remote.sh --attach $ida" >&2
      return $rcb
    fi
    now="$(date +%s)"
    if [[ $now -ge $deadline ]]; then
      echo "branch-gates: no Mac freed up for leg B [$b] within ${wait_budget}s — leg A [$a] is still gating as $ida (collect: scripts/verify-gates-remote.sh --attach $ida). Leg B never ran, so this is NOT a pass; re-run for [$b] once a Mac is free." >&2
      return 75
    fi
    echo "branch-gates: every Mac still busy — leg B [$b] retries in ${retry}s ($(( deadline - now ))s of budget left)" >&2
    sleep "$retry"
  done
  echo "branch-gates: leg B [$b] — rig_gates_detached_run=$idb"

  if pass_has --no-wait; then
    echo "branch-gates: split launched, no verdict yet — leg A [$a] $ida, leg B [$b] $idb, both at ${HEAD_SHA:0:12}. Collect each with scripts/verify-gates-remote.sh --attach <id>; the branch is green only when BOTH are."
    return 76
  fi

  "$SCRIPT_DIR/verify-gates-remote.sh" --attach "$ida" || rca=$?
  "$SCRIPT_DIR/verify-gates-remote.sh" --attach "$idb" || rcb=$?
  echo "branch-gates: split verdict at ${HEAD_SHA:0:12} — leg A [$a] $ida rc $rca; leg B [$b] $idb rc $rcb"
  if [[ $rca -eq 0 && $rcb -eq 0 ]]; then
    echo "branch-gates: both legs green"
    return 0
  fi
  # A real gate failure outranks a missing verdict: it is an answer about the
  # branch either way.
  for rc in $rca $rcb; do
    [[ $rc -ne 0 && $rc -ne 75 && $rc -ne 76 ]] && return $rc
  done
  echo "branch-gates: split incomplete — a leg that ended without a verdict says nothing about the branch, so this is NOT a pass; re-attach the ids above, or re-run" >&2
  [[ $rca -eq 76 || $rcb -eq 76 ]] && return 76
  return 75
}

PLAN=single
if needs_mac "$GATES"; then
  if pass_has --rig; then
    # A deliberate pin never silently becomes two runs somewhere else.
    echo "branch-gates: --rig pins one rig — not auto-splitting [$GATES], even if every Mac is busy" >&2
  else
    MAC_LEG=""
    for g in ${GATES//,/ }; do
      case " $MAC_ONLY_GATES " in *" $g "*) MAC_LEG="${MAC_LEG:+$MAC_LEG,}$g" ;; esac
    done
    MAC_FREE=1
    mac_is_free "$MAC_LEG" || case $? in
      1) MAC_FREE=0 ;;
      # The probe could not answer at all (usage, no git, a broken fleet list).
      # Not the saturated fleet this splits for — leave the run as it was.
      *) echo "branch-gates: could not probe the Mac fleet for [$MAC_LEG] — leaving the run single" >&2 ;;
    esac
    PLAN="$(split_plan "$GATES" "$MAC_FREE")"
  fi
fi

if [[ "$PLAN" != single ]]; then
  print_plan "$PLAN"
  HEAD_SHA="$(git rev-parse HEAD)" || exit 2
  # shellcheck disable=SC2086
  set -- $PLAN
  run_split "$2" "$3"
  SPLIT_RC=$?
  [[ $SPLIT_RC -ne $SPLIT_UNAVAILABLE ]] && exit $SPLIT_RC
fi

exec "$SCRIPT_DIR/verify-gates-remote.sh" --only "$GATES" ${PASS[@]+"${PASS[@]}"}
