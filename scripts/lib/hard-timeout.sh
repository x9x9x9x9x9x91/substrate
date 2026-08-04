#!/usr/bin/env bash
# hard-timeout.sh — a wall-clock timeout that does not depend on coreutils.
#
# Why this exists (SUB-1052): ssh's ConnectTimeout only covers establishing the
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
# convention as GNU timeout). The command is sent TERM, then KILL a second
# later if it ignored TERM — so a hung ssh cannot survive as an orphan.
#
# Caveat worth knowing: a command that genuinely exits 143/137 on its own is
# indistinguishable from one we killed, and reads as a timeout. For the ssh
# probes this file exists for, those codes only ever come from our own kill.

# Usage: substrate_run_with_timeout <seconds> <command...>
substrate_run_with_timeout() {
  local secs="$1"; shift

  "$@" &
  local pid=$!

  # Watchdog: politely first, then unconditionally. Its own output is
  # discarded so a kill never litters the caller's log.
  ( sleep "$secs"; kill -TERM "$pid"; sleep 1; kill -KILL "$pid" ) >/dev/null 2>&1 &
  local watchdog=$!

  local rc=0
  wait "$pid" 2>/dev/null || rc=$?

  # The command won the race: retire the watchdog before it can fire.
  kill -TERM "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true

  if [ "$rc" -eq 143 ] || [ "$rc" -eq 137 ]; then
    return 124
  fi
  return "$rc"
}
