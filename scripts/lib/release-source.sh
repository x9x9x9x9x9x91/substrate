#!/usr/bin/env bash
# Source provenance preflight shared by the macOS release pipeline and its
# hermetic tests. The caller owns presentation and exit wording; this function
# prints one tab-separated fact row on success and evidence on stderr on failure.

release_source_facts() { # repo-root app-version -> commit<TAB>tag<TAB>rustc-version
  local root="$1"
  local version="$2"
  local dirty commit tag tag_ref tag_type tag_commit channel rustc_line rustc_version

  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
    echo "release source: '$version' is not a version that can map to a v<version> tag" >&2
    return 1
  fi

  git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
    echo "release source: $root is not a git worktree" >&2
    return 1
  }

  dirty=$(git -C "$root" status --porcelain=v1 --untracked-files=all) || {
    echo "release source: could not inspect the working tree" >&2
    return 1
  }
  if [[ -n "$dirty" ]]; then
    echo "release source: working tree is dirty; commit or remove every change before building:" >&2
    printf '%s\n' "$dirty" | sed 's/^/  /' >&2
    return 1
  fi

  commit=$(git -C "$root" rev-parse --verify 'HEAD^{commit}' 2>/dev/null) || {
    echo "release source: HEAD is not a commit" >&2
    return 1
  }
  tag="v$version"
  tag_ref="refs/tags/$tag"
  tag_type=$(git -C "$root" cat-file -t "$tag_ref" 2>/dev/null) || {
    echo "release source: expected annotated tag $tag does not exist" >&2
    return 1
  }
  if [[ "$tag_type" != "tag" ]]; then
    echo "release source: $tag is lightweight; releases require an annotated tag" >&2
    return 1
  fi
  tag_commit=$(git -C "$root" rev-parse --verify "${tag_ref}^{commit}" 2>/dev/null) || {
    echo "release source: $tag does not resolve to a commit" >&2
    return 1
  }
  if [[ "$tag_commit" != "$commit" ]]; then
    echo "release source: HEAD $commit is not $tag ($tag_commit)" >&2
    return 1
  fi

  [[ -f "$root/rust-toolchain.toml" ]] || {
    echo "release source: rust-toolchain.toml is missing" >&2
    return 1
  }
  channel=$(sed -n 's/^channel = "\([^"]*\)"$/\1/p' "$root/rust-toolchain.toml")
  if [[ ! "$channel" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "release source: rust-toolchain.toml must pin an exact x.y.z channel (got '${channel:-missing}')" >&2
    return 1
  fi
  rustc_line=$(rustc --version 2>/dev/null) || {
    echo "release source: rustc is unavailable (install the pinned $channel toolchain with rustup)" >&2
    return 1
  }
  rustc_version=${rustc_line#rustc }
  rustc_version=${rustc_version%% *}
  if [[ "$rustc_version" != "$channel" ]]; then
    echo "release source: rustc $rustc_version is active, but rust-toolchain.toml pins $channel" >&2
    return 1
  fi

  printf '%s\t%s\t%s\n' "$commit" "$tag" "$rustc_line"
}
