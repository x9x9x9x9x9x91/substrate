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

Status: executable client and server, both in this repository,
and wired into the app: a vault remote saved as `blob+https://<server>` routes
push and pull through this transport (`src-tauri/src/gitsync.rs` dispatches on
the URL prefix), and the Sync pane's passphrase field drives the §1 wrap via
the key document below. `src-tauri/src/gitsync/blob.rs` implements
the crypto and Git object import/export behind a `BlobTransport` trait with two
implementations: `FileBlobStore`, an in-process model used by the unit tests,
and `HttpBlobStore`, which speaks §2.1 to a real server. `hosted-sync-server/`
is that server — one operator token over the vault, ciphertext only (§7). The
round-trip test in `blob.rs` runs the server's own library on a localhost socket,
so what the suite proves is the wire protocol, not a model of it.

The account surface, the hosted service, and production recovery flow remain
separate work; this server has no accounts and must not be exposed as if it
did. It does carry namespaces beside the vault — spaces, with their own tokens
and storage ceilings (§7).

`FileBlobStore`'s ref CAS is linearizable only among callers sharing one
process, which is why it is a test model and not a deployment target. The
shipped server serializes ref reads and swaps under one lock and publishes
through an atomic rename, giving the cross-process linearizability §2 requires
for a one-process deployment; a multi-process or multi-host deployment of the same
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
| LIST objects | vault + optional cursor | array of 64-char opaque names, plus a cursor and whether the answer is complete or incremental | Without a cursor: complete snapshot of names visible to the authenticated vault. With one the server may answer only the names added after it, and must answer completely instead whenever it cannot vouch for continuity from that cursor. Pagination must be snapshot-consistent and the client must cap names/bytes accepted. |
| GET object | vault + opaque name | exact envelope bytes | No content transformation; missing is distinct from transient failure; adapters stop after the negotiated maximum plus one byte. |
| PUT object | vault + opaque name + envelope | stored/already present/conflict | Immutable and idempotent. A repeat name may only preserve the existing bytes or atomically replace them with the supplied complete envelope; never expose a partial write. A server that finds the stored length different from the supplied one may report a conflict instead of "already present" — an envelope's length is fixed by the object inside it while its ciphertext is not, so a length difference proves the occupant is a different object. Clients must not require this: it is a server's option, and push's own verification is what does not depend on it. |
| GET ref | vault | encrypted ref bytes + opaque version token, or absent | The version token changes whenever bytes change. |
| CAS ref | vault + expected version/absent + encrypted bytes | new version token, or mismatch | Linearizable compare-and-swap. Mismatch never changes the ref. |
| GET key | vault | wrapped-master-key envelope + opaque version token, or absent | Same document semantics as the ref: opaque bytes, versioned. |
| CAS key | vault + expected version/absent + wrap envelope | new version token, or mismatch | Linearizable compare-and-swap. Create-if-absent is what keeps two enrolling devices from clobbering each other's key; If-Match swaps for a deliberate re-wrap (a passphrase change: the client reads the current envelope, unwraps, re-wraps under the new phrase, and swaps at the version it read, so a change racing another device's loses instead of clobbering it). |

The server validates authentication, quota, rate, object-name syntax, and
maximum request size. It does not validate ciphertext structure. Production
caps are a server-spec decision; the client prototype refuses a single Git
object over 64 MiB, an encrypted ref over 4 KiB, or a LIST over 100,000 names
to bound allocations while the product's large-asset and quota policy is
unresolved. §2.2 covers what the object ceiling means in practice and what a
client owes the user before reaching it.

### 2.2 Incremental listing

LIST answers grow with the store, not with the change being pushed: a vault of
a few thousand objects already re-downloads every name on every push, and the
100,000-name ceiling is a wall on a multi-year horizon rather than a
theoretical one. The negotiation below removes the first cost and makes the
second visible early. It does not raise the ceiling.

The server keeps its object names in acceptance order and issues an opaque
**cursor** naming a position in that order. A client that has one may present
it; the server then answers with the names accepted after it, and says so.
The cursor is opaque: it carries no time, no count the name list does not
already imply, and nothing a client may parse.

Two rules on the server make this safe.

The first: **a complete listing is ground truth, every time.** Every answer
that is not a delta is reconciled against the objects the store actually holds
before it is sent — names the list never recorded are added, and a name whose
object has gone is dropped and retires every cursor the server has ever issued,
so every client falls back to a complete listing and re-learns what the store
holds. Reconciling only at startup is not enough: an object lost while the
server runs would stay listed until it was restarted, and a client would skip
the upload that would have repaired it. A download that finds a listed name
gone reconciles too, because a device that only ever asks incrementally never
reaches a complete listing on its own — that 404 is the one moment it hands the
server evidence of the loss, and without it the rule would hold for some
clients and not others.

