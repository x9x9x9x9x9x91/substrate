# Handoff relay

The dumb store behind **Send as link** (right-click a note). The app renders
the note to one self-contained HTML document, encrypts it locally with
AES-256-GCM, and uploads only the ciphertext here. The decryption key travels
in the link's `#fragment`, which browsers do not send in the HTTP request.
Recipients need nothing but a browser.

The application persists only an opaque id, ciphertext, an expiry policy and
timestamps. The network stack necessarily sees client IP addresses while a
request is in flight. The production nginx shape disables access logs; its
critical-error log can still contain connection metadata under the host's log
retention policy.

Encryption protects stored blobs and the fragment keeps the key out of normal
relay requests. It does not make a hostile relay operator harmless: the relay
serves the viewer JavaScript and a compromised operator could replace it. Use
an operator you trust, or self-host and audit the viewer you serve.

Substrate's default is the hosted instance at `https://drop.substrate.zone`:
fresh vaults seed it, while older settings notes with no relay key adopt it at
runtime without being rewritten. It runs this exact script with the limits
below and no upload token. Replacing the URL with your own relay keeps the
protocol but changes the operator in that viewer trust boundary. Clearing the
Settings persists `share-relay-url: disabled` as an explicit opt-out (and
still reads the legacy `off` spelling).

## Self-hosting

Every convenience in Substrate has a free path; this is the share feature's.
The relay is one dependency-free Node script after compilation. From this repo:

```sh
npx esbuild scripts/handoff-relay/serve.ts --platform=node --format=esm \
  --target=node18 --outfile=/tmp/substrate-handoff.mjs
node --check /tmp/substrate-handoff.mjs
PORT=8787 HANDOFF_DIR=/var/lib/handoff node /tmp/substrate-handoff.mjs
```

