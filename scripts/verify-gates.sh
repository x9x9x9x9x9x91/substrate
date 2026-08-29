#!/usr/bin/env bash
# verify-gates.sh — re-run the repo's merge gates and print ACTUAL results.
#
# Handbacks report gate results as prose tables, and a table can be
# affirmatively false (a handback claimed `npm test` pass 825/fail 0
# at a commit whose real result was 824/1). This makes the mandated re-run
# one command, so the verdict step starts from observed numbers.
#
# Run from the worktree whose branch you are adjudicating (any cwd inside it):
#   scripts/verify-gates.sh                    # the whole battery
#   scripts/verify-gates.sh --only tsc,lint    # subset while iterating
#   scripts/verify-gates.sh --ref <commit>     # assert HEAD == the claimed commit
#
# Gates (AGENTS.md merge rules): tsc, test, cargo, ios, e2e, lint, macsmoke.
#
# The `ios` leg is a cross-compile CHECK (`cargo check --target
# aarch64-apple-ios --lib`) — no linking, no signing, no simulator. It exists
# because the five host gates are all host-target: a branch once landed
# where `commands/voice.rs` referenced `crate::voice::*` ungated, which is 5×
# E0433 for iOS while tsc/test/cargo/e2e/lint all ran green. With a live
# TestFlight target that class is merge-then-discover, so it gets a gate.
#
# One-time machine prep the leg needs (dev Mac and every QA rig):
#   rustup target add aarch64-apple-ios          # the iOS std library
#   full Xcode + sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
#     (dependency build scripts — rusqlite, libgit2 — cross-compile C against
#      the iPhoneOS SDK, which the Command Line Tools alone do not ship)
# Missing prep FAILS the gate with those commands in the output. It is
# deliberately not a skip: a leg that skips itself reads as green and would
# recreate exactly the blindness this gate exists to close.
# Exit 0 only if every requested gate passed; per-gate logs are kept in a
# temp dir named at the end for anything that needs a closer look. Exit 2 is
# a usage or worktree-state refusal and exit 3 is an incomplete host toolchain
# (see the preflight below) — both are distinct from exit 1, which means a
# gate actually ran and went red.
set -uo pipefail

# shellcheck source=scripts/lib/checkout-guard.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/checkout-guard.sh"
guard_checkout_freshness verify-gates.sh

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "verify-gates: not inside a git worktree" >&2; exit 2
}
cd "$ROOT"
# shellcheck source=scripts/lib/cargo-target.sh
. "$ROOT/scripts/lib/cargo-target.sh"
substrate_use_shared_cargo_target

