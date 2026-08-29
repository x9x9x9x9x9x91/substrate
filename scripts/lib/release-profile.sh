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