Reconciling is a directory scan taken while the name list is locked, so a
complete listing costs one `read_dir` over the whole store and blocks the other
listings and uploads in flight for its duration — a few milliseconds at the
thousands of objects a personal vault holds, and something to revisit long
before the object ceiling in §8 rather than at it.

The second: **a run of the server is a run of names.** Every cursor issued
before a restart is retired by it. That costs each client one complete listing
per restart, and it buys the case nothing inside the storage directory can
otherwise detect — a backup restored consistently, objects and name list
together, which is what `deploy/README.md` asks an operator to do. Such a
restore is indistinguishable from a store that is simply younger, because every
marker that could give it away was restored alongside. Without this rule the
name list regrows into positions an outstanding cursor still names, and that
client silently skips uploads forever.

In the shipped server the cursor is `<epoch>.<position>`, the epoch is 128
random bits drawn on every open and again on any loss and never written to
disk, and any cursor whose epoch differs or whose position is past the end is
answered with the complete listing rather than an error. Random rather than a
counter kept beside the name list: a counter is restorable along with the names
it guards, so a consistent restore would rewind it and the restart would
re-issue a run number already handed out — and a cursor from that earlier run
would then be honored against positions naming different objects, which is
exactly the silent skip the rule exists to prevent.

The client caches the names it has been told about, keyed to the store, in its
own git directory. That cache is deliberately one-directional and is bound by
three rules:

1. It may only ever cause an upload to be **skipped**. It never reports a name
   as absent, and pull does not consult it at all — pull resolves the graph by
   demand from the ref (§4) and is unchanged by any of this.
2. It is only extended when the server explicitly marks its answer incremental
   from the cursor that was sent. Any other answer — an older server, a
   retired cursor, a store that lost names — replaces the cache wholesale.
3. It holds only names the server itself listed. A push never writes its own
   uploads into it, however cleanly they were acknowledged, because a store
   that acknowledged bytes and then lost them would otherwise be believed by
   the one device able to repair it. This costs nothing: the cursor a push
   stores is the store's position from before its uploads, so the next push is
   answered those names out of the server's own list.

What the cache does not cover is an object the server has listed all along and
cannot actually serve. Authenticating a rotating sample of skipped objects on
each push would cover it, and is unbuilt work rather than a defence in place.

A client whose cache is missing, damaged, from another store, or simply
unwritable loses nothing but the saving: it lists completely, exactly as
every client did before this existed.

**Backward compatibility is a client obligation.** A server that predates this
section has no cursor route, and a client must detect that without a probe on
every push. In the HTTP binding (§2.1) the cursor rides as a query parameter on
the existing LIST path, so such a server answers it from its object route with
`404` (or `400` if it read the query as a malformed name). The client treats
a non-success answer to a cursor-carrying request as "no such capability",
repeats the request without the cursor, and proceeds on the complete listing —
a proxy in front of the store may refuse a query string with something else
entirely, and the request without one is what every server understands, so its
answer is the one worth reporting. When no cursor comes back the client caches
nothing and discards any cache it had, because there is nothing to resume from
and a file nobody confirms is a file that would be believed forever.

Three statuses are excluded from that fallback: **`429`, `500` and `503`**.
Each says the route was understood and the store could not serve it — over a
limit, or a scan that broke — and in all three the fallback is the same scan
again, larger, against a server already failing. The client stops with the
status it was given and asks incrementally again on the next push. The cost of
that choice is that a deployment which refuses `?since=` requests with one of
these statuses *permanently* leaves a client with a cached cursor failing every
push, with no automatic self-heal: the alternative — falling back — is the
double-scan amplification this rule exists to stop. The escape hatch is manual
and cheap: delete the client's listing-cache file in its git directory, after
which it lists completely, exactly as every client did before this section
existed.

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
| LIST objects | `GET /v1/objects`, optionally `?since=<cursor>` | `200`, body = newline-separated 64-char names, `X-Substrate-List-Cursor: <cursor>`, `X-Substrate-List-Mode: full \| incremental` | `500`; a server without §2.2 answers a `?since=` request `404`/`400` |
| GET object | `GET /v1/objects/<name>` | `200` + exact envelope bytes | `404` absent, `400` malformed name |
| PUT object | `PUT /v1/objects/<name>` + envelope | `201` stored, `200` already present | `400` malformed name or empty body, `409` the name holds bytes of another length, `413` over the size cap |
| GET ref | `GET /v1/ref` | `200` + ref envelope, `ETag: "<version>"` | `404` no ref yet |
| CAS ref | `PUT /v1/ref` + `If-Match: "<version>"` \| `If-None-Match: *` | `204` + new `ETag` | `412` version mismatch, `428` neither precondition, `400` empty body, `413` over the cap |
| GET key | `GET /v1/key` | `200` + wrap envelope, `ETag: "<version>"` | `404` no key yet |
| CAS key | `PUT /v1/key` + same preconditions as the ref | `204` + new `ETag` | same as CAS ref; the body cap is the ref's 4 KiB (the `SBK1` envelope is ~100 bytes) |