# The battery, in canonical order, and the single source of truth for what
# --only will accept: the validation below tests membership of this list rather
# than repeating it as a pattern, so a leg can be added or fenced in one place.
GATES_ALL="tsc,test,cargo,ios,e2e,lint,macsmoke"
ONLY="$GATES_ALL"
ONLY_GIVEN=0
REF=""
ORIG_ARGS=("$@")
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) [[ $# -ge 2 ]] || { echo "verify-gates: --only needs a value" >&2; exit 2; }
            ONLY="$2"; ONLY_GIVEN=1; shift 2 ;;
    --ref)  [[ $# -ge 2 ]] || { echo "verify-gates: --ref needs a value" >&2; exit 2; }
            REF="$2"; shift 2 ;;
    *) echo "verify-gates: unknown arg '$1' (flags: --only $GATES_ALL --ref <commit>)" >&2
       exit 2 ;;
  esac
done

# Normalise --only while validating: every gate decision below matches on
# ",$ONLY," against ",$g,", so a spelling the loop accepts but the case never
# matches — `--only "test cargo"`, which word-splits fine here — would run the
# legs it names while silently skipping every guard keyed off the same list,
# the preflight below included. Padded and space-separated spellings therefore
# become the same canonical csv rather than being rejected; a typo is still a
# loud exit 2.
ONLY_NORM=""
for g in ${ONLY//,/ }; do
  case ",$GATES_ALL," in *",$g,"*) ;; *)
    echo "verify-gates: unknown gate '$g' (valid: $GATES_ALL)" >&2; exit 2 ;;
  esac
  ONLY_NORM+="${ONLY_NORM:+,}$g"
done
[[ -n "$ONLY_NORM" ]] || { echo "verify-gates: --only selected no gates" >&2; exit 2; }
ONLY="$ONLY_NORM"

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

# ── rig toolchain preflight ────────────────────────────────────────────────
# A gate host missing a build tool does not fail as a machine problem. It
# fails as a red gate on whatever branch happens to run next: one rig had no
# cmake on the gate-run PATH, the test leg's share-mirror --push build died in
# whisper-rs-sys's build script, and every sha that rig drew wore a red `test`
# leg it had nothing to do with — twenty minutes of log reading for a
# machine-environmental cause (2026-08-19). Nothing asserted rig toolchain
# completeness, so the gap could only surface that way.
#
# So the tools the REQUESTED legs need are asserted here, before a suite
# burns, with a named refusal and the provisioning command. Deliberately
# before the gates lock below: a rig that cannot run the battery should say so
# instantly, not after queueing behind someone else's.
#
# Scoped by leg and by host class rather than asserted wholesale, so a
# `--only lint` run on a machine without the full rig stack still works.
PREFLIGHT_MISSING=""
PREFLIGHT_NAMES=""
preflight_need() { # tool, why it is needed
  # Asserted by EXECUTION, not by lookup. A tool that is on PATH but cannot
  # run reds the leg just as an absent one does, and — the reason this is
  # shaped this way — a rig that ships its own copy of the tool would satisfy
  # a lookup even when the run under test deliberately has none, so the
  # refusal below could never be exercised there. Every tool asserted here
  # answers `--version`.
  "$1" --version >/dev/null 2>&1 && return 0
  PREFLIGHT_NAMES="${PREFLIGHT_NAMES:+$PREFLIGHT_NAMES, }$1"
  PREFLIGHT_MISSING="$PREFLIGHT_MISSING  - $1 — $2
"
}

# cmake builds whisper.cpp for whisper-rs-sys, which the engine takes as a
# cfg(target_os = "macos") dependency — a Darwin-host requirement, and
# provably not a Linux one, since a Linux host never compiles that cfg.
# Three legs reach it: cargo and macsmoke compile the mac tree directly, and
# the test leg reaches it through share-mirror.sh --push, whose publish path
# runs `cargo check` over the stripped tree.
NEEDS_MAC_COMPILE=0
case ",$ONLY," in
  *,test,*|*,cargo,*|*,macsmoke,*) NEEDS_MAC_COMPILE=1 ;;
esac
if [[ "$(uname -s)" == "Darwin" && $NEEDS_MAC_COMPILE -eq 1 ]]; then
  preflight_need cmake "whisper-rs-sys compiles whisper.cpp with it; the Command Line Tools do not ship one"
fi

if [[ -n "$PREFLIGHT_MISSING" ]]; then
  echo "verify-gates: rig toolchain incomplete: missing $PREFLIGHT_NAMES — run scripts/setup-substrate-rig.sh <rig>" >&2
  printf '%s' "$PREFLIGHT_MISSING" >&2
  echo "  Refusing before any gate leg runs: a build tool absent from the gate PATH reds a leg on whatever branch is under test, which reads as a code fault and is not one." >&2
  exit 3
fi

# Local gate runs serialize machine-wide (with-gates-lock.sh, the 2026-07-31
# freeze fix) — and since 2026-08-18 that is enforced here, not left to callers:
# on 2026-08-18 six lanes ran the battery bare in parallel and convoyed the
# machine (docs/agent-friction.md). A bare invocation re-execs under the
# wrapper; the wrapper marks its subtree so the re-exec happens exactly once
# and nested runs (rig-gates-runner → verify-gates → npm test) don't deadlock
# on their own lock. The existence guard keeps the public mirror working: it
# ships this script but strips the wrapper, and a lone clone has no lane
# fleet to serialize.
if [[ -z "${SUBSTRATE_GATES_LOCK_HELD:-}" && -x "$ROOT/scripts/with-gates-lock.sh" ]]; then
  exec "$ROOT/scripts/with-gates-lock.sh" "$ROOT/scripts/verify-gates.sh" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
fi

LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/verify-gates.XXXXXX")"
NAMES=() STATUSES=() SUMMARIES=() TIMES=()
OVERALL=0

