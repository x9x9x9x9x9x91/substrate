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
