# Auto-sync verification lane

`bash scripts/autosync-verify.sh`

An **optional** lane, not a required gate, and much slower than one (~20 min).
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
transport, or sealed notes.

## Shape

Three processes and two vaults, all created and removed by the script:

- **the store** — `hosted-sync-server`, the shipped binary, on loopback with a
  `/tmp` storage root. A deployed instance is single-tenant (one token, one
  ref) and is **never** a test target.
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
  without that variable, and it refuses a vault outside `/tmp`.

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
sufficient: nine assertions then run from outside — against the store's object
files, both vaults' `.md` files, and the real credential store, which must hold
nothing keyed by this run. No plaintext marker in the store is the one that
matters most.

## Knobs

- `AUTOSYNC_KEEP=1` — keep both vaults and the logs (kept automatically on a
  driver failure, and on the outer run timeout: a run that ran out of time is
  the one whose disk state has to survive it).
- `AUTOSYNC_PORT` (8791), `AUTOSYNC_DEV_PORT` (1452) — asserted free before
  anything starts, so the lane can run alongside other worktrees.
- `AUTOSYNC_BOOT_TIMEOUT` (1200s), `AUTOSYNC_RUN_TIMEOUT` (5400s — above the
  driver's own per-leg bounds, which sum to roughly 4900s, so a slow run ends
  on the leg that stalled rather than on a generic outer bound).

Runtime is dominated by the shipped timings, not by the build: the legs sum to
roughly 15 minutes of deliberate waiting.