# A red gate used to say only "e2e FAIL 91s 1 failed, 707 passed" — never
# WHICH spec, so every red gate cost an ssh into the rig and a grep
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
    ios)
      # Two shapes: a missing-prerequisite refusal (one PREREQ line plus the
      # command that fixes it) or real rustc errors from the cross-compile.
      names=$(grep -E "^verify-gates: ios PREREQ|^error(\[E[0-9]+\])?:" "$log")
      # The follow-up line differs by shape and both matter: rustc's source
      # location for a real error, the fix COMMAND for a prerequisite refusal —
      # an actionable message that stays buried in the log is not actionable.
      # The location has to be the first one AFTER an error line: warnings carry
      # `-->` arrows too and usually print first, so a plain first-match points
      # at an unrelated file (observed on the negative-proof run).
      first=$(awk '/^error(\[E[0-9]+\])?:/ { on = 1 }
                   on && /^ +--> / { print; exit }' "$log")
      [[ -n "$first" ]] || first=$(grep -m1 -E "^ +(run: |install )" "$log") ;;
    cargo)
      # Two red shapes: tests that ran and failed, or a compile error that killed
      # the run before any test existed. A compile log has no `failures:` header,
      # and the name collector would then hand back cargo's indented "Compiling …"
      # progress lines as the failure names while `panicked at` matches nothing —
      # the real rustc error stayed invisible and cost an ssh to the raw log.
      if grep -q "^failures:$" "$log"; then
        # cargo prints "failures:" twice — once heading the per-test stdout
        # dumps, once heading the summary list. Resetting at each header leaves
        # the last block, which is the clean set of names.
        names=$(awk '/^failures:$/ { buf = ""; next }
                     /^[[:space:]]+[A-Za-z_]/ { buf = buf $0 "\n" }
                     END { printf "%s", buf }' "$log")
        first=$(grep -m1 "panicked at" "$log")
      else
        # Same extraction as the ios leg: rustc's error lines, plus the first
        # location AFTER an error — warnings carry `-->` arrows too and print
        # first, so a plain first-match points at an unrelated file.
        names=$(grep -E "^error(\[E[0-9]+\])?:" "$log")
        first=$(awk '/^error(\[E[0-9]+\])?:/ { on = 1 }
                     on && /^ +--> / { print; exit }' "$log")
      fi ;;
    e2e)
      # playwright's numbered failure list: "  1) [chromium] › e2e/x.spec.ts:12:3 › Suite › name ───"
      names=$(grep -E "^[[:space:]]+[0-9]+\) " "$log" | sed 's/[[:space:]]*─*[[:space:]]*$//')
      first=$(grep -m1 -E "^[[:space:]]+(Error:|expect\()" "$log") ;;
    macsmoke)
      # Three red shapes: the wrong-host refusal (its one CLASS line is the
      # whole story), a compile error from the all-targets check, or mac test
      # failures — the last two are the cargo leg's shapes exactly.
      if grep -q "^verify-gates: macsmoke CLASS" "$log"; then
        names=$(grep "^verify-gates: macsmoke CLASS" "$log")
      elif grep -q "^failures:$" "$log"; then
        names=$(awk '/^failures:$/ { buf = ""; next }
                     /^[[:space:]]+[A-Za-z_]/ { buf = buf $0 "\n" }
                     END { printf "%s", buf }' "$log")
        first=$(grep -m1 "panicked at" "$log")
      else
        names=$(grep -E "^error(\[E[0-9]+\])?:" "$log")
        first=$(awk '/^error(\[E[0-9]+\])?:/ { on = 1 }
                     on && /^ +--> / { print; exit }' "$log")
      fi ;;
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

# Per-leg timing telemetry, strictly advisory. The helper swallows its own
# failures (see its header); the guards here cover the two it cannot — a
# checkout that predates it, and a helper that somehow refuses to run at all.
# A gate verdict must never depend on whether a timing line got written.
GATE_TIMING_APPEND="$ROOT/scripts/gate-timing-append.sh"
# What the run covered: the normalised subset, or `full` when no --only was
# given, so a 40s `lint` leg is never read back as a 40s battery.
GATE_TIMING_SCOPE=$([[ $ONLY_GIVEN -eq 1 ]] && printf '%s' "$ONLY" || printf 'full')
record_gate_timing() { # name, seconds, rc
  [[ -r "$GATE_TIMING_APPEND" ]] || return 0
  bash "$GATE_TIMING_APPEND" "$1" "$2" "$3" "$HEAD_SHA" "$GATE_TIMING_SCOPE" || true
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
    ios)
      if [[ $rc -eq 0 ]]; then
        summary="clean (check-only, $IOS_TARGET)"
      elif grep -q "^verify-gates: ios PREREQ" "$log"; then
        # Say it in the summary line too: an unprepped machine is an operator
        # fix, not a code red, and the table is what a handback quotes.
        summary="machine not prepped for $IOS_TARGET — see detail"
      else
        local ierrs; ierrs=$(grep -cE "^error(\[E[0-9]+\])?:" "$log" || true)
        summary="$ierrs $IOS_TARGET compile errors"
      fi ;;
    e2e)
      summary=$(grep -E "^[[:space:]]*[0-9]+ (passed|failed|flaky|skipped|interrupted)" "$log" \
                | sed 's/^[[:space:]]*//' | paste -sd ', ' -)
      summary=${summary:-"no playwright summary (see log)"} ;;
    lint)
      summary=$([[ $rc -eq 0 ]] && echo "clean" || grep "✖" "$log" | tail -1)
      summary=${summary:-"exit $rc (see log)"} ;;
    macsmoke)
      if grep -q "^verify-gates: macsmoke CLASS" "$log"; then
        summary="needs a Darwin host — see detail"
      elif grep -q "^test result:" "$log"; then
        summary=$(grep "^test result:" "$log" | sed 's/^test result: //' | paste -sd '; ' -)
        summary="mac check --all-targets + $summary"
      elif [[ $rc -eq 0 ]]; then
        summary="mac check --all-targets clean; test half = cargo leg on this host"
      else
        local merrs; merrs=$(grep -cE "^error(\[E[0-9]+\])?:" "$log" || true)
        summary="$merrs macOS compile errors"
      fi ;;
  esac
  NAMES+=("$name"); TIMES+=("$((end - start))s"); SUMMARIES+=("$summary")
  record_gate_timing "$name" "$((end - start))" "$rc"
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
# beats the config on every machine — dev Mac and QA rigs alike.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/substrate-cargo-target}"

