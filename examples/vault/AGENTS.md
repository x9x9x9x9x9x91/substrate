# AGENTS.md — this vault

You are working inside a **Substrate** vault. Everything here is plain markdown
on disk: no database, no export step, no lock-in. Read this before writing.

## The one idea

A note is a `.md` file. It becomes a **database row** by gaining a `type:` key in
its YAML frontmatter — nothing else. Folders do not decide membership, and
nothing ever moves when a note joins or leaves a database.

```markdown
---
type: release
status: in review
artist: various
created: 2026-07-17
---
Body text, then links and embeds (see below).
```

Every distinct `type:` string is a database (exact, case-sensitive). Drop the
key and the note is just a note again.

## Frontmatter rules that bite

- The block must start at byte 0 (`---`), close with a `---` line, and parse as
  a **flat** YAML mapping. Nested mappings make the note read as zero props —
  it silently leaves its database.
- **Broken or duplicate-key frontmatter locks the note out of the app's own
  property edits.** If you hand-write frontmatter, keep it boring.
- The app re-serializes frontmatter on edits: keys come out **alphabetically
  sorted** and quoting normalized. Never depend on key order, and don't put
  comments there.
- Lists are YAML string lists (`- item` under the key). Checkboxes store `true`;
  unchecked means the key is **removed**, never `false`.
- `created`, `title`, `type`, `calendar`, `repeat*` are app-meaningful. `tags`
  is not special — it's an ordinary list.
- Wikilinks work in the **body only** — `[[Note title]]`, matching a note's
  exact title or filename, no `|alias` form. Frontmatter never produces links.
  `![[cover.png]]` is an asset embed instead, resolved against `.assets/`.
- Literal code is not link syntax: a `[[link]]` inside a fenced block or an
  inline code span is an example, not a link — it is never indexed and a
  rename never rewrites it. That is how this file names the syntax safely.

## Property kinds

When a type is registered in the schema, each property may declare a `kind`:
`text` (default), `date`, `number`, `checkbox`, `multi`, `relation`, `url`,
`email`, `phone`, `file`. A text property with `options` renders as a select.
Dates are `YYYY-MM-DD`, optionally ` HH:MM`. Relations store the target note's
**title**, not a path.

## Dashboards, sheets and views

A **dashboard** is a note with `type: dashboard`. A `dashboard:` prop names the
renderer, and only these values are dispatched: `metrics`, `yield-apr`, `hub`,
`food`, `feed`, `music-work`, `tasks`, plus whichever machine-specific kinds
this build carries.
**Anything else — including no
`dashboard:` prop at all — falls through to a body scan**: one or more
` ```chart ` fences make it a charts dashboard, none falls back to the yield
tracker. So a chart dashboard needs no special kind, just the fences;
`dashboard: charts` is a conventional label, not a dispatched value.

A **sheet** is `type: sheet` with a ` ```csv ` fence (first row = headers) and an
optional ` ```formulas ` fence of `name = expression` lines.

The primitive you will reach for most is the **view fence** — a live, read-only
cut of a database, embedded anywhere in a note body. It is a code fence whose
info string is `view`, holding one `key: value` per line (`#` comments allowed).
Sketched below with the three backticks left off, because a real fence in this
file would be scanned as a real embed — open with backticks + `view`, close with
backticks:

    (open fence, info string: view)
    type: release
    query: status:unreleased
    view: table
    (close fence)

- `type` — a database type, spelled exactly as in the notes' `type:` key.
- `query` — optional; the filter-bar operator language (`status:live`,
  comma-OR, `due < 7d`, bare words match titles).
- `view` — accepted, but only `table` renders today.
- `saved` — alternative one-key form naming a pinned view by id or name; when
  present it wins over `type`/`query`.

Unknown keys are ignored, every fence in a body renders its own table, and a
malformed one shows a quiet inline error card instead of breaking the note.

For the rest of the format — sheets and the formula language, the yield
dashboard's csv snapshots, the metrics dashboard's `cards:` bindings, chart
fences, and workbook `pages:` — see §5 of `docs/vault-format.md` in the
Substrate repo (linked below), which is the authority.

## Where the full docs and examples live

This vault is self-contained, but the app's repo carries the deeper reference
material. If you can fetch URLs, these are the breadcrumbs:

- Repo: <https://github.com/x9x9x9x9x9x91/substrate>
- Vault format spec (the authority): `docs/vault-format.md`
- Dashboards guide — every kind, with frontmatter examples: `docs/dashboards.md`
- Cookbook — working per-kind dashboard recipes with screenshots: `cookbook/`

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
Settings.md         app settings, a normal note (capture hotkey, terminal…)
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

Root `AGENTS.md` and `CLAUDE.md` — this file and its pointer — are a softer
case: indexed and ordinary on disk, but **concealed from the app's note lists
and search by default** so the vault reads as the user's, not the tooling's.
The user reveals them with `show-agent-files: true` in `Settings.md` (a switch
in the ⌘, settings sheet). Don't be surprised when the user says they can't
see them, and don't "fix" it by duplicating their content into visible notes.

## `.vault/` — read it, don't hand-edit it

Machine-managed JSON, and the fastest way to orient yourself in an unfamiliar
vault:

- `schema.json` — every database and its property definitions. **Read this
  first**: it tells you the real types and property names in use.
- `views.json` — layout preferences, sidebar order, saved views.
- `folders.json` — external on-disk folders mirrored in as read-only stub notes.
- `format.json` — format versions. **Never bump it**; a version above the app's
  makes that file read-only in Substrate.

Prefer changing schema through the app. If you must write these files, write
atomically (temp file in the same directory, then rename) — the app watches them
live and a torn read looks like an empty file.

## Off limits

- `.assets/` — binaries, referenced by embeds. Deleting one is permanent;
  there is no trash and no history for assets.
- `.trash/` — deleted notes, restorable. Treat as read-only.
- `.git/` — the app owns version history here.

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
