# Auto-sync verification lane

`bash scripts/autosync-verify.sh`

Slower than a gate (~20 min, or ~35 building the bundled binary) and not part
of `branch-gates.sh` — but **required before a release that touches sync**.
It exists because auto-sync was verified in halves that never met: the
scheduler has unit tests over a fake clock and an e2e spec over the mock
backend (no Tauri, no engine, no vault), and the hosted transport has
round-trip tests with no app at all. Both were green while nobody had watched
a real app push itself to a real store and a second device read it back.

This lane joins them. One real app, one real hosted store, one real second
device, on the **shipped timings** — two minutes of settle, five of pull
interval. It deliberately does not use the `window.__mockAutoSync` seam: the
timings are half of what "full auto" means, and a run that shortens them
proves the other half only.

Run it before a release that touches the sync lane, the scheduler, the hosted
transport, or sealed notes — `AUTOSYNC_BUNDLE=1` for the pre-release run, so
the thing under test is a binary with the frontend compiled into it rather than
the dev server.

**What bundle mode is and is not.** It is `tauri build --debug --no-bundle`:
the real frontend inside the real binary, real CSP, no dev server anywhere. It
is *not* the artifact a user downloads — debug profile, unbundled, unsigned,
and the driver's remote, token and passphrase are compiled in, because that is
how the harness reaches the app at all. What it removes from doubt is the dev
server, which was never part of a release; signing, notarization and the
release profile are the notarized build's own lane.

## Attended and unattended