IOS_TARGET="aarch64-apple-ios"

# The iOS leg, prerequisites first. Both prerequisites are one-time operator
# setup, so each refusal names the exact command that fixes it — and each
# still FAILS the gate. A skip-when-unprepped arm would print green on a
# machine that checked nothing, which is the failure mode this leg exists to
# prevent.
ios_check() {
  local libdir rustc_bin cargo_v rustc_v
  # Ask the compiler CARGO will use, since cargo is what runs the compile.
  # `rustup target list` was the obvious probe and is wrong here: the QA rigs
  # put direct toolchain symlinks in ~/.cargo/bin rather than rustup proxies.
  # But bare PATH `rustc` is not quite the question either — cargo honours
  # $RUSTC, and a directory override or a `+toolchain` can put cargo and PATH's
  # rustc on different toolchains, at which point the probe answers for one and
  # the build runs on the other: a pass that then fails, or a refusal on a
  # machine that would have built. So: cargo's $RUSTC when set, plus a version
  # cross-check either way — rustup ships cargo and rustc in lockstep, so a
  # version split IS a toolchain split, whatever put them apart.
  rustc_bin="${RUSTC:-rustc}"
  cargo_v=$(cargo --version 2>/dev/null | awk '{print $2}')
  rustc_v=$("$rustc_bin" --version 2>/dev/null | awk '{print $2}')
  if [[ -n "$cargo_v" && -n "$rustc_v" && "$cargo_v" != "$rustc_v" ]]; then
    echo "verify-gates: ios PREREQ mismatch — cargo is $cargo_v but rustc is $rustc_v, so this probe would answer for a different toolchain than the one that compiles"
    echo "  run: rustup default stable — or drop whatever splits them (a \$RUSTC override, a directory override, a +toolchain)"
    return 1
  fi
  libdir=$("$rustc_bin" --print target-libdir --target "$IOS_TARGET" 2>/dev/null)
  if [[ -z "$libdir" || ! -d "$libdir" ]]; then
    echo "verify-gates: ios PREREQ missing — no std library for $IOS_TARGET on this machine"
    echo "  run: rustup target add $IOS_TARGET"
    return 1
  fi
  if ! xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1; then
    echo "verify-gates: ios PREREQ missing — no iPhoneOS SDK (dependency build scripts cross-compile C)"
    echo "  install full Xcode, then run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
    return 1
  fi
  cargo check --target "$IOS_TARGET" --lib --manifest-path src-tauri/Cargo.toml
}