Any route can answer `401` (bad or missing token) or one of the refusals below —
`503` at a connection cap, `503` when the operator's total space budget is
spent, `507` when a space is full. Where two of them share a status, the
`X-Substrate-Refusal` header names which one, so a client never infers a remedy
from a number two conditions can both produce.

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
both enforced before allocation. Read and write carry a 60-second deadline, and
the request head carries a tighter one of its own: 10 seconds from the first
byte of the head to its terminating blank line. The head deadline is the
socket's own read timeout for that phase, not only a check between reads, so a
caller that sends half a head and then goes silent is released on the head
deadline rather than holding a connection slot for the full minute; the
60-second read deadline applies to the body, once the head has parsed. Either
deadline answers `408`.

The server serves one connection per thread and caps concurrent connections at
64. One person's devices need a handful, so the cap is invisible in normal use
and is what stops a stranger with a socket generator from turning
thread-per-connection into the host's memory. How that cap is divided between
the vault and the spaces beside it is below.

### Space routes

A space is a second namespace on the same server: its own storage directory,
its own bearer token, its own ceilings. Its data routes are the vault's routes
above, unchanged in method, body, precondition and status, moved under the
prefix `/v1/s/<space-id>/`. A space id is 32 lowercase hex characters (128 bits
from the operating system pool); nothing in it needs normalizing, which is the
whole of the path-traversal defence for `<root>/spaces/<space-id>`. A path
under `/v1/s/` whose id is not that shape is not a space route at all.

Beside them are three routes the operator owns. Those are the whole management
surface: there is no route to list spaces, to read a token back, or to change a
space's ceilings.

| Operation | Request | Credential | Success | Failure |
| --- | --- | --- | --- | --- |
| mint a space | `POST /v1/spaces` | operator | `201` + `{"id":"<32 hex>","token":"<64 hex>"}` | `507` the mint did not happen (no `X-Substrate-Refusal` — it is an operator answer on an operator route); the expected cause is the 64-space ceiling, which an operator fixes by deleting a space rather than by retrying — but this route collapses *every* failure into `507`, including an unreadable random source and any error creating or persisting the namespace on disk, so an operator seeing it should rule out the disk before assuming the count. `405` other method |
| rotate a space's token | `POST /v1/spaces/<id>/token` | operator | `200` + `{"token":"<64 hex>"}` | `404` no such space, `500` the new token could not be generated or its hash could not be persisted, `405` other method |
| delete a space | `DELETE /v1/spaces/<id>` | operator | `204`, storage gone | `404` nothing is owed for this id, `503` + `X-Substrate-Refusal: delete-in-progress`, `500` retry me, `405` other method |
| LIST objects | `GET /v1/s/<id>/objects`, optionally `?since=<cursor>` | that space's | as above | as above |
| GET object | `GET /v1/s/<id>/objects/<name>` | that space's | as above | as above |
| PUT object | `PUT /v1/s/<id>/objects/<name>` + envelope | that space's | as above | as above, plus `507` `space-full` and `503` `server-full` |
| GET ref | `GET /v1/s/<id>/ref` | that space's | as above | as above |
| CAS ref | `PUT /v1/s/<id>/ref` + precondition | that space's | as above | as above, plus `413` over this space's recorded `max_ref_bytes` |
| GET key | `GET /v1/s/<id>/key` | that space's | as above | as above |
| CAS key | `PUT /v1/s/<id>/key` + precondition | that space's | as above | as above, plus `413` over this space's recorded `max_ref_bytes` |

A minted token and a rotated token are each answered exactly once. The server
keeps only their SHA-256, so an operator who loses a token rotates rather than
re-reads one, and a stolen `meta.json` is not a stolen space. Rotation retires
the old token the moment the new hash is on disk — every device and every
outstanding invite carrying it is locked out at once — and changes nothing
about the key: the ciphertext in the namespace stays encrypted under the master
key it always was, and a member who already pulled a copy can still read it.