Front it with any TLS-terminating proxy (Caddy, nginx) — https is required in
practice because browsers gate WebCrypto (the viewer's decrypt) to secure
origins. Then put the public URL into Substrate → Settings → **Share relay
URL** (e.g. `https://drop.example.org`). The desktop app rejects loopback,
LAN and private-address relay targets as an SSRF guard, so the configured
origin must be public HTTPS even when the service itself runs on your box.

Environment:

| var | default | meaning |
| --- | --- | --- |
| `PORT` | `8787` | listen port |
| `BIND` | `127.0.0.1` | listen address (put the proxy in front) |
| `HANDOFF_DIR` | `./handoff-data` | where ciphertext lives |
| `HANDOFF_MAX_BYTES` | 32 MiB | per-payload hard cap |
| `HANDOFF_MAX_TOTAL` | 1 GiB | exact serialized ceiling for payload, metadata and in-flight temp files |
| `HANDOFF_MAX_ENTRIES` | 4096 | live-entry ceiling (inode and directory-scan guard) |
| `HANDOFF_MAX_CONCURRENT_STORES` | 2 | application-level upload concurrency cap |
| `HANDOFF_TOKEN` | unset | if set, `POST /api/store` requires this bearer token — claims stay open (recipients have no account by design). The app sends it when Settings → Share relay token is set. |

Expiry: links live for 1, 7 or 30 days, or burn after the first open. The
sweep runs every 10 minutes; unopened burn links age out after 7 days. A
burn is enforced with an atomic rename, so two readers racing the same
one-shot link resolve to exactly one winner. (A crash mid-claim can leave
the already-claimed ciphertext on disk up to an hour before the sweep
removes it — the link is dead either way.)

Honesty note (mirrored in the app's UI): expiry limits *access from now on*.
It cannot un-save a copy a recipient already kept — treat "burn after
reading" as a courtesy default, not a security boundary against the person
you sent it to.

The decrypted note is displayed in an iframe sandbox without script or
top-level-navigation privileges. Links inside shared content may be visible
without being allowed to navigate the recipient away from the viewer; copy a
destination explicitly when needed.

## Wire format

`payload = "SBH1" ++ iv(12 bytes) ++ AES-256-GCM ciphertext` — sealed by
`src/lib/handoff.ts` (`sealHandoff`), opened by the viewer page embedded in
`serve.ts`. The three ship in lockstep; bump the magic when the format
changes.

`POST /api/store` (header `x-handoff-expiry: burn|1d|7d|30d`) → `{"id"}` ·
`GET /h/<id>` → viewer page (a GET never burns — link-preview bots GET) ·
`POST /api/claim/<id>` → payload bytes, one-shot for burn entries.

## Letterbox

The same relay carries the inbound direction: a standing drop link anyone can
send to. The app registers a mailbox here and shows a URL of the shape
`https://<relay>/d/<box-id>#<age1-recipient>`. Opening it serves a sealing page
that encrypts the message and any attachments **in the sender's browser** to
the vault's public key — the part after `#` never reaches the server — and
uploads only ciphertext. The vault polls the box, decrypts locally, lands each
drop as a note, and acks; the relay then deletes the ciphertext.

The relay never sees a recipient key, a plaintext, or who anybody is. It holds
opaque box ids, an owner token per box, sealed bytes and timestamps.

**Upgrading a running relay:** the letterbox is on by default and brings its
own storage pool — a default 1 GiB *on top of* the handoff ceiling, not carved
out of it — so plan disk for both, or set `LETTERBOX_DISABLED=1` to keep the
relay handoff-only.

**Anonymous registration.** If `HANDOFF_TOKEN` is unset, `POST
/api/box/register` is open to anyone, exactly as `/api/store` is: strangers can
create boxes on your relay. What bounds it: the live-box ceiling
(`LETTERBOX_MAX_BOXES`, 256), the letterbox storage ceiling, the tighter per-IP
register rate zone in `deploy/nginx.conf`, and the idle sweep — a box with
nothing pending that nobody registers to, drops into, polls or acks for
`LETTERBOX_BOX_IDLE_TTL_MS` (90 days) is removed, so abandoned boxes do not
accumulate for the life of the process. A relay open to the public internet
should set `HANDOFF_TOKEN`.

The same operator caveat as above applies, and applies harder: the relay serves
the sealing JavaScript, so a hostile operator could serve a version that keeps
a copy of what the sender typed. Use an operator you trust, or self-host and
audit the page you serve. After a successful upload the page prints the
ciphertext's SHA-256, which sender and recipient can compare over another
channel.

Endpoints:

| endpoint | auth | meaning |
| --- | --- | --- |
| `POST /api/box/register` | relay upload token, if set | body `{"mode":"standing\|one-shot","expiry":"1d\|7d\|30d"}` (both optional) → `{"id","token","mode","expiry"}` |
| `GET /d/<box>` | none | the sealing page |
| `POST /api/box/<box>/drop` | none — the link is the capability | body = `"SBL1"` + age ciphertext → `{"id","bytes"}` |
| `GET /api/box/<box>/drops` | box token | pending drops the owner has not claimed |
| `POST /api/box/<box>/claim/<drop>` | box token | ciphertext bytes, leased to this poller for 10 minutes |
| `DELETE /api/box/<box>/drops/<drop>` | box token | ack — the drop landed, delete it |
| `DELETE /api/box/<box>` | box token | revoke the box and every drop still in it |

Claim is an atomic rename, so two devices polling one box never land the same
drop twice; a poller that dies mid-landing leaves a lease that the sweep
returns to the pool after ten minutes, so a crash re-offers a drop rather than
losing it. A `one-shot` box refuses a second drop with 410 and removes itself
once its single drop is acked.

Caps: 32 MiB per drop on the wire (16 MiB of raw attachments and 64 KiB of text
before encryption), 64 pending drops and 256 MiB per box, and a letterbox-wide
storage ceiling that is **separate from the handoff one** — a flood of drops
cannot evict pending handoffs, and a full handoff pool does not close the
letterbox. Drops expire on the box's TTL (default 30 days) and the same
ten-minute sweep removes them. The honesty note above about expiry applies
unchanged: it limits access from now on, it cannot un-send anything.

Letterbox environment:

| var | default | meaning |
| --- | --- | --- |
| `LETTERBOX_DISABLED` | unset | `1` makes every box endpoint (and `/d/<id>`) a 404 — a handoff-only relay |
| `LETTERBOX_MAX_TOTAL` | 1 GiB | letterbox storage ceiling, independent of `HANDOFF_MAX_TOTAL` |
| `LETTERBOX_MAX_BOXES` | 256 | live-box ceiling |
| `LETTERBOX_MAX_DROPS_PER_BOX` | 64 | pending drops one box may hold |
| `LETTERBOX_MAX_BOX_BYTES` | 256 MiB | pending ciphertext one box may hold |
| `LETTERBOX_LEASE_MS` | 600000 | how long a claimed drop stays leased to one poller |
| `LETTERBOX_BOX_IDLE_TTL_MS` | 7776000000 (90d) | an empty box unused for this long is removed |

Ciphertext lives under `<HANDOFF_DIR>/letterbox/<box-id>/`. Setting
`LETTERBOX_DISABLED=1` on a relay that already carries boxes turns the
endpoints into 404s and stops sweeping that tree — the ciphertext already there
stays on disk, untouched and unreachable, until the relay is re-enabled or an
operator deletes the directory by hand.

### Building the sealing page

The sealing page needs a real age implementation, so it is bundled once at
build time and checked in as `sealing-page.generated.ts`; the relay itself
stays dependency-free at runtime and self-hosting remains the single esbuild
above. Rebuild after changing `sealing-page/main.ts`:

```sh
node scripts/handoff-relay/sealing-page/build.ts
```

`--check` rebuilds in memory and exits nonzero if the checked-in bundle has
drifted from `main.ts`, without writing anything:

```sh
node scripts/handoff-relay/sealing-page/build.ts --check
```

## Production service

The checked-in `deploy/` files are the production shape used by the hosted
instance and a reusable starting point for self-hosters:

- compile `serve.ts` to an artifact and run `node --check` on it;
- install it with `deploy/install-release.sh`, which keeps immutable hashed
  releases, atomically switches `current.mjs`, health-checks, and rolls back on
  failure;
- install `deploy/handoff-relay.service` as a systemd unit;
- use `deploy/nginx-bootstrap.conf` for the first ACME challenge, then replace
  it with `deploy/nginx.conf` as the TLS proxy site (replace the hostname if
  needed). The final shape buffers request bodies to disk, applies per-IP
  upload/read rates and connection caps (including the separate per-IP zone
  for letterbox drops, which arrive from strangers holding a link, and a
  tighter one for box registration, the only endpoint that creates state), and
  disables access logs;
- keep `/var/lib/substrate-handoff` on persistent storage and leave
  `HANDOFF_TOKEN` unset only when uploads are intentionally public.

Before certificate issuance or firewall changes, verify both `dig +short A`
and `dig +short AAAA` point only at this host (remove an unintended AAAA rather
than serving half the clients elsewhere). Obtain the certificate with Certbot,
then run `nginx -t` before reload. After deployment, verify `GET /` over HTTPS,
then store, view and claim a real sealed test payload through the public origin.
Stored blobs are outside the release directory and survive updates/rollbacks.

One fresh-Ubuntu sequence (replace the hostname and email when self-hosting):

```sh
sudo apt-get update
sudo apt-get install -y nginx nodejs certbot
sudo useradd --system --home-dir /var/lib/substrate-handoff \
  --shell /usr/sbin/nologin substrate-handoff
sudo install -d -o substrate-handoff -g substrate-handoff -m 0700 \
  /var/lib/substrate-handoff
sudo install -m 0644 deploy/handoff-relay.service \
  /etc/systemd/system/substrate-handoff.service
sudo install -m 0755 deploy/install-release.sh \
  /usr/local/sbin/substrate-handoff-install
sudo systemctl daemon-reload
sudo systemctl enable substrate-handoff
sudo /usr/local/sbin/substrate-handoff-install /tmp/substrate-handoff.mjs

# Prepare a non-content bootstrap before opening the firewall. Only continue
# after A/AAAA preflight points at this host.
sudo install -d -m 0755 /var/lib/letsencrypt/.well-known/acme-challenge
sudo install -m 0644 deploy/nginx-bootstrap.conf \
  /etc/nginx/sites-available/substrate-handoff
sudo unlink /etc/nginx/sites-enabled/default
sudo ln -sfn /etc/nginx/sites-available/substrate-handoff \
  /etc/nginx/sites-enabled/substrate-handoff
sudo nginx -t
sudo systemctl enable --now nginx
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo certbot certonly --webroot -w /var/lib/letsencrypt \
  --agree-tos --no-eff-email -m <email> -d drop.substrate.zone
sudo install -m 0644 deploy/nginx.conf \
  /etc/nginx/sites-available/substrate-handoff
sudo nginx -t
sudo systemctl reload nginx
```

Initial operations check: `systemctl status substrate-handoff nginx`,
`journalctl -u substrate-handoff --since today`, and
`du -sh /var/lib/substrate-handoff`. A sustained run of 429/503/507 responses
is a capacity or abuse signal to investigate, not a reason to silently raise
the checked-in limits.
