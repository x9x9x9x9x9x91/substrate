#!/usr/bin/env bash
# gate-timing-append.sh — record how long one gate leg took, as one JSONL line.
#
# verify-gates.sh already measures every leg (the summary table prints the
# seconds) and then drops the number. Machine time is the one half of
# dev-speed that no tracker records, so the number is worth keeping: this
# appends it to a local file the repository never sees.
#
#   scripts/gate-timing-append.sh <gate> <seconds> <rc> <sha> <scope>
#
# The file is per-host by design — each dev Mac and each gate rig accumulates
# its own, and nothing ships anywhere. Default $HOME/.substrate/gate-timings.jsonl,
# overridable with SUBSTRATE_GATE_TIMINGS (tests point it at a temp path).
#
# THE ONE INVARIANT: this can never fail a gate run. It is telemetry hung off
# the side of the thing that decides whether a branch merges, so every failure
# path below — unwritable directory, read-only file, full disk — degrades to a
# single stderr line and exit 0. There is deliberately no error exit at all.
set -uo pipefail

warn() { echo "gate-timing: $1" >&2; return 0; }

if [[ $# -ne 5 ]]; then
  warn "expected 5 args (gate seconds rc sha scope), got $#"
  exit 0
fi

gate="$1"; seconds="$2"; rc="$3"; sha="$4"; scope="$5"

# JSON string escaping, kept to what these fields can actually hold: gate and
# scope come from the gate list, sha is hex, but hostname is whatever the
# machine is named. Backslash first, then quote, then the control characters a
# raw line break would otherwise use to forge a second record.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

path="${SUBSTRATE_GATE_TIMINGS:-${HOME:-/tmp}/.substrate/gate-timings.jsonl}"
dir="$(dirname "$path")"

if ! mkdir -p "$dir" 2>/dev/null; then
  warn "cannot create $dir — timing for '$gate' not recorded"
  exit 0
fi

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" || ts=""
host="$(hostname 2>/dev/null)" || host=""

line=$(printf '{"ts":"%s","host":"%s","gate":"%s","seconds":%s,"rc":%s,"sha":"%s","scope":"%s"}' \
  "$(json_escape "$ts")" \
  "$(json_escape "$host")" \
  "$(json_escape "$gate")" \
  "$([[ "$seconds" =~ ^-?[0-9]+$ ]] && printf '%s' "$seconds" || printf 'null')" \
  "$([[ "$rc" =~ ^-?[0-9]+$ ]] && printf '%s' "$rc" || printf 'null')" \
  "$(json_escape "$sha")" \
  "$(json_escape "$scope")")

# One printf of a short line through a single >> is what keeps parallel gate
# runs on one host from interleaving halves of two records: an append-mode
# write below PIPE_BUF lands whole.
# The redirection runs inside a silenced subshell rather than carrying its own
# 2>/dev/null: a failing `>>` is the SHELL's error, not the command's, so it
# would print its own "Permission denied" alongside the warn line below.
if ! ( printf '%s\n' "$line" >>"$path" ) 2>/dev/null; then
  warn "cannot append to $path — timing for '$gate' not recorded"
  exit 0
fi

exit 0
