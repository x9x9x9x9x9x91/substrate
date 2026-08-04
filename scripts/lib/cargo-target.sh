#!/usr/bin/env bash
# Portable shared Cargo target for local Substrate builds (SUB-987).
#
# Cargo does not expand $HOME or ~ in .cargo/config.toml, so a checked-in
# absolute target-dir ties every clone to one account. Keep the default in a
# shell entry point instead: npm's Tauri command and the repo scripts source
# this file, while CI/rig/release overrides remain authoritative.

substrate_use_shared_cargo_target() {
  if [[ -z "${CARGO_TARGET_DIR:-}" ]]; then
    CARGO_TARGET_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/substrate-cargo-target"
  fi
  export CARGO_TARGET_DIR
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ $# -eq 0 ]]; then
    printf 'cargo-target.sh: command required\n' >&2
    exit 2
  fi
  substrate_use_shared_cargo_target
  exec "$@"
fi
