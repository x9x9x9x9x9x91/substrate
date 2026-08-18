# Hosted sync encrypted blob protocol v1

This is the client/server wire contract for Substrate's hosted-sync transport:
the encrypted-blob store a vault syncs through when it is not using a plain Git
remote. It is a self-contained specification — everything a server or client
implementer needs is in this file. It is intentionally a dumb blob protocol: the
server authenticates the caller (and, in a multi-tenant deployment, enforces
quotas), but receives no vault key,
Git object ID, branch name, path, content, commit message, author, or history
edge in plaintext. All Git graph work and merge/conflict handling stays on the
client.

Status: executable client and single-tenant server, both in this repository,
and wired into the app: a vault remote saved as `blob+https://<server>` routes
push and pull through this transport (`src-tauri/src/gitsync.rs` dispatches on
the URL prefix), and the Sync pane's passphrase field drives the §1 wrap via
the key document below. `src-tauri/src/gitsync/blob.rs` implements
the crypto and Git object import/export behind a `BlobTransport` trait with two
implementations: `FileBlobStore`, an in-process model used by the unit tests,
and `HttpBlobStore`, which speaks §2.1 to a real server. `hosted-sync-server/`
is that server — single-tenant, one bearer token, ciphertext only (§7). The
round-trip test in `blob.rs` runs the server's own library on a localhost socket,
so what the suite proves is the wire protocol, not a model of it.

The account surface, multi-tenant service, and production recovery flow remain
separate work; this server has no accounts, quotas, or
tenancy and must not be exposed as if it did.

`FileBlobStore`'s ref CAS is linearizable only among callers sharing one
process, which is why it is a test model and not a deployment target. The
shipped server serializes ref reads and swaps under one lock and publishes
through an atomic rename, giving the cross-process linearizability §2 requires
for the single-tenant case; a multi-process or multi-host deployment of the same
storage root would not, and is out of scope for v1.

## 1. Cryptographic suite and key hierarchy

- Each vault has one 32-byte master key generated with the operating system
  CSPRNG. It never leaves a client unwrapped.
- Authenticated encryption is XChaCha20-Poly1305 with a fresh random 24-byte
  nonce per envelope and its 16-byte authentication tag appended to the
  ciphertext. A nonce is public and stored in the envelope.
