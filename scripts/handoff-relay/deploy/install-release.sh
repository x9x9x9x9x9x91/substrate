#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "usage: sudo $0 /path/to/serve.mjs" >&2
  exit 64
fi

artifact="$(realpath "$1")"
/usr/bin/node --check "$artifact"
sha="$(sha256sum "$artifact" | awk '{print $1}')"
root=/opt/substrate-handoff
release="$root/releases/serve-$sha.mjs"
current="$root/current.mjs"
old="$(readlink "$current" 2>/dev/null || true)"

install -d -m 0755 "$root/releases"
install -m 0644 "$artifact" "$release"
ln -sfn "releases/$(basename "$release")" "$root/current.next"
mv -Tf "$root/current.next" "$current"

systemctl restart substrate-handoff
for _attempt in {1..20}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8787/ >/dev/null; then
    echo "installed $release ($sha)"
    exit 0
  fi
  sleep 0.5
done

echo "health check failed; rolling back" >&2
if [[ -n "$old" ]]; then
  ln -sfn "$old" "$root/current.next"
  mv -Tf "$root/current.next" "$current"
  systemctl restart substrate-handoff
else
  rm -f "$current"
  systemctl stop substrate-handoff
fi
exit 1