**Which credential opens what.** The two credentials open disjoint sets of
paths, but they are not equal in power. The **operator token** opens the
vault's own routes (`/v1/…`) and the three management routes; it is refused on
every `/v1/s/…` data route, so it cannot directly read, write or list a space's
objects, ref or key. A **space token** opens exactly one namespace — its own
`/v1/s/<its id>/…` — and nothing else; it is refused on the management routes
and on every other space's data routes. So a leaked space token is one space.

A leaked operator token is worse than that, and the honest statement of how
much worse is: **the operator token is a capability superset of every space
token, one request away.** The rotate route is an operator route, and it hands
the caller the new plaintext token; that token then opens the space's data
routes. So an operator — or whoever holds their token — can read any space's
*ciphertext* in two requests, and can delete any space outright. What stays out
of reach is a space's **plaintext**: that needs the master key, which lives
only in the members' `SSK1` envelope and never on the server. The one thing the
operator cannot do is take that path quietly — rotation retires the old token,
so every member's sync breaks at the moment the operator mints itself a
credential.

The credential is checked against the path's namespace after the request head
and before the body, exactly as above. **A `/v1/s/<id>/…` path whose space does
not exist is answered `401`, not `404`** — telling a stranger which space ids
are real is telling them what to aim at. A client therefore cannot distinguish
"the invite's space was deleted", "the id was mistyped" and "the token is
wrong", and must name all three rather than send a member to check the one
thing that may well be right. A path under `/v1/s/` whose id is malformed is
not recognised as a space route: it is checked against the operator token and
answered `404` when that token opens it, `401` when it does not.

**What a space is metered on.** Each space carries its ceilings and its
counters in its own `meta.json`, beside the token hash and a creation
timestamp. The ceilings are written at creation, so changing the server's
defaults later never moves an existing space's ceiling underneath its members:

| Field | Default at creation | What it bounds |
| --- | --- | --- |
| `max_bytes` | 1 GiB | Stored object bytes in this space |
| `max_objects` | 200,000 | Objects in this space |
| `max_object_bytes` | the §2 object cap | One object envelope |
| `max_ref_bytes` | 4 KiB | The ref document, and the key document |
| `bytes`, `objects` | 0 | What the space currently holds |

The file's first key is `"version": 1`; the rows above are the fields that
carry meaning, not the file's full key list.

Above them sits one total across all spaces — 16 GiB — so N spaces do not sum
past what the operator agreed to, and one ceiling on namespaces: 64. That total
is checked and charged under each space's *own* lock, not one shared one, so
two spaces uploading at the same instant can each pass the check and overshoot
by one object apiece. This is deliberate: the ceiling is an operator's disk
budget, not an accounting boundary, and a bounded overshoot is cheaper than
serialising every space's uploads behind a single lock. The vault's own
namespace is metered by none of it and has no `meta.json`: it is the operator's
own disk use.

A refusal is decided in a fixed order, so the check made against the declared
`Content-Length` before the body is admitted and the check made under the
space's lock with the write inside it can never disagree: **over
`max_object_bytes` → `413`; over this space's `max_bytes` or at its
`max_objects` → `507` `space-full`; over the server's total → `503`
`server-full`.** A space's own ceiling answers before the server total, because
it is the one its members can act on. Only an upload that actually stored bytes
charges the counters — a repeat `PUT` answered `200 already present` charges
nothing. The vault's own routes carry neither fullness refusal: the storage
budget belongs to spaces, and the vault is the operator's own.

The ref and the key are not metered as fullness. They are one small document
each, replaced in place rather than accumulated, so an oversized one is `413`
like an oversized object and a space at its byte ceiling can still publish its
ref; a space that could not write its ref would be a space whose sync had
failed rather than one that was full.

**The connection pool a space may hold.** Of the server's 64 concurrent
connections, one space may hold at most 8 and all spaces together at most 48.
The 16 slots no space can ever occupy are the vault's reserve: whoever holds a
space token is whoever a shared folder was handed to, and with a single pool
they could fill it — 64 slow uploads and the operator's own vault gets `503`
from their own server. A space's request is charged to its namespace from the
moment the namespace is known (after the credential is checked, before the body
is read) and given back when the whole request is answered. Over either share
the answer is `503` + `space-busy`.

Five refusals share the two "cannot right now" statuses, and they do not have
the same remedy. `X-Substrate-Refusal` is what tells them apart:

