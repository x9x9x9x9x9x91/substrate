# Architecture — where things live

A map, not a tour. It answers one question: *I want to change X — which file do
I open?* Read it once, then use it as an index.

Substrate is a Tauri desktop app. A Rust engine owns the vault on disk; a React
front end renders it; a narrow IPC boundary is the only thing between them.
Everything else follows from that split.

```
src/          React + TypeScript front end (what you see)
src-tauri/    Rust engine (the vault, search, history, the OS)
e2e/          Playwright specs, run against a mock backend in a browser
scripts/      Node tooling, drift checks and the gate runners
docs/         Specs and contracts (this file, vault-format.md, sheets-spec.md)
examples/     A demo vault the app can open as-is
```

## I want to change…

**…something you can see** — a pane, a menu, an editor gesture, a dashboard
renderer. That is `src/`. Components live in `src/components/` (`NotePane.tsx`,
`DatabasePane.tsx`, `DashboardPane.tsx`, …), app-wide wiring in `src/App.tsx`,
and the pure logic each one leans on in `src/lib/` — parsing, sorting, chart
shaping, date handling, the sheet formula language. **Anything expressible as a
pure function belongs in `src/lib/` with a node test beside it**, not in the
component; that is why the `src/lib/*.test.ts` suite is large and the component
tree is mostly rendering.

**…how the vault is read or written** — file scanning, frontmatter, the search
index, backlinks, trash, assets, folder sync, the file watcher, git-backed note
history. That is `src-tauri/src/`. The engine is `src-tauri/src/vault/`, with
the `Engine` façade in `mod.rs` and one module per concern (`schema`, `search`,
`views`, `trash`, `assets`, `mounts`, `foldersync`, `watch`, `doctor`, `seed`).
Note history lives in `src-tauri/src/history.rs`, calendar subscriptions in
`calendarfeed.rs`. Engine changes get a Rust test in the module they touch.

**…the on-disk format** — a new frontmatter key, a fence, a folder convention.
That is a **contract change**, and the contract is
[docs/vault-format.md](vault-format.md): it is written so an external tool or
agent can read and write a vault correctly from that document alone, with no app
code. Change the engine and that file in the same change, or the contract is a
description instead of a promise. The sheet formula language has its own spec in
[docs/sheets-spec.md](sheets-spec.md).

**…what crosses between them** — adding a command, changing its arguments. See
the next section; the boundary has three sides and a checker that fails on
drift.

**…a user-visible flow end to end** — that is an e2e spec in `e2e/`, run against
the mock backend rather than a built app.

## The IPC boundary

Front end and engine never share memory. They exchange named commands with JSON
arguments, and that name/argument set is written out by hand in **three** places:

1. **Rust** — `#[tauri::command]` functions in `src-tauri/src/commands/`, listed
   in `generate_handler![…]` in `src-tauri/src/lib.rs`.
2. **TypeScript** — the `invoke<T>("cmd", { … })` wrappers in `src/lib/ipc.ts`,
   which the rest of the front end calls instead of invoking directly.
3. **The mock backend** — a `case "cmd":` arm in `src/lib/mockBackend.ts`, which is
   what runs when the app is served in a plain browser.

Nothing keeps those three in step but attention, so `scripts/check-ipc.ts`
re-derives all three mechanically and fails `npm test` on any divergence —
including argument-name casing, which is how a silently-dropped argument once
shipped. A command that genuinely cannot exist on one side is declared in
`scripts/ipc-allowlist.txt` with a reason (`no-ts` for backend-internal
commands, `no-mock` for ones the browser can never reach). An entry that stops
being true is itself reported as drift, so the file cannot rot quietly.

Dashboard kinds are guarded the same way: `scripts/check-kinds.ts` compares the
set of `dashboard:` values across the built-in registry, the dispatch chain, the
icon table and the docs. `scripts/check-infotips.ts` guards what the info view
can say about them — every kind declares the controls on its pane that deserve
prose, and the check holds that declaration against the tip registry, against
the markup the pane still renders, and against the kind's privacy, so a pane
cannot ship explaining itself only as "a dashboard".

## Where a command runs, and what it waits for

A command's answer is not free of where it runs. Tauri hands a synchronous
`#[tauri::command]` to its IPC thread and waits for it there, so a slow one
does not queue behind the others — it holds up every command behind it, and
the window with them. Anything that reads the disk, walks the vault or runs a
query therefore declares itself `async` and puts its body through
`blocking()`, which moves the work onto a background thread and lets the IPC
thread go. Such a command takes an `AppHandle` rather than a `State<_>` and
resolves its state inside the closure: a mutex guard cannot be held across an
await point, so the state has to be fetched where the work happens. Every
read-hot command — search, full search, list, metas, backlinks, related,
resolve, image hit — is on that path.

The note-writing commands are not. `vault_create`, `vault_write_body`,
`vault_set_prop`, `vault_rename`, `vault_delete`, `vault_delete_many` and the
folder operations are all plain synchronous commands, so they run on the IPC
thread and hold it for the write. That is tolerable because each is one
user-sized edit rather than a scan, and it is why the published copy below
matters more than it would otherwise: the writes that DO take a long time —
the mount scan, the seal conversion, the folder sync — are background work
that no foreground read should have to wait for.

Leaving the IPC thread is only half of it. All vault state lives behind one
lock, because the engine owns a SQLite connection and an image memo that
cannot be shared between threads; it cannot become a read/write lock without
giving those up. So a mount scan, a seal conversion or a folder sync excludes
everything else that touches the vault for as long as it runs, which used to
mean a note open in the foreground waiting on a background scan.

