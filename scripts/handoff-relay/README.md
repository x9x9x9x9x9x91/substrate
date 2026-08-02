# Handoff relay

The dumb store behind **Send as link** (right-click a note). The app renders
the note to one self-contained HTML document, encrypts it locally with
AES-256-GCM, and uploads only the ciphertext here. The decryption key travels
in the link's `#fragment`, which browsers keep client-side — the relay never
sees it, so it cannot read what it stores. Recipients need nothing but a
browser.

What the relay knows about a handoff: an opaque id, a blob of ciphertext, an
expiry policy, timestamps. That's the complete list.

## Self-hosting

Every convenience in Substrate has a free path; this is the share feature's.
The relay is one dependency-free Node script:

```sh
PORT=8787 HANDOFF_DIR=/var/lib/handoff node serve.ts
```

Front it with any TLS-terminating proxy (Caddy, nginx) — https is required in
practice because browsers gate WebCrypto (the viewer's decrypt) to secure
origins. Then put the public URL into Substrate → Settings → **Share relay
URL** (e.g. `https://drop.example.org`).

Environment:

| var | default | meaning |
| --- | --- | --- |
| `PORT` | `8787` | listen port |
| `BIND` | `127.0.0.1` | listen address (put the proxy in front) |
| `HANDOFF_DIR` | `./handoff-data` | where ciphertext lives |
| `HANDOFF_MAX_BYTES` | 32 MiB | per-payload hard cap |
| `HANDOFF_MAX_TOTAL` | 1 GiB | refuse new stores past this disk usage (a guard, not an exact quota — concurrent uploads can overshoot by a few payloads) |
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

## Wire format

`payload = "SBH1" ++ iv(12 bytes) ++ AES-256-GCM ciphertext` — sealed by
`src/lib/handoff.ts` (`sealHandoff`), opened by the viewer page embedded in
`serve.ts`. The three ship in lockstep; bump the magic when the format
changes.

`POST /api/store` (header `x-handoff-expiry: burn|1d|7d|30d`) → `{"id"}` ·
`GET /h/<id>` → viewer page (a GET never burns — link-preview bots GET) ·
`POST /api/claim/<id>` → payload bytes, one-shot for burn entries.