| Status | `X-Substrate-Refusal` | Means | Client's move |
| --- | --- | --- | --- |
| `503` | `server-busy` | The server is at its 64-connection cap. Written on the accept thread, which then closes without spawning anything. | Transient: back off and retry. |
| `503` | `space-busy` | This space is at its share of the connection pool. Answered after the token is checked, before the body is read. | Transient: back off and retry; the space's own other requests are what is holding it. |
| `503` | `server-full` | The operator's total budget across all spaces (16 GiB) is spent. This space may be nearly empty. | **Not transient in the client's hands.** Nobody in the space can free the bytes; only the operator can. Retrying will not clear it — surface it as the operator's problem, never as "delete some notes". |
| `507` | `space-full` | This space is over one of its own ceilings — its byte budget or its object count. Reads keep working and nothing about the sync is broken. | Not transient either, but it is the members' to fix: free room in this space. |
| `503` | `delete-in-progress` | The operator is deleting this space and the delete is still running. Answered on the delete route itself, to a second `DELETE` for a space already going away. | Transient, but it resolves by disappearing: the next answer for this id is `404`, not `204`. |

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

A store whose history was replaced by a purge or trim carries one more field
and is stamped version 2:

```json
{"version":2,"branch":"main","head":"…","superseded":["40-hex-git-oid","…"],"purge_epoch":3}
```

`superseded` lists, oldest first and at most 32, the heads a replacing push
published over — the purge boundaries. A device whose own history still reaches
one of them is holding the pre-purge copy even when its push is an ordinary
fast-forward (a purge that removes a recently added note collapses the head
onto a commit other devices already hold), so that push is refused into the
same pause-and-adopt door a replaced store shows, and the boundary is carried
forward by every later push. The stamp is version 2 only while the list is
non-empty, so a store that was never purged stays readable by clients that
predate the field, and one that was purged refuses them by version rather than
letting them republish what the purge removed. A version-1 document carrying
either field is refused as invalid.

The cap is what bounds the ref envelope, and `purge_epoch` is what keeps the cap
from costing a purge. It counts replacing pushes from the store's first and is
never reset or trimmed; each device records the epoch it last stood on beside
its tracking ref, and an ordinary push whose recorded epoch is behind the
store's — while the store carries any boundary at all — is refused into the same
pause and adopt door. So the list stays the precise check for a device stranded
inside the window, and the epoch catches the one whose boundary the cap has
already dropped. A device with no recorded epoch counts as behind, which costs a
vault upgraded across a replacement one answerable pause per device.

The refusal is not the push's alone: a device standing behind the store's epoch
is refused at PULL as well, into the same pause and the same adopt door. That
leg matters more than it looks, because a stranded device reads as already up to
date — the purge collapsed the store's head onto one of its own ancestors — so a
pull that took its no-op shortcut would record the store's current epoch on the
way out and leave the next push nothing to refuse. Only a leg that does not
refuse records the number, which is what keeps a device that is genuinely
current from ever pausing: it adopts or idles, records, and syncs on.

A device that has never taken a position from this store is exempt on the pull
leg, on the same reasoning that makes a first join not a replacement: it holds
nothing a purge could have removed, so there is nothing to refuse it over and
its pull lands normally. Its push is a separate question — a first join's
history is not one the store can fast-forward to, and it is refused whichever
check answers first.

Both fields are omitted while they are empty and zero, and the epoch is only
ever non-zero alongside a non-empty list.

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

### Space key wrap `SSK1`

Bytes are magic `SSK1` (4); HKDF salt (16); nonce (24); the 32-byte encrypted
master key plus its 16-byte tag. The envelope is exactly 92 bytes, and a reader
must require that length before it derives anything.

The wrapping key is HKDF-SHA-256 over the space's 32-byte invite secret, with
that envelope's 16-byte salt as the HKDF salt and info
`substrate/space/key-wrap/v1`. The associated data is
`substrate/space/master-key-wrap/v1:` followed by the space's id as its UTF-8 bytes (the ids this app mints are
   32 hex characters, but the wrap itself checks no shape).

**What the AAD binds to.** The id is in the AAD rather than in the derivation,
so an envelope opens only in the namespace it was minted for. An `SSK1`
document lifted from one space's `/key` route and served under another's fails
on the tag, structurally — not merely because two spaces never happen to share
a secret, which is a property of the generator rather than of the format.

**HKDF here, Argon2id for the vault (§1).** Argon2id exists to make a
*guessable* input expensive to guess. A passphrase is guessable and a space's
invite secret is not: it is 256 bits from the operating system pool, so there
is no dictionary in front of it and the 64 MiB Argon2id would cost buys
nothing — while being paid on a phone every time an invite is opened. The
random salt stays even though the input is already unique, because the
derivation is the same HKDF every other key in this protocol goes through and
salting it costs 16 bytes; two spaces that ever shared a secret would otherwise
share a wrapping key exactly. The magic differs from the vault's for the same
reason the AAD carries the id: a passphrase-wrapped key is not a space key, and
the two shapes must never be read as each other.

