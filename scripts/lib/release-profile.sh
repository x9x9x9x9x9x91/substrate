#!/usr/bin/env bash
# Which of the two builds this is, derived in one place for the macOS release
# pipeline and its tests.
#
# Everything here is about not letting the surrounding environment answer the
# question. The profile comes from the flag the caller passed, and each of the
# three things that follow from it — the frontend's switch, the target
# directory, the artifact's name — is then set outright rather than left to
# whatever was already exported. Each of the three had an inheritance hole:
# SUBSTRATE_PUBLIC=1 left over in a shell made a full build ship a stripped
# frontend, an outer CARGO_TARGET_DIR collapsed both profiles into one
# directory, and two DMGs named after the version alone are indistinguishable
# once either leaves that directory.

# Sets SUBSTRATE_PUBLIC for the caller's environment: exported for a public
# build, removed for a full one. Never left as it was found.
release_profile_export() { # profile
  if [ "$1" = public ]; then
    export SUBSTRATE_PUBLIC=1
  else
    unset SUBSTRATE_PUBLIC
  fi
}

# The target directory this profile builds in — the profile's suffix goes on
# top of an inherited CARGO_TARGET_DIR rather than being swallowed by it. The
# base loses any trailing slashes first: cargo accepts `/tmp/t/`, and suffixing
# that spells a sibling directory literally named `-public` at the filesystem
# root of the parent, not the public variant of the base.
release_target_dir() { # profile -> path
  local base=${CARGO_TARGET_DIR:-/private/var/tmp/substrate-release-target}
  while [ "${base%/}" != "$base" ] && [ "$base" != / ]; do base=${base%/}; done
  if [ "$1" = public ]; then
    echo "$base-public"
  else
    echo "$base"
  fi
}

# The DMG file name, which is the only thing that travels with the artifact.
release_dmg_name() { # profile app-version -> file name
  if [ "$1" = public ]; then
    echo "Substrate_$2_aarch64-public.dmg"
  else
    echo "Substrate_$2_aarch64.dmg"
  fi
}

# The bundle identifier the profile's artifact carries — the one thing that
# makes the two builds two applications rather than two versions of one.
#
# They must differ. macOS keys an app's Application Support container, its
# preferences and its launch services registration off this string, and the
# in-app updater treats a feed entry as an update to whatever carries the same
# identity: with one identifier shared, a public DMG published to the full
# build's feed installs itself over the full app and takes the machine-only
# surfaces with it, silently. The public id is the full one with `.public`
# after it — derived, so a rename of the app can only move both.
#
# The full build's identifier is read out of src-tauri/tauri.conf.json rather
# than repeated here, so the config file stays the single place it is written:
# nothing about a dev build or a full release changes. The config is found
# relative to this library's own path, not the caller's working directory —
# the release script and the tests source it from different places.
release_bundle_id() { # profile -> identifier
  local root conf full
  root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  conf="$root/src-tauri/tauri.conf.json"
  full=$(node -p "require('$conf').identifier")
  if [ "$1" = public ]; then
    echo "$full.public"
  else
    echo "$full"
  fi
}

# The tauri config overlay a profile builds with, as the JSON `tauri build
# --config` merges over src-tauri/tauri.conf.json (RFC 7386 merge patch: named
# keys replace, everything else is inherited). Empty for the full profile,
# which builds the config file as written.
#
# Two things move for a public build. The identifier, above. And the updater's
# endpoint list, emptied: a public build ships with no feed at all for now, so
# its updates are new DMGs handed over directly. The pubkey is deliberately
# left in place — the plugin's config will not deserialize without it and the
# app would fail to start — but a key with nothing to check is inert.
#
# Passed as JSON rather than a file path: `--config` resolves a path against a
# directory this script would have to guess right, and a literal is also the
# one place the overlay is written, so nothing can drift out of step with it.
release_config_overlay() { # profile -> json overlay, empty for the full build
  [ "$1" = public ] || return 0
  printf '{"identifier":"%s","plugins":{"updater":{"endpoints":[]}}}' \
    "$(release_bundle_id public)"
}
