#!/usr/bin/env bash
# hard-timeout.sh — a wall-clock timeout that does not depend on coreutils.
#
# Why this exists: ssh's ConnectTimeout only covers establishing the
# connection. A wedged rig whose sshd ACCEPTS the TCP connection and then never
# answers defeats it completely — the probe hangs forever with no output, and
# the v0.22.0 ship needed a manual `kill` to get moving again. macOS ships no
# `timeout`/`gtimeout` by default, so the guard has to be built here.
#
# Usage:
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/hard-timeout.sh"
#   substrate_run_with_timeout 12 ssh -o BatchMode=yes rig 'true' || rc=$?
#   [ "${rc:-0}" -eq 124 ] && echo "it hung"
#
# Returns the command's own exit code, or 124 when the deadline fired (same
# convention as GNU timeout). The command runs in its own process group and
# the deadline signals the whole group — TERM, then KILL a second later if it
# ignored TERM — so neither a hung ssh nor anything it forked survives as an
# orphan. That matters most inside a command substitution: a grandchild still
# holding the inherited stdout keeps the substitution waiting on the pipe,
# and killing the direct child alone leaves the caller wedged past its
# deadline.
#
# Caveat worth knowing: a command that genuinely exits 143/137 on its own is
# indistinguishable from one we killed, and reads as a timeout. For the ssh
# probes this file exists for, those codes only ever come from our own kill.

# Usage: substrate_run_with_timeout <seconds> <command...>
substrate_run_with_timeout() {
  local secs="$1"; shift

  # Job control gives the child its own process group, so the deadline can
  # take out everything it forked — not just the pid we launched. Restored
  # immediately after, since the caller may not want it.
  local had_monitor=""
  case "$-" in *m*) had_monitor=1 ;; esac
  set -m 2>/dev/null || true

  "$@" &
  local pid=$!

  ( sleep "$secs"; substrate__kill_tree TERM "$pid"; sleep 1; substrate__kill_tree KILL "$pid" ) >/dev/null 2>&1 &
  local watchdog=$!

  [ -n "$had_monitor" ] || set +m 2>/dev/null || true

  local rc=0
  wait "$pid" 2>/dev/null || rc=$?

  # The command won the race: retire the watchdog (and its sleep) before it
  # can fire.
  substrate__kill_tree TERM "$watchdog"
  wait "$watchdog" 2>/dev/null || true

  if [ "$rc" -eq 143 ] || [ "$rc" -eq 137 ]; then
    return 124
  fi
  return "$rc"
}

# Signal a job's whole process group when the job LEADS one, else just the
# pid. The group form is what makes the deadline hard: a wrapper that forked a
# grandchild holding stdout would otherwise keep a command substitution
# waiting on the pipe long after its parent was killed. The leader test
# (pgid equal to pid) is the safety rail: when job control did not take, the
# child sits as a NON-leader in somebody else's group — the caller's — and a
# group kill there would take the whole session down. Testing against the
# caller's own pgid instead would fail open the moment the caller has exited
# and its pgid can no longer be read for the comparison.
substrate__kill_tree() {
  local sig="$1" pid="$2" pgid=""
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
  if [ -n "$pgid" ] && [ "$pgid" = "$pid" ]; then
    kill "-$sig" -- "-$pgid" 2>/dev/null || true
  else
    kill "-$sig" "$pid" 2>/dev/null || true
  fi
}