An implementation must reject, before deriving anything: any length other than
92 bytes — truncated *or* extended — and any leading 4 bytes other than `SSK1`.
It must then reject a failed tag, and a plaintext of any length other than 32.
An `SBK1` envelope presented as `SSK1` fails on the header, and an `SSK1`
envelope presented as `SBK1` fails likewise; neither is ever run through the
other's derivation. A failed unwrap says what it can honestly mean — an invite
for another space, or one issued before the space was re-keyed — and must not
mention a passphrase, which a member was never given.

The envelope is stored as the space's key document at `GET`/`PUT
/v1/s/<id>/key`, under the ref's document semantics: opaque bytes, versioned,
compare-and-swap. Creating a space refuses if a key document is already there
(including by losing the create-if-absent CAS), and also refuses if the
namespace holds a ref but no key, because minting a fresh key would succeed at
every step while making the history already uploaded unreadable. Opening an
invite refuses if there is no key document: minting one would make an empty
space nobody else can see rather than join the one the invite named.

## 4. Client algorithms

Push reads the remote ref and CAS version first. If its head is not already an
ancestor of local HEAD, push stops with “pull and merge first.” The client walks
all commits reachable from local HEAD plus their trees and blobs, HMACs their
OIDs, LISTs remote names (incrementally where the server supports §2.2, and
completely where it does not), and uploads missing encrypted objects. Last, it
CAS updates the encrypted ref. A CAS loss leaves only harmless immutable orphan
uploads and tells the client to pull and merge. The name cache is written only
after the ref is published, so a push that failed part way never leaves behind
a cache claiming its uploads landed.

A listed name is not evidence about the bytes behind it. The server holds no
vault key, so it cannot compare an upload with what it already stores, and an
object that was truncated, corrupted at rest, or planted by the operator keeps
its name occupied — an immutable store will not let a later upload replace it.
Push therefore verifies before it publishes: after the uploads and before the
ref CAS it re-downloads a bounded sample of the objects it skipped and puts
each through the pull path's authentication — keyed-name binding, AEAD tag,
embedded Git id, Git hash — plus a byte comparison against the local copy. One
that is not the object it claims to be aborts the push, with no ref moved on
either side, and names the only available repair: deleting that object on the
server. GET is what does this because it is what the wire contract offers: LIST
answers names only, there is no HEAD route, and no response carries a size a
client could compare.

The sample is capped at eight objects per push regardless of history size, and
its window starts at an offset derived from the head commit's id, so successive
pushes — which have different heads — walk different objects and a store is
covered over repeated pushes rather than in one expensive sweep. The head
commit's own object, when it is one of the skipped ones, is always included: it
is the entry point every pull resolves first. The limit is worth stating
plainly: one push detects damage in the objects it happens to draw, so a
damaged store is caught within a few pushes rather than guaranteed on the next
one.

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
comes from deployment (one token, one vault, one store), not from the
ciphertext — and equally between spaces, which are separate tokens over
separate stores rather than a cryptographic boundary. An operator could
cross-serve two namespaces that share a passphrase; binding the wrap AAD to a
vault identity is part of any multi-tenant design, not a v1 claim.

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
remains a denial-of-service vector, like omitting the object outright.

PUT's idempotence rule says an occupied name must never silently mask a client's
upload, and on a dumb blob store that rule cannot be carried by the server
alone: it holds no key, so "already present" is an answer about a name, not
about bytes. What makes the rule true in practice is the push-side sample in §4
— skipped objects are re-downloaded and authenticated before the ref moves, so
an occupied name that is not the client's object fails the push instead of
passing for a successful upload. This server additionally refuses a repeat
upload whose length differs from the stored bytes (§2), which catches truncation
at the moment of the upload; a deployment that does not do that is still covered
by the client check. The honest limit is the sample size: one push inspects the
objects it draws, so a damaged store is caught within a few pushes rather than
guaranteed on the first.

Authentication failure, wrong passphrase/key, swapped object name, modified
ciphertext, malformed length/type/OID, missing head object, stale CAS token,
wrong branch, dirty worktree, and non-fast-forward push all fail closed. No
client ever force-updates a ref after a CAS race. The transport is wired into
the app behind the `blob+` remote type and rides the repository's full test
gates. Changing the vault passphrase is now a client flow — the pane's
passphrase card re-wraps the master key in place, which leaves every enrolled
device syncing untouched and only changes what a future device must type. What
it still owes before being offered beyond an attended, operator-run deployment
is a recovery path for a forgotten passphrase (there is none by construction:
the master key exists nowhere but the wrap and the enrolled devices' credential
stores) and product copy for the freshness caveats above.

## 6. Executable evidence

The Rust tests cover passphrase wrap and wrong-passphrase rejection,
ciphertext/wrong-key tamper rejection, unconditional Git hash verification,
bounded object/ref/LIST reads, missing parent/tree/blob preflight, stale CAS
refusal, first-device upload, second-device reconstruction, divergent push
refusal, the existing local merge path, and the return trip to the first
device. They also prove that pull does not import an unrelated retained object.
Malformed head/parent/tree-entry types and post-purge pulls fail before checkout
or tracking-ref movement. Two shapes of an already-present object that is not
the client's — one truncated after storage, one authentic ciphertext of another
object relocated under the name — are shown failing the push before the ref
moves, and the same push succeeding once the object is restored. The server's
own tests pin the length-conflict answer at the store and on the wire.

Four tests pin the §4 and §5 rules that are easiest to regress silently: a purge
landing inside the write gate aborts the pull with no object imported, no
tracking ref, and no file on disk; a push from a rewritten history names the
purge instead of reporting ordinary divergence; a replayed older ref is shown to
mislead a brand-new device while an existing device neither rolls back nor
merges, and heals the ref on its next push; and a truncated or extended
passphrase envelope is rejected at every length rather than reaching Argon2.

Two more pin the passphrase change: a re-wrap under a new phrase yields the same
master key, retires the old phrase for a fresh enrollment, and changes nothing
when the current phrase is wrong; and a change that loses the compare-and-swap
to another device's re-wrap (staged through a transport double that lands the
winner inside the swap) is told the passphrase was changed elsewhere rather than
overwriting it — after which only the winner's phrase opens the vault. At the
app seam, a further real-socket test changes the phrase on an enrolled device,
shows its credential slot byte-identical and its push still landing, and then
refuses a second device the old phrase and admits it on the new one.

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

Seventeen tests pin §2.2 on the client side. Eleven drive a transport that speaks
the cursor negotiation in process: a second push asks incrementally and still
uploads what is new; an object the store loses is uploaded again, because the
retired cursor forces a complete listing; a cache written against one store is
never believed by another; a cache never holds a name the store did not itself
list, and learns this push's uploads only from the next push's answer; a store
that stops issuing cursors leaves no cache file behind; a complete listing
replaces the cache even when the cursor came back unchanged; an incremental
answer over the ceiling is refused like any other; a damaged, truncated, or
foreign cache costs one complete listing and is then rebuilt; and a store at
four fifths of the ceiling attaches a warning to a push that still lands —
counting that push's own uploads, so the push that carries the store over the
threshold is the one that says so — while one past it refuses with copy naming
the repair. One checks the cursor
alphabet directly, since a cursor that could carry a second request into the
query string must never reach the wire.

Five run over a socket. One answers a `since` query the way the deployed server
does — `404` — and asserts the client falls back to the complete listing,
caches no cursor, and makes exactly two requests; one answers `403`, `405` and
`501` in turn, for the proxy case, and asserts the same fallback rather than a
failed push; one answers `429`, `500` and `503` in turn, where the route was
understood and the store could not serve it, and asserts the fallback is NOT
run — the sync fails with that status and retries later rather than following a
broken or overloaded scan with a larger one; one claims `incremental` with no cursor to resume from and is read as
the complete listing it has to be; and one drives the whole negotiation through
the shipped server.

Twelve tests on the server side cover the listing contract: a cursor returns
only what was added after it, a cursor from another epoch or past the end falls
back to a complete listing, objects already on disk join the name list at
startup, an object that disappears mid-run leaves the listing and retires the
cursors, that same loss reaches a client that only ever asks incrementally
through the download it makes, a download of a name the store never held
retires nothing, a name list rolled back behind the store refuses the cursors
it issued, a restart retires every cursor and the next complete listing re-arms
them, a storage root restored whole refuses the cursors issued before the
backup, two opens over one root are never the same run, the route itself
carries the cursor and mode headers, and a listing whose reconcile fails is a
500 rather than a half-truth.

The warning's own stickiness is pinned twice: in the command layer, where a
successful pull must not take it back and only a push finding the store under
the threshold clears it, and in the sync pane, rendered for real, where a
warning must show without the pane reading as a failure and must survive the
pull that follows.

The server's own suite covers token length and constant-time comparison, object
name syntax as the traversal defence, immutable publish under a concurrent PUT,
ref CAS against a stale version, and key CAS refusing to clobber an existing
key while allowing an If-Match re-wrap. A further set drives real sockets: an
unauthenticated upload that declares four megabytes and sends none of them is
still answered `401`, an empty ref body is `400`, the connection past the
cap gets `503`, the key route stores and returns the wrapped key with the
ref's precondition rules, a space token is refused on every namespace but its
own, a space that cannot be opened is skipped instead of taking the server
down, a stalled flood against one space leaves the vault answering, and an
object body reaches its staging file a chunk at a time rather than being sized
into memory on the caller's say-so.

All vaults and blob stores are temporary test directories; no `~/Vault` path is
read or written.

## 7. The server

`hosted-sync-server/` is a standalone crate with **no dependencies at all** — a
hand-rolled HTTP/1.1 subset over `std::net`. That is a deliberate cost: this is
the only Substrate code that runs on a host the user does not sit at, so the
whole of it must be auditable in one sitting, and it must not inherit a
transitive supply chain to hold ciphertext in a directory.

It carries two kinds of namespace in one process. The **vault** is the
operator's own and is what §2 describes: one bearer token, the storage root
itself, one ref. Beside it are **spaces** — collaboration namespaces the
operator mints through `/v1/spaces`, each with its own token, its own store
under `spaces/<id>/`, and its own byte and object ceilings recorded in that
space's `meta.json`. A space's routes are the vault's routes under
`/v1/s/<space-id>/…`, and the two credentials do not overlap: a space token
opens its own namespace and no management route, the operator token opens the
management routes and no space's data. So a leaked space token is one space and
a leaked operator token is the whole server. §2.1's *Space routes* is the full
account — the routes, the credential rules, the ceilings and the refusal order;
this paragraph is the shape only, and the numbers live there, once.

What is still absent is accounts and rate limits. Quotas here are storage
ceilings — per space, and one total across all spaces — not per-caller budgets;
the connection cap and each namespace's bounded share of it are resource bounds
that stop one space starving the others, not rate limits; per-IP rate limiting
belongs in the proxy in front. A space is shared ciphertext between people who
already share its token, and it is not a second person's vault: do not put this
in front of more than one person's vault.

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

Storage also holds one small file the object protocol never exposes: the
acceptance-ordered name list behind §2.2's cursors. It contains only names the
LIST route already answers with. The epoch those cursors carry is held in
memory for the life of the process and never written down.

## 8. The object ceiling, and compaction

A hosted store only grows. Every version of every note that has ever been
snapshotted is an immutable object, history rewrites do not delete ciphertext
(§4), and there is no garbage collection. So the object count is a one-way
number, and 100,000 of them is where this client stops.

That number is a real horizon rather than a theoretical one — a vault gaining a
few hundred objects a day reaches it in years, not decades — so it is treated
as a product event rather than an assertion:

- Crossing four fifths of the ceiling raises a warning on the sync pane. The
  sync succeeded and the next one will too; the warning exists so the work of
  fixing it is scheduled rather than forced. It is deliberately not carried on
  the last sync result: only push can measure the store, auto-sync pulls every
  few minutes, and a warning in that slot is painted over long before anyone
  reads it. It has a slot of its own and stays up until a push finds the store
  back under the threshold.
- Past the ceiling, LIST and the pull-side graph walk refuse with copy that says
  nothing has been lost and names the repair, rather than describing itself as a
  prototype limit.

**Compaction is not built, and this section is the shape it would take rather
than a plan of record.** For an append-only encrypted store where the server
can neither read an object nor know which are reachable, compaction can only be
client-driven, and only three shapes are honest:

1. **Re-initialize from the current state.** The client pushes a fresh store
   containing only the objects reachable from today's head, publishes its ref
   and key there, and the old store is deleted by the operator. Cheapest to
   build, and the one the current refusal copy points at. It costs the vault's
   remote history: other devices must re-enroll against the new store, and any
   device that had not yet pulled loses whatever it had not integrated. It is
   therefore an attended, confirmed action, never automatic.
2. **Client-computed sweep.** The client computes the reachable name set from
   its own graph and asks the server to delete everything else. This needs a
   DELETE route the protocol does not have, and it hands the operator a
   client-blessed reachability set — a bulk deletion authorized by whichever
   device asked, including one whose history is behind. Any such route has to
   be gated on a ref version and paired with a retention window, or a stale
   device's sweep silently deletes another device's unpulled work.
3. **Repacking.** Many Git objects become one packed object, cutting the count
   rather than the content. It moves the ceiling by a large factor and keeps
   history, but changes the object envelope's meaning (§3 stores one loose
   object per name), so it is a v2 envelope and a new listing contract, not an
   increment.

None of the three is in scope here, and the difference between them is a
product decision about what a user is asked to give up. What is in scope is
that the wall is announced early, explained honestly, and never met as a
silent failure.