- HKDF-SHA-256 derives separate 32-byte domains from the master key:
  `substrate/hosted-sync/object-key/v1` (salt = that envelope's nonce),
  `substrate/hosted-sync/ref-key/v1` (salt = that envelope's nonce), and
  `substrate/hosted-sync/object-name/v1` (empty salt).
- Object names are lowercase hex HMAC-SHA-256(name key, raw 20-byte Git OID).
  This is deterministic for one vault, allowing LIST to identify already
  uploaded objects without revealing an unkeyed Git hash. Different vaults
  produce unrelated names for identical content.
- The master key is passphrase-wrapped with Argon2id v1.3 at 65,536 KiB,
  three iterations, one lane, a fresh random 16-byte salt, and a 32-byte
  output key. That key encrypts the master key with XChaCha20-Poly1305 and AAD
  `substrate/hosted-sync/master-key-wrap/v1`.

Passphrases enter Argon2id as UTF-8 bytes after Unicode NFC normalization. The
prototype crypto API accepts those canonical bytes directly; the later app
surface owns normalization before wrap and unwrap so visually identical input
has the same byte representation across platforms.

The v1 Git OID field is exactly 20 bytes (SHA-1 repositories, which is what the
current libgit2 vault format creates). A future Git hash transition requires a
new envelope version rather than guessing from length.

## 2. Server operations

All routes require service authentication. Account/vault identifiers are
transport routing values and are not derived from the master key.

| Operation | Request | Success | Required semantics |
| --- | --- | --- | --- |
| LIST objects | vault | ordered or unordered array of 64-char opaque names | Complete snapshot of names visible to the authenticated vault; pagination must be snapshot-consistent and the client must cap names/bytes accepted. |
| GET object | vault + opaque name | exact envelope bytes | No content transformation; missing is distinct from transient failure; adapters stop after the negotiated maximum plus one byte. |
| PUT object | vault + opaque name + envelope | stored/already present | Immutable and idempotent. A repeat name may only preserve the existing bytes or atomically replace them with the supplied complete envelope; never expose a partial write. |
| GET ref | vault | encrypted ref bytes + opaque version token, or absent | The version token changes whenever bytes change. |
| CAS ref | vault + expected version/absent + encrypted bytes | new version token, or mismatch | Linearizable compare-and-swap. Mismatch never changes the ref. |
| GET key | vault | wrapped-master-key envelope + opaque version token, or absent | Same document semantics as the ref: opaque bytes, versioned. |
| CAS key | vault + expected version/absent + wrap envelope | new version token, or mismatch | Linearizable compare-and-swap. Create-if-absent is what keeps two enrolling devices from clobbering each other's key; If-Match swaps for a deliberate re-wrap (passphrase change — a server capability, no client flow yet; see §5 on what the client still owes). |

The server validates authentication, quota, rate, object-name syntax, and
maximum request size. It does not validate ciphertext structure. Production
caps are a server-spec decision; the client prototype refuses a single Git
object over 64 MiB, an encrypted ref over 4 KiB, or a LIST over 100,000 names
to bound allocations while the product's large-asset and quota policy is
unresolved.

The file model uses string errors because it has no retry policy. Production
adapters must preserve typed missing, authentication/authorization, quota, and
transient transport failures rather than flattening them into one response.

## 2.1 HTTP binding

The wire form of §2 is plain HTTP/1.1, one request per connection (every
response carries `Connection: close` and an explicit `Content-Length`).
Envelopes travel as raw bytes with `Content-Type: application/octet-stream`;
nothing is base64'd, wrapped in JSON, or content-negotiated.

Authentication is `Authorization: Bearer <token>` on every request, compared in
constant time and checked *before* routing, so an unauthenticated caller cannot
distinguish a real route from any other path. The token is the only credential;
it is opaque to the protocol and at least 16 characters.

The check happens after the request head and *before* the body is read, so an
unauthenticated `Content-Length` never buys a stranger an allocation or a long
read. The visible consequence: a client that sends a bad token with a body may
see a write error rather than a clean `401`, because the server answers and
closes while the body is still in flight. An authenticated client never hits
that path.

| Operation | Request | Success | Failure |
| --- | --- | --- | --- |
| health | `GET /v1/health` | `200` + `ok` | — |
| LIST objects | `GET /v1/objects` | `200`, body = newline-separated 64-char names | `500` |
| GET object | `GET /v1/objects/<name>` | `200` + exact envelope bytes | `404` absent, `400` malformed name |
| PUT object | `PUT /v1/objects/<name>` + envelope | `201` stored, `200` already present | `400` malformed name or empty body, `413` over the size cap |
| GET ref | `GET /v1/ref` | `200` + ref envelope, `ETag: "<version>"` | `404` no ref yet |
| CAS ref | `PUT /v1/ref` + `If-Match: "<version>"` \| `If-None-Match: *` | `204` + new `ETag` | `412` version mismatch, `428` neither precondition, `400` empty body, `413` over the cap |
| GET key | `GET /v1/key` | `200` + wrap envelope, `ETag: "<version>"` | `404` no key yet |
| CAS key | `PUT /v1/key` + same preconditions as the ref | `204` + new `ETag` | same as CAS ref; the body cap is the ref's 4 KiB (the `SBK1` envelope is ~100 bytes) |

Any route can answer `401` (bad or missing token) or `503` (the server is at
its connection cap, below).

The `ETag` value is the opaque version token of §2. It is a concurrency token
only: authenticity comes from the envelope's AEAD tag, never from the ETag.

Requiring one of the two preconditions on `PUT /v1/ref` is deliberate — there is
no way to spell "overwrite whatever is there." `If-None-Match: *` creates the
first ref and fails with `412` if one already exists; `If-Match` swaps a known
one. A `412` is contention, not an error: the client re-reads and retries, and
`HttpBlobStore` surfaces it as `CasResult::Mismatch` rather than a transport
failure. Likewise a `404` on GET object means *absent*, which §2 requires to
stay distinct from a transient failure.

Transfer coding is not supported: a request with `Transfer-Encoding` is rejected
with `411`, so every body length is known before a byte is read. Request heads
are capped at 8 KiB (`431` beyond it) and bodies at the route's §2 cap (`413`),
both enforced before allocation. Read and write both carry a 60-second deadline
(`408` on a stalled head).

The server serves one connection per thread and caps concurrent connections at
64; over the cap it answers a bare `503` on the accept thread and closes,
without spawning anything. One person's devices need a handful of connections,
so the cap is invisible in normal use and is what stops a stranger with a
socket generator from turning thread-per-connection into the host's memory.
A `503` is transient: retry.

Clients must not follow redirects — `HttpBlobStore` sets a redirect limit of
zero, because following one would hand the bearer token to whatever host the
response named. For the same reason it refuses a base URL carrying userinfo or a
query string, either of which could leak the credential through an error
message, and refuses any scheme other than `http`/`https`.

## 3. Binary envelopes

Integers are unsigned big-endian. All literal strings below are ASCII.

### Object `SBO1`

Outer bytes:

1. magic `SBO1` (4 bytes)
2. random nonce (24 bytes)
3. XChaCha20-Poly1305 ciphertext and tag

The associated data is the 64-byte ASCII opaque object name, binding a valid
envelope to its storage key. Decrypted plaintext is:

1. Git OID (20 bytes)
2. Git type (1 byte: commit=1, tree=2, blob=3, tag=4)
3. content length (8 bytes)
4. raw loose-object content (exactly that length)

On download the client authenticates before parsing, recomputes the HMAC name,
writes `(type, content)` through libgit2's object database, and requires the
returned Git OID to equal the embedded OID. Failure at any step rejects the
pull before checkout.

### Ref `SBR1`

Outer bytes are magic `SBR1`, random 24-byte nonce, then ciphertext and tag.
AAD is `substrate/hosted-sync/ref/v1`. The plaintext is strict UTF-8 JSON:

```json
{"version":1,"branch":"main","head":"40-lowercase-hex-git-oid"}
```

The ref deliberately contains only one branch head. The branch name and graph
remain encrypted. An unsupported version or a branch mismatch is a hard stop.

### Passphrase wrap `SBK1`

Bytes are magic `SBK1`; Argon2 memory KiB, iterations, and lanes (4 bytes each);
salt (16 bytes); nonce (24 bytes); and the 32-byte encrypted master key plus
tag. V1 readers accept only the pinned parameter tuple above. Parameter changes
use a new written envelope (or a new version if layout/meaning changes).

The wrap envelope is stored server-side as the vault's key document (§2), so
enrolling a new device needs the server address, the service token, and the
passphrase — nothing is hand-carried between devices. The server holds only
the envelope: without the passphrase it is 32 random-looking bytes behind
Argon2id, and the passphrase never leaves a client.

## 4. Client algorithms

Push reads the remote ref and CAS version first. If its head is not already an
ancestor of local HEAD, push stops with “pull and merge first.” The client walks
all commits reachable from local HEAD plus their trees and blobs, HMACs their
OIDs, LISTs remote names, and uploads missing encrypted objects. Last, it CAS
updates the encrypted ref. A CAS loss leaves only harmless immutable orphan
uploads and tells the client to pull and merge.

Pull gets and decrypts the ref, computes the opaque name of its head, and then
GETs the reachable graph on demand. Each downloaded envelope is authenticated,
its embedded Git OID is verified unconditionally, and its commit/tree child
OIDs determine the next opaque names to GET. Locally present objects need not be
downloaded. Before changing a tracking ref or checking out, this walk resolves
every parent, tree, subtree, and blob; a missing object therefore fails before
the non-transactional checkout can write part of a worktree. It then calls the
existing `gitsync.rs` local pull phase, preserving fast-forward, three-way
merge, parked-conflict, safe checkout, and concurrent-write guards. A new device
downloads the complete graph reachable from the ref, but not unreachable
ciphertext retained after a history rewrite.

Pull orders its phases the way the Git transport's auto-sync path does, because
the same timer drives both: read the remote ref first, and if its head is
already reachable locally take the idle path — no graph walk, and the app-file
backfill only when the working tree is clean, deferred otherwise. Only a pull
that has something to
integrate snapshots the vault and enters the write gate. A pull therefore does
not refuse a mid-edit vault (snapshotting it is the point); the checkout itself
is still guarded under the gate, alongside the §4 purge re-check.

Every graph edge carries an expected Git type: the ref head and commit parents
must be commits, a commit's tree must be a tree, and tree entries must resolve
to their encoded tree/blob kind. Gitlinks are unsupported and fail before any
tracking-ref or worktree change. A device carrying the local history-rewrite
marker refuses pull entirely until the hosted vault is replaced or
re-initialized, so a stale remote cannot re-import the graph a purge removed.
That marker is read twice: once before the network, and again under the write
gate immediately before any object is imported. Only the second check is
load-bearing — a purge that lands while the ref is in flight would otherwise be
raced by the import, which writes decrypted objects into the local object
database. Object GETs therefore run inside the write gate. An adapter that
cannot accept that latency must stage authenticated envelopes outside the gate
and import them under it; it may not move the check.

History rewrites do not delete already-uploaded ciphertext in v1. The ref makes
old objects unreachable and demand-driven pull does not re-import them, but
physical server erasure needs a privacy-preserving retention/garbage-collection
design before production.

## 5. Trust boundary and failure rules

The operator still sees account identity, vault identity/count, stable
per-vault equality of opaque object names, object count, individual and
aggregate ciphertext sizes, upload batches, access timing, IP/network
metadata, and churn in the ref version. It can infer coarse activity cadence
and batch shape, but not plaintext Git graph edges. Padding, private information
retrieval, traffic obfuscation, shared-vault membership, key rotation,
multi-vault recovery, and server-side garbage collection are not v1 claims.

The passphrase is the security floor. The operator holds the wrapped-key
envelope (§3) and can test passphrase guesses against it offline, priced only
by Argon2id's per-guess cost — there is no server-side rate limit on a copy.
A weak passphrase therefore undoes the encryption; user-facing copy says so.
Envelopes are also not bound to a vault identity: isolation between vaults
comes from single-tenant deployment (one token, one vault, one store), not
from the ciphertext. A future multi-tenant operator could cross-serve two
vaults that share a passphrase; binding the wrap AAD to a vault identity is
part of any multi-tenant design, not a v1 claim.

The server controls availability and can omit objects or replay an older valid
ref to a new device. Authentication detects modification and cross-name swaps,
but v1 has no external transparency log or cross-device gossip to prove
freshness against a malicious rollback. Existing devices refuse a remote head
that is not compatible with their local graph; a brand-new device cannot know
that an authenticated old head is stale. The production threat model and
recovery UI must say this plainly.

A server may also pre-poison: store envelopes of its own choosing under object
names before a client ever uploads them, so that a later PUT of the same name
finds the slot occupied and a later GET returns the operator's bytes. This fails
closed on the client. Names are HMACs under a key the server never holds, so it
cannot aim a forgery at a name a client will actually request; if it does hit
one, the envelope is decrypted with the vault key and its AAD is that same
64-character name, so fabricated or relocated bytes fail authentication. Bytes
that somehow authenticate are still hashed through libgit2 and required to equal
the OID embedded in the plaintext. A poisoned object therefore aborts the pull
before any tracking-ref or worktree change; it cannot substitute content. It
remains a denial-of-service vector, like omitting the object outright, and PUT's
idempotence rule means an occupied name must never silently mask a client's
upload.

Authentication failure, wrong passphrase/key, swapped object name, modified
ciphertext, malformed length/type/OID, missing head object, stale CAS token,
wrong branch, dirty worktree, and non-fast-forward push all fail closed. No
client ever force-updates a ref after a CAS race. The transport is wired into
the app behind the `blob+` remote type and rides the repository's full test
gates; what it still owes before being offered beyond an attended,
operator-run deployment is a passphrase-change/recovery UX and product copy
for the freshness caveats above.

## 6. Executable evidence

The Rust tests cover passphrase wrap and wrong-passphrase rejection,
ciphertext/wrong-key tamper rejection, unconditional Git hash verification,
bounded object/ref/LIST reads, missing parent/tree/blob preflight, stale CAS
refusal, first-device upload, second-device reconstruction, divergent push
refusal, the existing local merge path, and the return trip to the first
device. They also prove that pull does not import an unrelated retained object.
Malformed head/parent/tree-entry types and post-purge pulls fail before checkout
or tracking-ref movement.

Four tests pin the §4 and §5 rules that are easiest to regress silently: a purge
landing inside the write gate aborts the pull with no object imported, no
tracking ref, and no file on disk; a push from a rewritten history names the
purge instead of reporting ordinary divergence; a replayed older ref is shown to
mislead a brand-new device while an existing device neither rolls back nor
merges, and heals the ref on its next push; and a truncated or extended
passphrase envelope is rejected at every length rather than reaching Argon2.

Nine further tests run the shipped server on a real localhost socket and drive it
through `HttpBlobStore`, so the §2.1 binding is covered as deployed rather than
as described — among them enrollment itself: a first device creates and
publishes the wrapped key, a second unwraps it from the passphrase alone, a
wrong passphrase is refused, and a lost creation race adopts the winner's key
(the race driven through a transport double). A tenth exercises the whole app
seam: `sync_set_remote` with a `blob+` URL enrolls against the real server,
then the same gated push and pull the commands call route through the blob
transport, and a second vault joins and pulls the first one's note. The load-bearing one pushes test vault A, pulls test vault B, and
asserts that every file A holds is byte-identical in B (B gains only the app
backfill of a landing pull, nothing else) and that the server's storage
directory contains none of the plaintext markers either vault wrote — no note
body, no note title, no path segment — while holding ≥4 objects under opaque
64-character names. A second sends B's own commit back through the server to A.
The rest pin the distinctions §2.1 makes: a wrong token is
named as such in the client error, a CAS race is contention rather than failure,
an absent object is not a transport failure, an object is immutable across a
repeat PUT, a base URL carrying credentials or a foreign scheme is refused, a
pull that brings nothing takes the idle path, and a pull with work to do
snapshots a mid-edit vault instead of refusing it.

The server's own suite covers token length and constant-time comparison, object
name syntax as the traversal defence, immutable publish under a concurrent PUT,
ref CAS against a stale version, and key CAS refusing to clobber an existing
key while allowing an If-Match re-wrap. Four tests drive real sockets: an
unauthenticated upload that declares four megabytes and sends none of them is
still answered `401`, an empty ref body is `400`, the connection past the
cap gets `503`, and the key route stores and returns the wrapped key with the
ref's precondition rules.

All vaults and blob stores are temporary test directories; no `~/Vault` path is
read or written.

## 7. The single-tenant server

`hosted-sync-server/` is a standalone crate with **no dependencies at all** — a
hand-rolled HTTP/1.1 subset over `std::net`. That is a deliberate cost: this is
the only Substrate code that runs on a host the user does not sit at, so the
whole of it must be auditable in one sitting, and it must not inherit a
transitive supply chain to hold ciphertext in a directory.

It is single-tenant by construction: one bearer token, one storage root, one
ref. There are no accounts, quotas, rate limits, or tenancy, and adding them is
a different piece of work — the connection cap is a resource bound, not a rate
limit, and per-IP rate limiting belongs in the proxy in front. Do not put it in
front of more than one person's vault.

Configuration is environment-only, so a supervisor owns the credential and this
repository can never ship it:

- `SUBSTRATE_BLOB_ADDR` — listen address, default `127.0.0.1:8787`
- `SUBSTRATE_BLOB_DIR` — storage root, required
- `SUBSTRATE_BLOB_TOKEN` — bearer token, required, 16+ characters

The default address is loopback on purpose. The bearer token is the only
credential and must not cross a network in the clear, so exposing the store
means putting a TLS terminator in front of it. On startup the process prints
`listening <addr>` on one stdout line, which is the readiness signal a
supervisor or script should wait for. The alp1 deployment — systemd unit, the
route on the nginx that already terminates the host's one name, release
install and rollback — lives in `hosted-sync-server/deploy/`, which is also
where the store's one unrehearsed gap is written down: backups.

Storage layout is flat: every object is a file named by its 64-character opaque
name, and the ref lives beside them. Objects are published by writing a staging
file and hard-linking it into place, so a concurrent PUT of the same name can
never replace bytes another client already read; the ref is published by atomic
rename under a lock. Both publishes flush the staged bytes and then the
destination's parent directory before answering, and a failure to flush fails
the request: a `201` or `204` is a promise that the object, ref, or key survives
losing power at that instant, and the key is the one file whose loss takes the
history with it. `storage_contains` is exported from the library for exactly
one purpose — asserting that a storage root holds none of a known plaintext,
whether in the test suite or against a real deployment.

The server validates authentication, object-name syntax, and size only. It never
parses an envelope, and nothing in it can decrypt one.