The app stores its sync credentials in whichever keychain is the user's
default, and an ssh session gets a locked one ("User interaction is not
allowed"). That is what kept this run a desktop ritual: it could catch a sync
regression only if somebody sat down and asked it. Preflight says so up front
rather than after twenty minutes of building.

**Attended** is the default and is unchanged — run it in a desktop session on
the machine itself, the same constraint that keeps release signing attended:

```sh
bash scripts/autosync-verify.sh
```

**Unattended** needs one thing set up per rig, once:

```sh
bash scripts/rig-provision-sync-keychain.sh
```

That creates `~/Library/Keychains/substrate-autosync.keychain-db` and a 40-character
password for it in `~/.config/substrate/autosync-keychain-password`, mode 600, on
that machine and outside every checkout. Nothing real goes into either: the
credentials the run stores are the throwaway token and passphrase the harness
invents against its own loopback store, and it deletes them again on the way
out. Provisioning deliberately does **not** change the user's default keychain
— a rig somebody is logged in at keeps the keychain it had, every minute a run
is not going.

Then, from anywhere, including over ssh:

```sh
AUTOSYNC_KEYCHAIN="$HOME/Library/Keychains/substrate-autosync.keychain-db" \
  bash scripts/autosync-verify.sh
```

One rig requirement has no script-side fix: the console session must be
**unlocked**. The scheduler under test lives in the app's webview, and macOS
suspends an occluded app's webview wholesale — behind a lock screen the app
boots, pulls once, and then never fires another trigger, which reads as a
settle-push timeout a quarter of an hour later. Display *sleep* is handled
(the launch holds a caffeinate assertion for the app's lifetime); the lock
screen is not, so preflight refuses it up front, and a rig meant to run this
unattended should have its screen lock disabled.

What the run does with it: reads the password from the file (never into a
variable, never onto a command line, never echoed), unlocks the keychain,
clears its five-minute auto-lock — the run is twenty — puts it on the search
list and makes it the default, and restores the previous default and search
list from the same cleanup path that stops the processes, on every exit
including a failed one. The app is not changed and knows nothing about any of
this: it writes to the default keychain either way. `AUTOSYNC_KEYCHAIN_PASSWORD_FILE`
moves the password file; both the script and the provisioner refuse to be
pointed at the login keychain at all.

The credential-hygiene assertion at the end grows a second half in this mode.
"The real credential store holds nothing keyed by this run's vaults" is asked
of the keychain that was the default before the run, by name — unqualified it
would find the run's own credentials in the test keychain and answer itself
wrongly. That keychain is locked over ssh, so a locked read there is
indistinguishable from an empty one; the half that carries the claim
unattended is the positive one next to it, that the credentials went to the
dedicated test keychain. Together they say the redirect happened and landed
where it was aimed.

**Not a gate leg.** `verify-gates.sh` legs fail rather than skip, on the rule
that a leg which skips itself reads as green — and a ~20-minute run whose
prerequisite is a per-rig provisioning step would fail on every rig that has
not had it. Unattended mode is what makes wiring it up *possible*; whether the
fleet gets provisioned and which battery pays twenty minutes for it is a
separate decision.

To undo the provisioning completely:

```sh
security delete-keychain ~/Library/Keychains/substrate-autosync.keychain-db
rm ~/.config/substrate/autosync-keychain-password
```

## Shape

Three processes and two vaults, all created and removed by the script:

- **the store** — `hosted-sync-server`, the shipped binary, on loopback with a
  `/tmp` storage root. A deployed instance is single-tenant (one token, one
  ref) and is **never** a test target.
- **the wire tee** — a TCP proxy (`scripts/autosync-verify.ts proxy`) on the
  port the app and the second device dial, forwarding to the store on the next
  port up and appending every byte of both directions to a capture file per
  connection. It decrypts nothing and terminates no TLS; loopback hosted sync
  is plain HTTP by design, and that is exactly what makes the bytes readable
  enough for the absence of plaintext to mean something.
- **the app** — the real thing under `VAULT_DIR=/tmp/vault-smoke-autosync-a-$$`,
  arming its own sync lane and then left alone. It runs with `XDG_CONFIG_HOME`
  pointed inside the run's scratch directory, because `VAULT_DIR` does not move
  the app's config dir: without that, each run would leave a sync token and a
  wrapped hosted master key keyed by a deleted `/tmp` root in the same
  credential store the real vault uses, and would write its sync health and
  privacy files over the real vault's. **macOS caveat:** the config dir there
  is not XDG-based and the credentials live in the login keychain, so the
  redirect does not reach them — the script deletes its own keychain entries on
  exit instead, and the outside assertions prove the real store holds nothing
  keyed by either of the run's vaults. The health and privacy files are still
  shared on macOS, which is one more reason this lane belongs on a test box.
- **the second device** — `gitsync::autosync_peer::peer_action` in
  `src-tauri/src/gitsync.rs`, an `#[ignore]`d test driven by
  `SUBSTRATE_PEER_ACTION`: the same client engine the app calls, headless, so
  a remote change can be made and read back without a second window. Inert
  without that variable, and it refuses a vault outside `/tmp` — resolved
  first, so a symlink cannot present a `/tmp` spelling for somewhere else.

The in-app driver is `src/lib/autosyncverify.ts`, imported by `src/main.tsx`
only when `import.meta.env.VITE_SUBSTRATE_AUTOSYNC_VERIFY === "1"` — the same
tree-shaken shape as the smoke driver, so it never reaches a shipped bundle.
It reuses the smoke lane's two hooks (`smoke_signal`, `smoke_exit`), which
stay inert without `SUBSTRATE_SMOKE=1`.

Where the driver needs work done behind the app's back it writes a gate name
into the signal dir and waits; the script does the work as the second device
and answers by dropping `Harness/gate-<name>.md` into the app's vault. That is
the whole channel — the app is never told anything except through its own
vault and its own remote.

## What it proves

1. **boot engages** — a fresh boot with a saved remote arms the lane unaided
   and adopts a note the other device pushed before launch. Nothing is
   clicked.
2. **settle-push** — one edit, then hands off: within the settle window the
   push fires by itself, and the second device pulls the marker back off the
   remote.
3. **focus pull** — the other device pushes; a window focus adopts it. (The
   one synthetic step in the run: a headless window is already frontmost, so
   the driver dispatches the `focus` event the real window would.)
4. **interval pull** — the other device pushes again and nothing triggers
   anything. The background interval carries it in on its own.
5. **divergence** — both devices edit the same note. The pull must park a
   conflict and the pane must go red, the local edit must still be there
   afterwards, and resolving it from the pane must clear the parked merge —
   which it has to, because a parked conflict pauses the whole lane and would
   starve the leg after it.
6. **sealed privacy** — sealing a scope encrypts the note and purges its
   plaintext from local history. The plaintext marker must be findable
   nowhere: not in the store, not on the second device, not in the local file,
   and not in this device's own git history. Runs **last** on purpose: the
   purge is a history rewrite, after which the hosted transport refuses both
   legs until the store is re-initialized, so no later leg could sync. The
   assertion is that the lane **says so** — a refusal a user must act on has
   to reach `last_error` instead of hiding in the quiet window.

Divergence is asserted on the parked conflict, not on a refused push, because
the auto lane suppresses ordinary transport failures by design
(`record_outcome_into` in `src-tauri/src/commands/vaultsync.rs`) — that
suppression is the shipped behaviour, and surfacing through the pull is the
path a user actually sees.

As with the smoke lane, the driver's `result.json` is necessary but not
sufficient: assertions then run from outside — against the store's object
files, both vaults' `.md` files, and the real credential store, which must hold
nothing keyed by this run.

## Ciphertext on the wire

The store holding no plaintext is the store's word for it. The tee is not:
it sits between the app and the store, so its capture predates any behaviour
of the server. After the driver finishes, the tee is stopped and
`scripts/autosync-verify.ts assert` reads the capture back and fails the run
unless all of this holds:

- **no forbidden phrase appears anywhere** in any captured byte, request or
  response. The list is built from the seed vault once it is on disk, not
  hand-maintained beside it: every line of prose it holds, every note name and
  every folder name, all from 24 characters up, plus the three sync markers, the
  second device's note markers, the three canary phrases, the canary folder,
  file name and frontmatter tag, and the sync passphrase — around eleven
  hundred phrases, handed to the assertion in a file. Searched as raw bytes
  across headers and bodies alike, so a leak through a URL or a header counts.
  The short lines and the short names are left out on purpose: something
  short enough to be a coincidence in ciphertext is short enough to be a false
  red, and a vault holds folders called `Home` and `Sync`. The metadata shapes
  a leak actually takes are covered whatever their length by the canary folder,
  file name and tag, which are forbidden with no length floor at all.
- **every uploaded body opens with its route's envelope magic** — `SBO1` for
  an object, `SBR1` for a ref, `SBK1` for a wrapped key. A body on a route
  with no envelope rule is a failure too: the audit refuses to vouch for
  traffic it does not have a rule for.
- **nothing was encoded** — a gzipped body would still be sealed, but the scan
  reads raw bytes, so a compressed one would hide whatever it carried and read
  as clean. A request declaring `Content-Encoding` is a framing the reader
  refuses; a response carrying the header fails the run.
- **the framing was readable end to end** — the reader parses by
  `Content-Length` and throws on a framing it cannot follow rather than
  quietly scanning less than it claims to.

The **sync token is deliberately not forbidden**: it is the credential the
transport authenticates with, so it rides in an `Authorization` header on every
request by design, and the capture holds it in the clear. It is the harness
token this script invented for a loopback store it started and stopped, valid
nowhere else — but that is why the evidence bundle is a local artifact and not
something to paste into an issue verbatim.

Absence alone would be vacuous — a run that synced nothing would also leak
nothing. So every canary is asserted **present** on the far side afterwards:
the three phrases in the second device's vault, and the canary folder and file
name as a real path there. The rest of the list gets the same treatment in
aggregate — the second device must hold at least as many notes as were seeded,
so a phrase that is absent from the capture is absent because it was sealed and
not because it never left. Crossed the wire, unreadable on it.

The seed vault is `examples/vault` plus three synthetic session notes. It is a
realistic lookalike on purpose and never a copy of a working vault: nothing
real is in the test, even in encrypted form. Its scratch roots are cleared and
recreated rather than reused, and refused unless they resolve under `/tmp`, so
a symlink planted at one of the run's predictable paths cannot redirect the
seeding into somewhere real.

## The evidence bundle

Every run — green or red — writes a dated directory under
`.autosync-evidence/` (git-ignored) and prints its path last, so a release can
point at one. It is written from the script's exit handler, not at the end of a
green run: a red run is the one whose capture is worth reading, so it leaves
the same bundle with `"verdict": "fail"` in the manifest and a `wire` field of
`null` if it died before the assertion ran.

- `run.json` — the manifest: mode (dev or bundle), the app binary that was
  actually run, commit, host, ports, store object count, the wire totals, and
  the verdict.
- `wire/` — the raw capture, one `.req`/`.res` pair per connection, plus
  `wire-report.json` (connections, bytes, request count, bodies by magic,
  forbidden phrases searched, leaks).
- `forbidden-phrases.txt` — exactly what the run forbade, so a green verdict
  can be read rather than taken on trust.
- `driver-legs.json` — the in-app driver's per-leg result.
- `assertions.txt` — the transcript of every outside assertion.
- `server.log`, `peer.log`, `app.log.tail`, `wire.log.tail`.

## Knobs

- `AUTOSYNC_KEEP=1` — keep both vaults and the logs (kept automatically on a
  driver failure, and on the outer run timeout: a run that ran out of time is
  the one whose disk state has to survive it).
- `AUTOSYNC_BUNDLE=1` — compile the frontend into the binary (vite build with
  the verify driver, then `tauri build --debug --no-bundle`) and drive that
  instead of the dev server; see "what bundle mode is and is not" above. Adds
  the build to the runtime. The final line names the binary it ran, and the run
  refuses a binary older than its own build rather than driving a stale one.
- `AUTOSYNC_PORT` (8791, where the tee listens), `AUTOSYNC_SERVER_PORT` (the
  next port up, where the store listens), `AUTOSYNC_DEV_PORT` (1452) — asserted
  free before anything starts, so the lane can run alongside other worktrees.
- `AUTOSYNC_EVIDENCE_DIR` — write the evidence bundle somewhere else.
- `AUTOSYNC_BOOT_TIMEOUT` (1200s), `AUTOSYNC_RUN_TIMEOUT` (5400s — above the
  driver's own per-leg bounds, which sum to roughly 4900s, so a slow run ends
  on the leg that stalled rather than on a generic outer bound).

Runtime is dominated by the shipped timings, not by the build: the legs sum to
roughly 15 minutes of deliberate waiting.