What gets out of that queue is a published copy. The engine keeps a snapshot
of the note table, the link table, and two derived tables — links by target
name for backlinks, relation-prop values by named target for related — and
hands it out behind an `Arc`. Listing, metas, backlinks and related answer
from the snapshot and take no lock at all, ever.

The writer does the publishing, and it does it at the END of the write. A
write moves the index revision as it begins, but the published copy stays up
and readers keep answering from it; the writer builds a new copy and installs
it under the engine lock, in the moment before it releases the lock. Every
path that touches the vault reaches the engine through a guard that publishes
when it is dropped, so no writer has to remember to do it, and a writer that
panics mid-way still hands over what it managed to write.

So a read that lands during a write sees the vault as it stood when that
write began — a note opened during a 5,000-file mount scan answers
immediately, from the pre-scan copy, instead of waiting for the scan. A read
that starts after a write finished sees that write, because the write
republished before it unlocked. A caller that writes and then reads through
the same held lock sees its own write, because the engine's own read path
rebuilds on a stale revision rather than waiting for the publication.

The copy costs one clone of the note and link tables and one sort, on the
writing thread, per write. That is the accepted floor: the tables have to be
read consistently, so there is nowhere but under the lock to read them from.
What made it expensive before was paying it once per reader that missed,
rather than once per write.

Search is the exception, and the reason is where its answer lives: the
full-text tables are inside the engine's in-memory SQLite connection, not in
the note table. An in-memory database is private to its one connection, that
handle cannot be used from two threads at once, and scoped search rewrites a
temp table inside that same connection on every query — so there is nothing a
snapshot could carry and no second connection that could read the tables. The
writers' transactions are short (per indexing batch, per FTS rebuild), which
does not change the answer: however briefly a writer holds the engine, search
needs the one connection the writer is using. Search runs off the IPC thread
like everything else, but it still queues behind a writer. Fixing that means
moving the full-text tables to a file-backed database with reader
connections, which is a change to the index's lifecycle rather than to this
lock.

The snapshot also changes what `related` costs. Resolving every note's type
against the schema and lowercasing its relation values happens once per index
change, not once per note open.

## The mock lane

`npm run dev` serves the front end against a deterministic mock backend in an
ordinary browser — no Rust build, no Tauri, no real vault. The mock lives in
`src/lib/mockBackend.ts` (imported eagerly by the `src/lib/tauri.ts` transport
shell) and seeds a fixed demo vault, so every run starts from the
same state. The Playwright suite (`npm run e2e`) drives that same lane, which is
why the e2e gate is fast enough to be a merge gate.

**What it can exercise:** essentially all of the UI — notes, databases, views,
dashboards, search, the palette, sidebar, calendar, undo, drag and drop.

**What it cannot:** anything that needs the real OS. The terminal HUD, native
export and print, and the real-app smoke hooks have no mock arm and are listed
as `no-mock` in `scripts/ipc-allowlist.txt`. Vault-on-disk behaviour — scanning,
watching, git history, conflict handling — is likewise not what the mock proves;
that is what the Rust tests are for. If a change's risk lives in the engine, an
e2e spec is not coverage of it.

## Gates

The same checks that gate a merge — the union gate, in
`scripts/verify-gates.sh`'s canonical order (details and versions in
[CONTRIBUTING.md](../CONTRIBUTING.md)):

```sh
npx tsc --noEmit             # tsc:      typecheck
npm test                     # test:     node suite: src/lib/*.test.ts and scripts/
cd src-tauri && cargo test --lib   # cargo:    Rust engine tests
                             # ios:      cargo check --target aarch64-apple-ios --lib
npm run e2e                  # e2e:      Playwright over the mock backend
npm run lint                 # lint:     errors-only
                             # macsmoke: cargo check --all-targets on a Darwin host
```

`ios` and `macsmoke` have no one-line npm equivalent — `ios` cross-compile-checks
the engine for `aarch64-apple-ios` and `macsmoke` compiles the mac tree with
`--all-targets`, both of which need a Mac. `bash scripts/verify-gates.sh` runs
them all; a leg its host cannot run FAILS with the reason rather than skipping
(a leg that skips itself reads as green), and `--only tsc,lint` narrows the run
while iterating.


`npm test` is where the drift checks above run, so an IPC or kind mismatch fails
there rather than at runtime.

## If you are an agent

Read in this order — it is the shortest path from cold to a correct change:

1. **This file**, for which of the four surfaces your change lives on.
2. **[docs/vault-format.md](vault-format.md)**, if you touch the vault at all.
   It is the contract, and it is complete: layout, frontmatter, every fence, the
   dashboard and sheet keys. Do not infer format rules from engine code when
   that file states them — and if the two disagree, the code wins and the doc is
   the bug.
3. **[CONTRIBUTING.md](../CONTRIBUTING.md)**, for the gates and the house style.

Then, concretely:

- **Tests live next to what they test.** A pure function gets `foo.test.ts`
  beside `foo.ts` in `src/lib/`; an engine change gets a `#[test]` in the Rust
  module it changed; a user-visible flow gets a spec in `e2e/`. Pick the level
  the behaviour actually lives at — an e2e spec asserting a parser's output is
  slow and proves less than a node test.
- **Match the surrounding code.** The tree is uniform enough that the
  neighbouring file is the style guide.
- **Verify with the narrowest gate that covers your change**, then the full set
  before you call it done.
- **The mock lane is a browser, not the app.** Green e2e says the UI wiring
  works; it says nothing about the engine, the filesystem, or anything on the
  `no-mock` list.
- **Changing the vault format means changing two files**, code and contract, in
  one change.
