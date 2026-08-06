#!/usr/bin/env bash
# Build the stdio MCP server and stage it under the target-triple name Tauri's
# externalBin bundler expects. Runs after the main Rust binary is built and
# immediately before packaging, so both binaries come from the same checkout,
# profile and CARGO_TARGET_DIR (including release-macos.sh's isolated target).
set -euo pipefail

cd "$(dirname "$0")/.."
MCP_BUILD_ROOT="$PWD"
# shellcheck source=scripts/lib/checkout-guard.sh
. "$MCP_BUILD_ROOT/scripts/lib/checkout-guard.sh"
guard_checkout_freshness prepare-mcp-sidecar.sh

# MCP is a desktop transport. iOS/Android keep their existing bundle shape.
case "${TAURI_ENV_PLATFORM:-}" in
  ios|android) exit 0 ;;
esac

PROFILE=release
CARGO_PROFILE=(--release)
if [ "${TAURI_ENV_DEBUG:-false}" = "true" ]; then
  PROFILE=debug
  CARGO_PROFILE=()
fi

TARGET_ARGS=()
if [ -n "${CARGO_BUILD_TARGET:-}" ]; then
  TRIPLE=$CARGO_BUILD_TARGET
  TARGET_ARGS=(--target "$TRIPLE")
else
  TRIPLE=$(rustc -vV | sed -n 's/^host: //p')
fi
[ -n "$TRIPLE" ] || { echo "prepare-mcp-sidecar: could not resolve Rust target triple" >&2; exit 1; }

cargo build \
  --manifest-path src-tauri/Cargo.toml \
  --bin substrate-mcp \
  "${CARGO_PROFILE[@]}" \
  "${TARGET_ARGS[@]}"

TARGET_DIR=$(cargo metadata \
  --manifest-path src-tauri/Cargo.toml \
  --format-version 1 \
  --no-deps | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).target_directory))')

SOURCE_DIR="$TARGET_DIR/$PROFILE"
if [ "${#TARGET_ARGS[@]}" -gt 0 ]; then
  SOURCE_DIR="$TARGET_DIR/$TRIPLE/$PROFILE"
fi

EXT=""
case "$TRIPLE" in
  *-windows-*) EXT=".exe" ;;
esac
SOURCE="$SOURCE_DIR/substrate-mcp$EXT"
DEST="src-tauri/binaries/substrate-mcp-$TRIPLE$EXT"
[ -x "$SOURCE" ] || { echo "prepare-mcp-sidecar: built binary missing at $SOURCE" >&2; exit 1; }
mkdir -p src-tauri/binaries
cp "$SOURCE" "$DEST"
echo "prepare-mcp-sidecar: staged $DEST"
