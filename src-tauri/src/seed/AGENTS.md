# AGENTS.md — this vault

You are working inside a **Substrate** vault. Everything here is plain markdown
on disk: no database, no export step, no lock-in. Read this before writing.

## The one idea

A note is a `.md` file. It becomes a **database row** by gaining a `type:` key in
its YAML frontmatter — nothing else. Folders do not decide membership, and
nothing ever moves when a note joins or leaves a database.

```markdown
---
type: trip
status: booked
days: 10
created: 2026-08-03
---
Body text, then links and embeds (see below).
```

Every distinct `type:` string is a database (exact, case-sensitive). Drop the
key and the note is just a note again.

## Frontmatter rules that bite

- The block must start at byte 0 (`---`), close with a `---` line, and parse as
  a YAML **mapping**. Anything else at the top level — a scalar, a list, invalid
  YAML — reads as zero props and the note silently leaves its database. Values
  may be nested: lists and maps are fine (dashboard config like `cards:` and
  `pages:` depends on them).
- **Broken or duplicate-key frontmatter locks the note out of the app's own
  property edits.** If you hand-write frontmatter, keep it boring.
- Property edits and renames re-serialize the **whole** frontmatter block: keys
  come out **alphabetically sorted** and quoting normalized — never depend on
  key order, and don't put comments there. Body edits leave the block
  byte-verbatim.
- Lists are YAML string lists (`- item` under the key). Checkboxes store `true`;
  unchecked means the key is **removed**, never `false`.
- `created`, `title`, `type`, `calendar`, `repeat*` are app-meaningful. So is
  `tags`: an ordinary string list in YAML, but the app unions it with inline
  `#tags` from the body, and tag folders group notes by it.
- Wikilinks work in the **body only** — `[[Note title]]`, with an optional
  `#heading` anchor and `|alias` display text (`[[Note#Plan|the plan]]`). The
  target resolves **case-insensitively** against a note's title or filename
  stem. Frontmatter never produces links. `![[cover.png]]` is an asset embed
  instead, resolved against `.assets/`.
- Literal code is not link syntax: a `[[link]]` inside a fenced block or an
  inline code span is an example, not a link — it is never indexed and a
  rename never rewrites it. That is how this file names the syntax safely.

## Property kinds

When a type is registered in the schema, each property may declare a `kind`:
`text` (default), `date`, `number`, `checkbox`, `multi`, `relation`, `rollup`,
`url`, `email`, `phone`, `file`. A text property with `options` renders as a
select. Dates are `YYYY-MM-DD`, optionally ` HH:MM`. Relations store the target
note's **title**, not a path; a `rollup` is a derived, read-only column over a
relation's targets.

## Dashboards, sheets and views

A **dashboard** is a note with `type: dashboard`. A `dashboard:` prop names the
renderer, and the public built-ins are: `metrics`, `yield-apr`, `hub`, `food`,
`feed`, `music-work`, `tasks`, `charts`. `dashboard: charts` always selects the
chart-fence renderer. With no `dashboard:` prop, the app scans the body: one or
more ` ```chart ` fences select charts, and none falls back to the yield
tracker. A present but unknown value shows an “unknown kind” card instead of
silently rendering the wrong dashboard.

A **sheet** is `type: sheet` with a ` ```csv ` fence (first row = headers) and an
optional ` ```formulas ` fence of `name = expression` lines.

The primitive you will reach for most is the **view fence** — a live, editable
cut of a database, embedded anywhere in a note body. Its non-title cells edit
in place, and its “+ New” row creates a note in that database. It is a code
fence whose info string is `view`, holding one `key: value` per line (`#`
comments allowed).
Sketched below with the three backticks left off, because a real fence in this
file would be scanned as a real embed — open with backticks + `view`, close with
backticks:

    (open fence, info string: view)
    type: trip
    query: status:planned
    view: table
    (close fence)

- `type` — a database type, spelled exactly as in the notes' `type:` key.
- `query` — optional; the filter-bar operator language (`status:booked`,
  comma-OR, `due < 7d`, bare words match titles).