# The macsmoke leg: the per-merge proof that the macOS build still
# compiles and its tests still pass. The cargo leg answers that only for
# whatever host it ran on, and the fleet has Linux hosts — on Linux,
# every `cfg(target_os = "macos")` module (panel, tray, voice, sealed, ocr,
# mcpdoor…) simply does not compile, so its code AND its tests are invisible
# to a green cargo leg there. Same philosophy as the ios leg: on the wrong
# host class this FAILS with the reason, never skips — a skip would read as
# green on a run that certified nothing about the Mac binary.
#
# Two parts, sized for the per-merge budget (~5 min; the Mac gate host's
# gates-ledger.tsv has this leg warm at 166s and 168s on an M4 Max, so ~3 min
# against a 5 min budget):
#   1. `cargo check --all-targets` — compiles lib, binaries and every test
#      target with the mac cfg on, which is the half the ios leg's lesson
#      says otherwise stays unchecked.
#   2. `cargo test --lib` — but only when the `cargo` leg is NOT in this same
#      battery: one battery is one host, so when both legs run here the cargo
#      leg IS the mac test pass and repeating it would double the wall-clock
#      for no new evidence. The full mac e2e/build/proof sweep is the nightly
#      pass (scripts/nightly-mac-pass.sh), not this leg.
# The cargo leg, both profiles.
#
# `cargo test --lib` compiles the crate as it ships to this machine — every
# feature on. The other profile, the one a public build makes, had no gate at
# all: it was exercised only by `release-macos.sh --public`, i.e. on release
# day, by which point a module that no longer compiles without the private
# surfaces is a release that cannot be built. The check is the cheap half of a
# build (no codegen) and it runs first, because a profile that does not compile
# makes the test run's verdict beside the point.
cargo_gate() {
  # formatting first and cheapest: the tree drifted 303 hunks out of rustfmt
  # before anything said so — one command keeps "cargo fmt" a no-op on main
  cargo fmt --check --manifest-path src-tauri/Cargo.toml || return 1
  cargo check --no-default-features --lib --manifest-path src-tauri/Cargo.toml || return 1
  cargo test --lib --manifest-path src-tauri/Cargo.toml
}

macsmoke_check() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "verify-gates: macsmoke CLASS — this leg certifies the macOS build (cfg(target_os=\"macos\") code and its tests) and needs a Darwin host; a green here on Linux would be exactly the blindness the leg exists to close"
    return 1
  fi
  cargo check --all-targets --manifest-path src-tauri/Cargo.toml || return 1
  case ",$ONLY," in
    *,cargo,*) return 0 ;;
  esac
  cargo test --lib --manifest-path src-tauri/Cargo.toml
}


for g in ${ONLY//,/ }; do
  case "$g" in
    tsc)   run_gate tsc   npx tsc --noEmit ;;
    test)  run_gate test  npm test ;;
    cargo) run_gate cargo cargo_gate ;;
    ios)   run_gate ios   ios_check ;;
    e2e)   run_gate e2e   npm run e2e ;;
    lint)  run_gate lint  npm run lint ;;
    macsmoke) run_gate macsmoke macsmoke_check ;;
  esac
done

echo
echo "verify-gates @ ${HEAD_SHA:0:10} ($(git branch --show-current 2>/dev/null || echo detached))"
for i in "${!NAMES[@]}"; do
  printf "  %-5s  %-4s  %-8s  %s\n" "${NAMES[$i]}" "${STATUSES[$i]}" "${TIMES[$i]}" "${SUMMARIES[$i]}"
done
echo "  logs: $LOGDIR"
exit $OVERALL
