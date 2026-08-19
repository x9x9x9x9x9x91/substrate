# Deploying the blob store

The single-tenant blob store as it runs on alp1, behind an nginx that already
terminates TLS for one name — `<host>` below. Protocol and design of record:
`docs/hosted-sync-protocol.md` (§2.1 wire binding, §7 the server itself).

Client base URL: `https://<host>/blob` — the proxy strips the prefix, so
the server sees the §2.1 paths verbatim.

**Single tenant means single tenant.** One token, one storage root, one ref, no
accounts and no quotas. Do not point a second person's vault at this deployment.

## Build

The crate has no dependencies, so a cross-build from macOS needs only a linker.
Zig supplies one:

```sh
rustup target add x86_64-unknown-linux-gnu
printf '#!/bin/sh\nexec zig cc -target x86_64-linux-gnu.2.35 "$@"\n' > /tmp/zcc
chmod +x /tmp/zcc
CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=/tmp/zcc \
  cargo build --release --target x86_64-unknown-linux-gnu
```

Pinning glibc 2.35 keeps the binary older than the host's (Ubuntu 24.04 ships
2.39), which is the direction that works.

## First install

```sh
useradd --system --home-dir /var/lib/substrate-blob --shell /usr/sbin/nologin substrate-blob
install -d -m 0700 -o substrate-blob -g substrate-blob /var/lib/substrate-blob

umask 077
printf 'SUBSTRATE_BLOB_ADDR=127.0.0.1:8788\nSUBSTRATE_BLOB_DIR=/var/lib/substrate-blob\nSUBSTRATE_BLOB_TOKEN=%s\n' \
  "$(openssl rand -hex 32)" > /etc/substrate-blob.env

install -m 0644 substrate-blob.service /etc/systemd/system/
systemctl daemon-reload
```

The token lives only in `/etc/substrate-blob.env` (root, `0600`) and in whatever
client holds the remote; it is never in this repository. Port 8788, not the
protocol's default 8787 — the handoff relay already owns 8787 on this host.

Then the nginx route: paste `nginx-blob-route.conf` into the existing `<host>`
site (zones at the http level, the `location` inside the server block that owns
the certificate), `nginx -t`, `systemctl reload nginx`.
Reload, never restart: the handoff relay is served by the same nginx.

## Releases and rollback

`sudo ./install-release.sh /path/to/substrate-hosted-sync-server` copies the
artifact to `/opt/substrate-blob/releases/blob-<sha256>`, flips the `current`
symlink, restarts the unit, and rolls back to the previous release if the new
one does not answer within ten seconds.

## Verifying a deployment

From outside the host, against `https://<host>/blob`:

- `GET /v1/health` with no token → `401`; with the token → `200 ok`.
- `PUT /v1/objects/<64 hex>` → `201`, a repeat of the same bytes → `200`, `GET`
  returns them byte-identical, an absent name → `404`, a short name → `400`.
- `PUT /v1/ref` with `If-None-Match: *` → `204` + `ETag`; a stale `If-Match` →
  `412`; neither precondition → `428`.
- `GET /v1/key` → `404` until a device enrolls; `PUT /v1/key` carries the same
  precondition semantics as the ref. A deployment predating the key document
  answers `404` on the PUT too — that means the binary needs updating before
  any device can enroll.
- A body past the proxy cap → `413`; a burst past `blob_api` → `429` while the
  service stays healthy.

The auth-before-body rule of §2.1 is a property of the loopback hop and has to
be probed there — nginx buffers a request body before proxying, so from outside
the proxy absorbs the unauthenticated upload instead:

```sh
python3 - <<'PY'
import socket
head = ("PUT /v1/objects/" + "a"*64 + " HTTP/1.1\r\nHost: x\r\n"
        "Authorization: Bearer wrongtokenwrongtoken\r\nContent-Length: 4194304\r\n\r\n")
s = socket.create_connection(("127.0.0.1", 8788), 5); s.settimeout(10)
s.sendall(head.encode())
print(s.recv(200).split(b"\r\n")[0])   # HTTP/1.1 401 Unauthorized, immediately
PY
```

## Backups

Not set up. The storage root is ciphertext, so any snapshot target is
privacy-safe, but choosing an off-site target is an operator decision and a
restore has to be rehearsed before the store holds the only copy of anything.
Until then the client keeps the authoritative repository and this store is a
transport.

Restore the whole storage root together, then restart the service. `objects/`
is the truth; `list-journal` beside it is the name list clients ask for
incrementally (protocol §2.2). Restarting is what makes a restore safe: every
start names its run with a fresh random value that is never written down, so
every cursor the previous run issued is retired and every client is put back on
a complete listing. Nothing in the storage root carries that value, which is
why restoring the root cannot bring an old one back. Editing the directory
under a running server is the thing to avoid — deleting an object is caught by
the next complete listing, but a restored `list-journal` is not, because a
consistent restore looks exactly like a store that is younger than it is.

A store upgraded from an earlier build may still have a `list-epoch` file. It
is no longer read or written, and deleting it changes nothing.
