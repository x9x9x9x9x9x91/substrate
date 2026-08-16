#!/usr/bin/env bash
# Install a built blob-store binary on the host and flip to it, rolling back to
# the previous release if the new one does not answer. Run as root on the host,
# with the artifact already copied there.
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "usage: sudo $0 /path/to/substrate-hosted-sync-server" >&2
  exit 64
fi

artifact="$(realpath "$1")"
sha="$(sha256sum "$artifact" | awk '{print $1}')"
root=/opt/substrate-blob
release="$root/releases/blob-$sha"
current="$root/current"
old="$(readlink "$current" 2>/dev/null || true)"

install -d -m 0755 "$root/releases"
install -m 0755 "$artifact" "$release"
ln -sfn "releases/$(basename "$release")" "$root/current.next"
mv -Tf "$root/current.next" "$current"

systemctl restart substrate-blob
for _attempt in {1..20}; do
  # An unauthenticated health probe answers 401; either code proves the process
  # is up and answering, and neither needs the token to be readable here.
  code="$(curl --silent --output /dev/null --max-time 2 --write-out '%{http_code}' \
    http://127.0.0.1:8788/v1/health || true)"
  if [[ "$code" == "401" || "$code" == "200" ]]; then
    echo "installed $release ($sha)"
    exit 0
  fi
  sleep 0.5
done

echo "health check failed; rolling back" >&2
if [[ -n "$old" ]]; then
  ln -sfn "$old" "$root/current.next"
  mv -Tf "$root/current.next" "$current"
  systemctl restart substrate-blob
else
  rm -f "$current"
  systemctl stop substrate-blob
fi
exit 1