- `view` — accepted, but only `table` renders today.
- `saved` — alternative one-key form naming a pinned view by id or name; when
  present it wins over `type`/`query`.

An unknown key or a malformed value shows a quiet inline error card instead of
breaking the note — a typo says so rather than being silently ignored. Every
fence in a body renders its own table.

For the rest of the format — sheets and the formula language, the yield
dashboard's csv snapshots, the metrics dashboard's `cards:` bindings, chart
fences, and workbook `pages:` — see §5 of `docs/vault-format.md` in the
Substrate repo (linked below), which is the authority.

**When none of the built-ins fits, you can write the renderer yourself** — into
this vault, not into the app. A folder under `.vault/kinds/<id>/` holding a
`kind.json` manifest and a plain ES module that default-exports an object with
a `mount(el, ctx)` becomes a dashboard kind: a note naming it (`dashboard: <id>`)
mounts your code in the pane, with `ctx` giving you the vault's notes, sheets,
guarded writes and the app's own class names. No build step and no app change.
It runs with the app's own access, so it does nothing until the human enables
that exact bundle on that device, and any edit to the bytes stops it and asks
again — write the bundle, then tell them to enable it; you cannot self-approve.
Bundles live in the vault, so version history covers them like notes. Reach for
this last: a chart over a sheet is a chart fence, a row of numbers is the
metrics kind, and configuration survives upgrades untouched. The full contract
(manifest grammar, every `ctx` member, the consent/hash rules) is §5.8 of
`docs/vault-format.md`, with a complete copy-pasteable example under "Writing
your own kind" in `docs/dashboards.md`.

## Where the full docs and examples live

This vault is self-contained, but the app's repo carries the deeper reference
material. If you can fetch URLs, these are the breadcrumbs:

- Repo: <https://github.com/x9x9x9x9x9x91/substrate>
- Vault format spec (the authority): `docs/vault-format.md`
- Dashboards guide — every kind, with frontmatter examples: `docs/dashboards.md`
- Cookbook — working per-kind dashboard recipes with screenshots: `cookbook/`

The cookbook is built to be read by an agent, not just a human: `cookbook/index.json`
is machine-readable, and every recipe declares the `files` it consists of, what
data it `expects` (which sheets, which database types) and how to `adapt` the
sample data to real data. So "copy the portfolio recipe and set it up against my
holdings" is a single prompt you can execute — read the entry, copy its files
into this vault, then rewrite the sample rows and bindings per its `adapt` line.

The app also bundles a **demo vault** (the "Try the demo vault" door on the
vault picker) with working examples of most portable dashboard kinds — worth
opening once to see what finished surfaces look like before building one here.

## The app itself

Substrate is a Tauri v2 app: Rust backend in `src-tauri/`, React/TypeScript
frontend in `src/`. The commands the frontend calls — and the ones an in-app
agent should prefer over raw file writes — are listed in §14 of
`docs/vault-format.md` (repo link above).

The app also keeps state **outside** the vault, in the OS app dirs for
`com.example.substrate` (macOS: `~/Library/Application Support/` and
`~/Library/Preferences/`); `vault-sync.json` lives in the config dir. That is
the app's own state, not vault content: it is not versioned, not in `.trash/`,
not synced, and hand-editing it can break sync. Change those things through the
app, or in the repo — never by poking JSON in Application Support.

## Layout

```
Welcome.md          orientation note
Settings.md         app settings (capture hotkey, terminal…)
AGENTS.md           this file
Inbox/              capture lands here (⌘N); filing is optional
Dashboards/         convention only — dashboards can live anywhere
<any folders>/      just paths; organize however you like
.vault/             machine-managed JSON — read for orientation, see below
.claude/skills/     your skills (this is where you add more)
.assets/            embedded binaries — OFF LIMITS
.trash/             recoverable deletions — OFF LIMITS
```

Any path component starting with `.` is invisible to the app's note index: it is
never listed, searched, or watched. That is why `.vault/` and `.claude/` don't
show up as notes.

Root `Settings.md`, `AGENTS.md`, and `CLAUDE.md` are indexed and ordinary on
disk, but **concealed from the app's note lists and search by default** so the
vault reads as the user's, not the tooling's. The user reveals all three with
`show-agent-files: true` in `Settings.md` (the “Show app files” switch in the
⌘, settings sheet); “edit raw” opens `Settings.md` while they remain concealed.
Don't be surprised when the user says they can't see them, and don't "fix" it
by duplicating their content into visible notes.

## `.vault/` — read it, don't hand-edit it

Machine-managed JSON, and the fastest way to orient yourself in an unfamiliar
vault:

- `schema.json` — every database and its property definitions. **Read this
  first**: it tells you the real types and property names in use.
- `views.json` — layout preferences, sidebar order, saved views.
- `mounts.json` — folders on disk mounted in as databases (the live registry;
  a `folders.json` beside it is the legacy form the app migrates from).
- `format.json` — format versions. **Never bump it**; a version above the app's
  makes that file read-only in Substrate.

Prefer changing schema through the app. If you must write these files, write
atomically (temp file in the same directory, then rename) — the app watches them
live and a torn read looks like an empty file.

## Off limits

- `.assets/` — binaries, referenced by embeds. Do not edit or delete them by
  hand. Deleting one through the app moves it to `.trash/`, recoverable until
  the trash is emptied; assets have no version history.
- `.trash/` — deleted notes, restorable. Treat as read-only.
- `.git/` — the app owns version history here.

## Sealed scopes — unreadable is not broken

A `.substrate-seal` file in a folder means that folder's subtree is sealed: the
notes under it are encrypted on disk. At the vault root it means every note in
the vault. The marker inherits down the path, so a sealed ancestor seals everything
below it — but siblings are independent: `Private/.substrate-seal` says nothing
about `Public/`.

A sealed note keeps its filename and `.md` suffix; the bytes inside start with
the line `SUBSTRATE-SEALED-1` followed by an age-encrypted binary payload. That
is not corruption.

- **Never edit, "repair", reformat or delete a file you cannot read as
  plaintext.** No frontmatter normalizer, formatter, link rewriter or merge
  driver over those bytes. Copying, renaming and syncing them byte-for-byte is
  fine; content-aware diffs are intentionally unavailable while sealed.
- Work in unsealed scopes. Reading note content inside a sealed one needs a
  key the app and user authorize — do not try to route around it, and do not
  touch `.vault/sealed-key.age`, which is the user's only password recovery
  path.
- This file, `Settings.md` and `CLAUDE.md` stay plaintext even under a root
  seal, on purpose: you need to orient before any key is authorized. Their
  being readable is not evidence that the rest is.
- **Before creating or replacing a note, check for `.substrate-seal` at the
  vault root and on every folder of the target path.** If one is there, the new
  file must be ciphertext too: encrypt it to the public `recipient` named in
  the marker (never invent a second recipient in the same vault), or leave the
  creation to the app. Never drop plaintext into a sealed scope.

## Writing notes safely

- Filename ≈ title. Titles may not contain `[` or `]` or start with `.`;
  `/ \ : * ? " < > |` are replaced with spaces.
- **Renaming a file by hand does not rewrite wikilinks or relation
  values** — the app's rename does. Prefer renaming in the app.
- Writes are last-writer-wins with no locking. Your file change is picked up
  within about a second. If the user may have the note open, be quick and
  surgical rather than rewriting whole files.
- Two notes with the same title make wikilink resolution ambiguous. Keep titles
  unique.

## Skills

Your skills live in `.claude/skills/<name>/SKILL.md` — user-owned, versioned
with the vault, and synced to their other devices. Each is a markdown file with
frontmatter:

```markdown
---
name: my-skill
description: One line saying when to use this — it is how the skill gets found.
---

# What to do, step by step.
```

Run `/setup` to interview the user and generate skills fitted to *this* vault's
actual types and folders. Add more the same way, or by hand — a new folder with
a `SKILL.md` in it is all it takes.
