# Vault format — the agent-facing contract

The vault is a folder of plain markdown files plus a few hidden support directories.
Any agent can read and write it correctly using only this document — no app code
required. Every rule below is verified against the engine; when this doc and the
code disagree, the code wins and the doc gets fixed (see AGENTS.md: format changes
update this file in the same merge).

Sources of truth: `src-tauri/src/vault/` (engine — `Engine` façade in `mod.rs`,
plus the `schema`, `views`, `search`, `trash`, `assets`, `mounts`, `foldersync`, `watch`,
`doctor`, `seed` modules), `src-tauri/src/lib.rs` + `src-tauri/src/commands/` (IPC),
`src-tauri/src/calendarfeed.rs` (read-only iCalendar subscriptions),
`src-tauri/src/history.rs` (vault git), `src/lib/*.ts` (frontend formats),
`docs/sheets-spec.md` (the sheet formula language).

## 1. Vault layout

The vault root resolves in three steps: `$VAULT_DIR` when set (it wins outright,
and need not exist yet — that is how dev and test runs point at scratch dirs),
else the path stored in this machine's app config, else `~/Vault` when it exists
and looks like a vault. When none of the three resolves, the app shows its
first-run picker instead of opening anything.

**"Looks like a vault" has two strengths**, because the two callers carry
different risk. The `.vault/` marker is conclusive for both. Without it:
*adopting* `~/Vault` unasked at boot accepts any single top-level `.md`, so an
install predating the marker never gets an onboarding screen; a folder the user
just *picked* needs at least two, so choosing `~/Documents` or a code checkout
with one `README.md` reaches the consent step instead of opening silently and
writing `.vault/` into it.
The stored choice lives in the OS app-config dir (`config.json`), never inside a
vault, so a vault that syncs or moves carries no stale pointer to itself.

**Who seeds a new vault**: whoever *creates* the folder. `Engine::new` seeds only
when handed a root that does not exist yet, so a vault created through the
first-run picker is seeded there and then (`init_chosen_vault` in `lib.rs`) —
creating `.vault/` makes the root exist and permanently disables the engine's own
freshness test. Adopting an existing folder never seeds.

**The demo vault** is `examples/vault` in the repo, bundled under the resource
target `demo-vault` (`bundle.resources` in `tauri.conf.json`; `vault_demo`
resolves the same name, and dev builds fall back to the checkout). It is copied
to `~/Documents/Substrate Demo` — a user-visible folder outside the
asset-protocol deny list (app-data is denied, so assets a user added to a demo
vault there could never load; SUB-645). A copy from before that move
(`<app-data>/Demo Vault`) is migrated to the new location at launch, a stored
vault choice pointing at it follows. A demo vault that already exists at the
destination is refreshed conservatively rather than reset: `.vault/demo-seed.json`
records the last bundled hash of each example file, so only a file still equal
to a known bundled revision is replaced. User edits and additions are preserved;
a missing previously bundled path is treated as a user deletion and is not
resurrected; a newly bundled path is added. A source counts only if it carries
`.vault/` *and* at least one note — if nothing usable is found the command fails
and says so, because opening an empty folder while promising sample content is
worse than not opening at all.

All note paths in this doc and in the API are vault-relative, `/`-separated,
and include the `.md` suffix (`Inbox/Capture anything.md`). A `..` path
component is rejected (dots inside a name, like `v1..v2.md`, are fine).

```
Vault/
├── Welcome.md                 # seeded on first run
├── Settings.md                # app settings, seeded + backfilled (§12)
├── AGENTS.md                  # agent orientation, seeded + backfilled (§12)
├── CLAUDE.md                  # pointer at AGENTS.md for agents that only auto-load this name (§12)
├── Inbox/                     # default capture folder (auto-created)
├── Journal/                   # daily notes (§12)
├── Calendar/                  # standalone events created from the calendar (§12)
├── Dashboards/                # convention only — dashboards can live anywhere
├── <any folders>/             # notes organize themselves; folders are just paths
├── .claude/skills/            # agent skills, seeded + user-written (§12)
├── .assets/                   # embedded binaries, flat (§9)
├── .trash/                    # deleted notes + folders, recoverable (§10)
├── .vault/                    # format.json + schema.json + views.json + folders.json + calendars.json + mounts.json + mounts/ + notifications.json + jobs-exit.json + templates/ + kinds/ + backup/ (§5b–§8)
└── .git/                      # version history, owned by the app (§11)
```

**The hidden rule**: any path component starting with `.` is invisible — never
indexed, searched, or watched (`vault/mod.rs` `hidden_rel`, `walk_md_files`). That
covers `.assets/`, `.trash/`, `.vault/`, `.git/`, and any `.foo/` you add
yourself. Only `.md` files are notes; binary files (containing NUL) are skipped,
invalid UTF-8 is read lossily. One explicit-path exception: `.vault/templates/`
(§7) stays unindexed but can be read and written directly.

**Loose files are visible without being indexed** (SUB-812): a folder view
lists the non-`.md` files sitting beside its notes — audio ones playable in
place — through `vault_folder_files`, a lazy per-folder `read_dir` that runs
when you open the folder. The index itself stays `.md`-only, so dropping a
gigabyte of masters into a vault folder costs the scan nothing. The listing
obeys the hidden rule above, which is also the whole dedupe story: an imported
embed lives in `.assets/` and therefore never doubles as a folder row. A
LINK-IN-PLACE embed (`![[/abs/path.wav]]`, §3) may point at a file a folder
view lists, and that is correct — one file with two surfaces, sharing one
player, because both address it by absolute path. Files past a per-folder cap
are counted but not listed; nothing here is watched, so the pane refetches on
the vault's own change event rather than live-updating per file.

## 2. Notes

A note is a `.md` file: an optional YAML frontmatter block, then a markdown body.

```markdown
---
type: release
status: in review
cat#: SMP-030
artist: various
created: 2026-07-17
---
Sample release note. Track order still open — see [[Static Bouquet]] for the
artwork direction.

![[sleeve-draft.png]]
```

### Frontmatter

- Must start at byte 0: `---\n` (or `---\r\n`), closed by a line that is `---`
  (trailing whitespace tolerated). Everything after the closing line is the body.
  No closing line → the whole file is body, no props (`vault/mod.rs` `split_frontmatter`).
  A leading UTF-8 BOM is stripped on read (`vault/mod.rs` `read_lossy`), so files from
  BOM-writing editors still parse; the BOM is not written back.
- Content is YAML and must parse to a **flat mapping** — anything else (scalar,
  list, invalid YAML) reads as zero props (`vault/mod.rs` `parse_props`). Reads are
  always this lenient; WRITES are not (SUB-215): a present block that fails to
  parse — or has duplicate top-level keys, which YAML would silently dedupe
  last-wins — makes every prop edit refuse with a `…is not valid YAML /
  has duplicate keys / is not a property map — fix it in the editor…` error
  instead of re-serializing the empty parse and wiping the other keys
  (`vault/mod.rs` `parse_props_for_write`). Rename is the one exception: it still
  proceeds (file move, wikilink rewrites) but leaves the broken block
  byte-verbatim.
- Scalars keep their YAML types: `created: 2026-07-17` stays a string (serde_yaml
  has no timestamp type), `close-to-tray: false` is a bool, `rating: 4` is a
  number, lists and maps are allowed (the metrics dashboard's `cards:` is a
  list of maps, §5.3).

### What the engine preserves vs normalizes

- **Body edits** (`vault_write_body`) preserve the frontmatter block **byte-verbatim**
  — order, quoting, comments — and replace only the body. A write to a **missing
  file fails** (`note no longer exists`) rather than resurrecting it body-only
  (SUB-94); the `.vault/templates/` lane (§7) is the one create-through-write
  exception. The optional `expectedBody` argument is an optimistic-concurrency
  guard (SUB-93): when passed, the write is rejected with
  `conflict: file changed on disk` if the body on disk no longer matches it
  (frontmatter-only changes don't trip it), so a stale editor buffer can never
  silently clobber an external edit.
- **Prop edits and renames** (`vault_set_prop`, `vault_rename`) re-serialize the
  **entire** frontmatter through serde_yaml: keys come out alphabetically sorted,
  quoting normalized, typed values kept — except the prop being set, whose
  accepted shapes are **string, number, bool, string list, or absent**; a map
  or a mixed list is refused (`property values must be strings, numbers, bools,
  or string lists`). Removing
  the last prop removes the whole `---` block. Both lanes refuse when the
  existing block is unparseable or has duplicate keys (§2, SUB-215) — a broken
  block is never silently normalized away.
  Never depend on key order, comments, or hand-tuned quoting in frontmatter.
- The app's prop editor only *authors* strings — the note menu's calendar opt-out
  is the one bool it writes. Numbers reach the write path on the read side only:
  `vault_set_prop` hands back the raw prior value, and undo writes that same
  scalar back (SUB-477), so the write domain has to accept everything the read
  domain can produce. A structured value (map, mixed list) is fully supported on
  disk but renders in the UI as its JSON text and cannot be written back.

### `title:` and the filename

- Display title = the `title:` prop, else the filename stem (`Note.md` → `Note`).
- The app keeps filename ≈ title. Rename moves the file to the sanitized title in
  the same folder and stores the exact title as a `title:` prop only when
  sanitizing changed it; when the slug is lossless, `title:` is removed
  (`vault/mod.rs` `rename`). Renaming also rewrites every `[[wikilink]]` in the vault
  that pointed at the old title **or stem**, and every schema'd relation value
  naming it (§6).
- Sanitize (`vault/mod.rs` `sanitize_filename`): `/ \ : * ? " < > |` → space,
  whitespace runs collapse, empty → `Untitled`. So `Vessel: Songs/Live` becomes
  `Vessel Songs Live.md` with `title: 'Vessel: Songs/Live'`.
- Two title shapes are rejected outright at rename/create — before any file
  write, move, or link rewrite (`vault/mod.rs` `validate_note_title`, SUB-223): a
  sanitized stem starting with `.` (the note would fall under the hidden rule
  and vanish from the index) and any `[`/`]` in the title (rewritten
  `[[wikilinks]]` would corrupt). URL captures whose fetched title is rejected
  keep the bare-URL title instead.
- Creates dedupe: `Idea.md`, `Idea 2.md`, `Idea 3.md`…
- A new note from the app starts as:

```markdown
---
created: 2026-07-17
type: release
---
```

(`type:` only when created into a database; value YAML-quoted when needed.)

### Props the app gives meaning to

| prop | meaning |
| --- | --- |
| `type` | database membership / app machinery (§4) |
| `title` | display title when the filename can't carry it |
| `created` | ISO day, written by the app on create |
| `calendar` | `false` hides the note from the calendar (§4/§12, SUB-175); absent or any other value shows it |
| `url` | source link on `type: reference` notes |
| `artwork` | gallery cover: bare asset name, absolute/`~/` path, or `![[...]]`/`[[...]]` wrapper |
| `dashboard` | dashboard renderer key on `type: dashboard` notes (§5.2) |
| `icon` | dashboard sidebar icon override (§5.2): a curated glyph id or an emoji |
| `cards` | metrics dashboard card list (§5.3) |
| `claimed_usd` | yield dashboard: cumulative claimed total, set by the Claim button (§5.3) |
| `log`, `db`, `weight`, `floor`, `ceiling` | food dashboard config: log-sheet, food-DB and weight-sheet names, net-kcal band (§5.2) |
| `items`, `curated` | feed dashboard config: items-sheet name, and the curator's own last-run stamp, rendered verbatim (§5.2) |
| `index`, `scanned` | music-work dashboard config: work-index sheet name, and the scanner's own last-run stamp, rendered verbatim (§5.2) |
| `areas`, `stale_days` | tasks dashboard area allowlist and stale-age threshold (§5.2) |
| `view`, `sort` | tasks dashboard layout (`list`/`board`) and ordering (`urgency`/`priority`/`due`/`age`) (§5.2) |
| `now`, `snoozed_until` | tasks board: pinned to the focus section / parked until a wake day, both board-scoped (§5.2) |
| `tags` | tag list, unioned with the body's inline `#tags` (§3b) |

Everything else is yours. Unknown props are preserved and shown as chips.

## 3. Links and embeds

### Wikilinks

`[[Target]]` in the body. The grammar is exactly `\[\[([^\[\]]+)\]\]` — no nested
brackets, **no `[[target|alias]]` form** (the pipe becomes part of the name).

- Resolution (`vault/mod.rs` `resolve_link`): the trimmed target, matched
  **case-insensitively** against each note's `title` **or** stem. Title-vs-stem is
  one test, not two phases; if two different notes could claim a target (one by
  title, one by stem) the winner is unspecified — keep titles and stems unique.
- An unresolved target that matches a **database name** (case-insensitive)
  opens that database view instead — hub pages link to databases with plain
  wikilinks. This is app-side navigation only; the engine still reports the
  link unresolved.
- Following a link unresolved by both tests creates the note (that's how
  `Sketchpad` works, §12).
- Only body text is scanned — frontmatter never produces links. Backlinks use the
  same title/stem matching.
- **Literal code is not link syntax** (SUB-495): a link inside a fenced block
  (` ``` ` or `~~~`, any language) or an inline `` `code` `` span is documentation
  *about* the grammar, not a use of it. It is never indexed, never a backlink,
  never a `broken-link` finding, and a rename never rewrites it — matching what
  the editor already renders (code shows verbatim, no link decoration). Embeds
  (§3) follow the same rule: a fenced `![[…]]` is not a missing asset. An
  unclosed fence swallows the rest of the body, as in any markdown renderer.
- The engine rewrites links on rename; nothing else ever rewrites them. A link to
  a trashed or never-created note is simply unresolved.

### Embeds

`![[target]]`, grammar `!\[\[([^\[\]]+)\]\]`. Three target forms
(`vault/assets.rs` `asset_info`):

```markdown
![[bounce.wav]]                 ← bare name → <vault>/.assets/bounce.wav
![[/Volumes/audio/master.wav]]  ← absolute path, linked in place (never copied)
![[~/Music/mixdown.flac]]       ← home-relative, linked in place
```

- Rendering is by extension: audio (`.wav .aif .aiff .mp3 .flac .m4a .ogg
  .opus .weba .webm`) renders an audio player (streams from disk); images
  (`.png .jpg .jpeg .gif .webp .svg .avif .heic .heif`) render inline; **any
  other extension renders a file chip** — the name plus its size. Click or Enter/Space opens
  the file in the OS-default app; there is no in-app preview. Paste/drop
  accepts any file type and copies it into `.assets/` (§9); **⇧-drop links in
  place instead** (macOS) — the embed stores the `~/`-contracted path and the
  file never enters the vault, with the usual link-in-place caveats (broken
  when moved, skipped by export bundles, invisible to sync/backup).
- The inline editor image resolves **only `.assets/` bare names**; a link-in-place
  image embed shows the editor's missing state (`missing image · <name>`). Gallery
  covers are the exception: they resolve `~/`/absolute targets via the `artwork`
  prop or the first image embed in the body.
- Missing or moved targets render `missing image · <name>` / `missing audio ·
  <name>` / `missing file · <name>` — a display state, not an error; the file
  content is untouched.


## 3b. Tags

A note's tags come from **two sources, unioned** — an inline `#tag` in the
body and an entry in the `tags:` frontmatter prop are the same statement, so
neither wins:

```markdown
---
tags: [live, demo]
---

Bounced the #demo and filed it under #live-set.
```

That note's tags are `demo`, `live-set`, `live`. Extraction runs inside
indexing (`vault/tags.rs`, mirrored by `src/lib/tags.ts` — the two are
lockstep twins with mirrored tests), so tags are watcher-live: edit the body,
the collections update.

### Inline grammar

`#` then a **letter**, then any run of letters, digits, `-` and `_`
(`#[A-Za-z][A-Za-z0-9_-]*`). Trailing `-`/`_` are trimmed — `#demo-` in prose
is the tag `demo` followed by a dash.

The character **before** the `#` must be whitespace or punctuation, and must
not be one of `&`, `#`, `/`, `_`. That rule plus the leading-letter rule is
what keeps these out:

| not a tag | why |
| --- | --- |
| `# Heading`, `### Notes` | space after `#`; `###` fails the preceding-`#` rule |
| `#1`, `#404` | no leading letter |
| `#ff00aa` | **is** a tag (`ff00aa`) — a CSS hex colour in prose reads as one. Put it in `code` if you mean the colour |
| `&#x27;` | preceded by `&` (HTML entity) |
| `foo#bar`, `a_#b` | preceded by an alphanumeric / `_` |
| `[[Note#heading]]`, `![[a#b]]` | wikilink and embed targets |
| `](/path#frag)`, `https://x.test/#top`, `www.x.test/#top` | link destinations and bare URLs |
| ` ```…#demo…``` `, `` `#demo` `` | fenced blocks and inline code — literal code is not tag syntax, the same rule links follow (§3, SUB-495). An unclosed fence swallows the rest of the body |

**Case**: matching, grouping and dedupe are case-insensitive — `#Demo` and
`#demo` are one tag. Display keeps the author's casing; where a tag appears in
several spellings, the most common one is shown (ties go to the
alphabetically first).

### The `tags:` prop

A YAML string list is the canonical shape; a bare scalar is accepted and split
on commas. A leading `#` is stripped, so `tags: ["#demo"]` and `tags: [demo]`
are the same tag. Values that couldn't be written inline (spaces, punctuation)
are kept verbatim — the prop is the author's, and the app never rejects a tag
it merely couldn't have parsed from prose. Tags written **into** a note by the
app (see §8b) always go to this prop, never into the body.

### Where tags do not apply

Nested tags (`#a/b`), tag colours, tag renaming and tags in pulse/fences are
not part of this format. `#a/b` reads as the tag `a` followed by `/b`.

## 4. Databases and prop values

A note becomes a database row by having a `type` prop — nothing moves, no file is
created. Every distinct `type` string is a database (exact, case-sensitive match);
the sidebar lists them all except `dashboard`, whose notes each get their own row
— in the Dashboards section, or in the Folders tree when filed outside the
dashboards home folder (§5.2).
A type registered in `.vault/schema.json` (§6) is also a database and lists in
the sidebar even with zero notes — that's what "New database" writes (SUB-43).

On disk the key stays `type:`; the UI presents it as “Database” (SUB-77 Option A).

Database management (SUB-43, all engine-side, all guarded against
case-insensitive name collisions; every bulk note sweep is preceded by an
explicit history snapshot — the safety rail):

- **Create** registers the type in schema.json with its initial props; nothing
  else is written. Notes arrive later, when entries are created.
- **Rename** bulk-rewrites `type:` on every note of the type; the schema key
  (icon and home included), relation-prop targets, the views.json pref, the
  sidebar order entry, and `.vault/templates/<type>.md` all follow.
- **Delete** is an explicit choice: strip `type:` from the type's notes (they
  become untyped) or move them all to `.trash/` (recoverable until emptied —
  never a silent file deletion). Either way the schema entry, views pref,
  sidebar order entry, and template file go with the database.
- **Rename property** moves the schema key and bulk-rewrites the frontmatter
  key across the type's notes; notes already carrying the new key are skipped,
  never clobbered. A `group_by`/`table_group_by` pref on the old name follows.
- **Remove property** is instant schema removal (the demote rule, §6); the
  "also delete values from N notes" strip is a second, separately-confirmed
  sweep (`vault_clear_prop`, which also clears a `group_by`/`table_group_by`
  on the prop).

```markdown
---
type: gear
category: mixer
status: in studio
created: 2026-07-17
---
```

Types with app meaning: `dashboard` (§5.2), `sheet` (§5.1), `event` (calendar
standalone entries, §12), `reference` (captured links, §12). None of these is
reserved — they just activate renderers.

Prop value forms (all plain YAML, all portable):

```yaml
status: in review                      # string — the common case
released: 2026-07-17                   # ISO day string — date-kind props (§6)
starts: '2026-07-19 14:30'             # a date may carry a 24h time (SUB-270, §6)
trip: 2026-09-01/2026-09-21            # a date may be a range: start/end (SUB-596, §6)
contract: ~/Documents/deals/SMP-30.pdf # file-kind prop: link only, target never touched
rating: 4                              # number (UI shows JSON text)
in use: true                           # checkbox-kind prop (§6): YAML bool — checked
price: 1299.50                         # number-kind prop (§6): stays exactly this scalar — format is display-only
tags: [vinyl, promo]                   # list (JSON text in the UI — a schema'd multi-kind prop, §6, renders dotted values instead)
```

- Dates are `YYYY-MM-DD` strings, optionally suffixed with a space and
  `HH:MM` (24h — `2026-07-19 14:30`; SUB-270; a single-digit hour — `9:30` —
  is accepted on input and read as the padded form, SUB-714). Readers also
  tolerate `T` as the separator (`2026-07-19T14:30`), but app writes keep the
  padded space form canonical. Day-only values are the common
  case and behave identically everywhere; a timed value still lands on its
  day, sorting after the day's all-day entries, and keeps its time across
  drag-rescheduling and recurrence expansion. The calendar also discovers
  dates heuristically: any prop whose value is ISO-day-shaped (with or
  without the time) counts as a date, except
  `created`/`updated`/`title`/`type`/`calendar`/`repeat`/`repeat_until`/`repeat_skip`
  and any prop on `dashboard`/`sheet` notes — an explicit `kind: "date"` in the
  schema always wins (`src/lib/calendar.ts`). A note carrying `calendar: false`
  (bool or the string `"false"`) is hidden from the calendar entirely (SUB-175).
- A date may also be a **range**: two of those values joined by `/`, the
  ISO-8601 interval form — `2026-09-01/2026-09-21`, or with times,
  `2026-09-01 09:00/2026-09-03 17:00` (SUB-596). There is no separate prop
  kind; a range is a date-kind value with an end. Both halves must parse and
  the end may not precede the start, otherwise the value is not a date at all
  (Doctor flags it on a schema'd date prop, §11). A range **sorts by its
  start**, so a span and a single date on the same day sit together. Filters
  (§8) require the WHOLE span to satisfy the relation, which is why `due <
  today` skips a span still running and catches it the day after it closes —
  a range is overdue only once its END has passed, the same rule the
  calendar, the agenda and the tray use. The calendar draws a range as a
  multi-day bar in month and week views and lists the note on every day it
  covers; only its first day is draggable, and a drag moves the whole span by
  the same delta. Table cells and prop chips collapse a range to what its
  endpoints share — `Sep 1 – 21, 2026`, `Sep 1 – Oct 3, 2026`, `Dec 28, 2026
  – Jan 3, 2027` — printing both endpoints in full whenever either carries a
  time. **Recurrence ignores ranges**: a repeating note's range-valued prop
  expands from its start day, one single-day occurrence per step, and the
  span is not carried onto the occurrences (§6).
- File paths prefer the `~/…` form (portable across machines; the app contracts
  absolute paths under home automatically). The target is a link — Substrate never
  copies, moves, or deletes it.

## 5. Data-in-note conventions

Data lives in fenced blocks inside the note body. The note text is the source of
truth; every UI over it is a view. Fences are matched by ```` ```<lang>\n … ``` ````
anywhere in the body (first match wins); everything outside the fence is
preserved byte-for-byte by the app's edits.

### 5.1 Sheets — ` ```csv ` + ` ```formulas `

A sheet is `type: sheet` with a csv fence (data) and an optional formulas fence
(computed columns + named summaries):

````markdown
---
type: sheet
title: Holdings
---

```csv
asset,bucket,units,price_usd
GLOW,etf,1200,31.4
BTC,crypto,4.1,64200
```

```formulas
value_usd = units * price_usd
value_eur = value_usd * FX("USD","EUR")

total  = SUM(value_eur)
crypto = SUMIF(bucket, "crypto", value_eur)
```
````

- CSV: first row is headers; `"` quoting with `""` escapes for commas/quotes/newlines;
  CRLF tolerated (`src/lib/sheet.ts` `parseCsv`).
- Formula lines are `name = expression`; `#` starts a comment. Lines referencing
  columns per-row become computed columns; lines using aggregates or only
  summaries/cross-sheet values become named summaries.
- **Blank lines inside the formulas fence are meaningful (SUB-939)**: they split
  it into blocks, and the app's summary bar shows the first block holding
  summaries while later ones collapse behind a toggle. Purely presentational —
  evaluation, classification and bindings ignore the grouping — but a writer
  reordering a fence should know the blank lines carry intent. The example
  above is the idiomatic shape: computed columns, blank line, totals.
- Cross-sheet references: `Holdings.total`, quoted when the name has spaces
  (`"Portfolio Tracker".total`); resolved by note title/stem, case-insensitive.
- The full formula language (aggregates, `IF`, `ROUND`, `FX`) is specified in
  `docs/sheets-spec.md` — don't duplicate it here.
- `FX("USD","EUR")` uses the frankfurter.dev rate, cached app-side (SUB-386)
  and refreshed live — the app never writes fx props into notes.

### 5.2 Dashboards — `dashboard:` key

A dashboard is `type: dashboard` with a `dashboard` prop naming the renderer:

```yaml
---
type: dashboard
dashboard: yield-apr
created: 2026-07-17
---
```

Where the row lives (SUB-466, SUB-605): a dashboard note may sit in any folder,
and its PATH decides which sidebar surface shows it. The app derives a
"dashboards home" — the folder whose subtree holds the most dashboards, `Dashboards/`
by convention — and gives the Dashboards section the ones inside it: directly in
home flat, one level of subfolders as collapsible groups (deeper nesting folds
into its first segment). A dashboard in any OTHER folder renders as a row inside
that folder's node in the Folders tree instead, beside its databases and pinned
notes; dragging it between folders (or onto the Dashboards header) moves the
file and hands it to the other surface. No dashboard renders on both
(`src/lib/sidebar.ts` `splitDashboards`). Notes at the vault root and inside the
hidden surfaces (`Journal/`, `Dashboards/`) have no tree row to nest under, so
those always stay section rows.

Sidebar icon (SUB-391): each dashboard row renders a curated per-kind glyph
(`src/lib/dbicons.ts` DASHBOARD_ICONS — `food`, `metrics`, `yield-apr`, `hub`,
`feed`, `music-work`, `tasks`,
plus any machine-specific kinds this build carries); an `icon:` prop overrides
it (a curated glyph id, anything else treated as an emoji), and kinds without a
mark keep the generic chart glyph.

Dispatch (`src/components/DashboardPane.tsx` `DashboardBody`) — a fixed key set.
These public kinds are dispatched: `metrics` → the metrics cards renderer (§5.4);
`yield-apr` → the yield tracker (§5.3); `hub` → the hub renderer (below);
`food` → the food log tracker (below); `feed` → the curated newsfeed (below);
`music-work` → the work-index board (below); `tasks` → the read-only task
attention board (below); `charts` → the chart-fence dashboard (§5.5), whether
or not the body actually holds a fence.
**A missing `dashboard` prop looks at the body** — one or more ` ```chart `
fences makes it a charts dashboard (§5.5), none falls back to the yield
tracker. So a charts dashboard needs no specific key, just the fences;
`dashboard: charts` says the same thing by name.

**Any other value renders an error card** naming the value and listing the
kinds this build does dispatch (SUB-993) — the quiet inline posture a ` ```view `
fence over an unknown database takes. A typo is never answered with a different
dashboard: falling through to the yield tracker meant `dashboard: yeild-apr`
silently rendered a financial tracker, snapshot form included, with no hint
that the key was wrong.

`tasks` (SUB-732; actions SUB-786; board v3 SUB-870) is a task interface over
task notes, led by due dates. Row clicks open the source note; the board also
authors and writes task state through the standard paths (`vault_create` for
the composer, `vault_set_prop` — undoable — for the rest): checkoff sets
`status` to the task type's own done-like option, the Now/Later verb
sets/removes `now`, the snooze menu sets `snoozed_until` and Wake clears it.
Its dashboard note holds only optional config:

```yaml
---
type: dashboard
dashboard: tasks
areas: [Label, Studio] # YAML string list, or comma-separated scalar
stale_days: 30         # positive whole number; default 30
view: board            # `board` for the kanban view; default (or `list`) = the list
sort: due              # `priority` | `due` | `age`; default (or `urgency`) = urgency
---
```

- Open rows have `type: task` after case/whitespace normalization and do not
  have a similarly normalized `done` or `cancelled` status. `areas` is a
  case-insensitive allowlist over each task's `area`; its order/casing becomes
  the group order/label. Omitted means all areas, while a supplied empty list
  means none. Without an allowlist groups sort by name with missing `area`
  under `Unassigned` last.
- **Sections (SUB-870)**: the board's spine is **Overdue**, **Due today**,
  **Now**, then the area groups, and an empty section is omitted rather than
  rendered blank. `due` is a strict `YYYY-MM-DD`, optionally with a trailing
  ` HH:MM` (SUB-270) that buckets by its day; it places a row in Overdue
  (before today) or Due today, wherever its area is. Urgency outranks the pin:
  a `now: true` task that is overdue or due today shows in that section, not
  in Now. Everything else — upcoming and undated alike — stays in its area
  group. A missing or malformed `due` is simply no due date: never a finding,
  never a reason to move or hide the row.
- **Ranking (SUB-870; sort switch SUB-933)**: the default order within every
  section is due bucket (overdue → today → upcoming → none), then priority,
  then age, then title, then path — so input order never changes the board
  (`src/lib/tasksDashboard.ts`). Trimmed, case-insensitive `high` / `medium` /
  `low` weigh 3 / 2 / 1; missing or unknown priority weighs 1. Age is the
  tiebreaker only; the `age × priority` rot score that ordered v2 is gone.
  `priority` renders as a pill in the schema's own option color, falling back
  to red / yellow / gray when the vault never schema'd the prop.
- **Sort switch (SUB-933)**: the header's sort control re-ranks rows within
  list sections and board columns alike. `urgency` is the default above;
  `priority`, `due` (soonest first, undated rows last), and `age` (oldest
  first) each lead with their dimension and keep the others as tiebreakers,
  ending on the same title/path tail so every ordering stays deterministic.
  The choice persists as a `sort` frontmatter prop on the dashboard note; the
  default clears the prop, and an unknown value falls back to `urgency`
  rather than blanking the board.
- **Kanban view (SUB-933)**: the header's List | Board control flips the pane
  to one column per area, persisted as `view: board` on the dashboard note
  (the default `list` clears the prop). Columns follow the area allowlist's
  order — every listed area keeps a column even when empty, as a drop
  target — or, without an allowlist, populated areas alphabetically with
  `Unassigned` last. Urgency never relocates a card: the Overdue/Today/Now
  sections are a list-view reading, and on the board each card stays in its
  area column with due/priority chips carrying the urgency signal. Cards keep
  the row's verbs (checkoff, due/priority edit, Now, Snooze); dragging a card
  to another column rewrites its `area` through the same undoable path, and
  dropping on `Unassigned` clears the prop. The snoozed section, composer,
  and header tallies are view-independent.
- Age is whole local-calendar days from a strict `created: YYYY-MM-DD` value;
  future dates clamp to zero. Missing/invalid dates render an `undated`
  finding and no age. A dated task is stale at `age >= stale_days`; an
  invalid/non-positive threshold uses 30. Both findings are secondary
  diagnostics — amber chips beside a row, not its place on the board.
- **Now (SUB-786)**: a task with `now: true` (YAML boolean, or the string
  `"true"` after trim/case folding) pins to a cross-area "Now" section, the
  hand-picked focus list, while nothing is due on it. Pinned rows never carry
  `stale`/`undated` findings: Now is chosen work, not rot. Unpinning removes
  the key. There is deliberately no cap.
- **Snooze (SUB-786; round trip SUB-870)**: a task whose `snoozed_until` is a
  strict future `YYYY-MM-DD` (local calendar) leaves the board for a collapsed
  **Snoozed** section listing each row with its wake day, soonest first;
  snoozed ≠ stale. Wake clears the prop and the row rejoins the board. Today,
  past dates, and malformed values never hide a task — a bad date silently
  vanishing a row is the worst failure shape for a trust surface. The prop is
  board-scoped: database views, Today, and the calendar ignore it. The section
  is filled after the area allowlist, so off-board areas don't inflate it.
- **Inline editing (SUB-870)**: a row's due chip and priority pill are the
  edit affordances for those props, writing `due` and `priority` through the
  same undoable path the verbs use. An unset value keeps a placeholder in the
  same cell, so the grid never shifts. Priority offers the schema's own
  options where the vault defines them, high/medium/low otherwise; the board
  never edits the schema itself.
- **Quick-add (SUB-870)**: the composer creates a `task` note in the type's
  home folder and seeds the schema's first non-completion `status` (else
  `todo`), today's `created`, when the board runs an allowlist its first
  `area`, and the optional `due` picked on the composer's own chip. The
  created row is scrolled to and briefly highlighted, since under urgency
  ranking an undated new task sorts to the bottom of its area group. The area
  seed is load-bearing: an area-less
  task lands in `Unassigned`, which an allowlist filters straight off the
  board, so a row created here would appear to vanish.

`hub` (SUB-189) is the column-first home-page renderer. The body stays
ordinary markdown — no on-disk column syntax — and the renderer lays it out
as a hub:

- a `## ` heading becomes a section label;
- a maximal run of consecutive callout blocks (`> [!note|warn|idea] Title`
  plus its `> ` continuation lines — the editor's ordinary callout syntax,
  kind case-insensitive) renders as cards side by side in a responsive grid —
  the columns, with a muted kind accent (note/warn/idea);
- everything else (paragraphs, lists, checkboxes, tables, `![[image]]`
  embeds, fences, plain quotes) renders full-width in linear flow between
  card rows. Checkboxes are display-only; audio/file embeds render their
  `embedded file · <name>` placeholder.


The hub is read-only — "Open source note" drops into the editor, and the file
stays plain markdown any editor can read (`src/lib/hub.ts`,
`src/components/HubDashboard.tsx`).

`food` (SUB-325) is a daily net-kcal tracker. Unlike the yield tracker it
does NOT own its data — the dashboard note holds only config props, and the
rows live in a separate log sheet the pane reads and writes:

```yaml
---
type: dashboard
dashboard: food
log: Food Log     # title/stem of the log sheet note (default "Food Log")
db: Food DB       # title/stem of the food-base sheet (default "Food DB")
weight: Weight Log # title/stem of the weight sheet overlaid on the strip
                   # (default "Weight Log"; missing = no overlay)
floor: 1900       # net-kcal band, defaults 1900–2300
ceiling: 2300
---
```

The log note is an ordinary sheet (§5.1) whose csv fence carries the columns
`date,food,kcal,protein_g` — matched by header name, case-insensitive, order
free; `protein_g` optional. `date` is a local ISO day; `kcal` is net
(negative rows = exercise); rows with a malformed date or non-numeric kcal
are skipped, not errors. The pane appends quick-add rows inside the fence
(creating fence + header when missing), dated its selected day (SUB-408 day
navigation — today by default), and deletes single rows by position;
external writers may append the same way. Formulas in the log note stay
untouched (`src/lib/food.ts`, `src/components/FoodDashboard.tsx`).

The DB note (SUB-408) is a second ordinary sheet whose csv fence carries
`name,kcal,per,protein` — same name-based, order-free matching. `per` is the
basis the row's numbers are quoted at: `100g`, `100ml`, or `x` (per
unit/piece; `unit` is accepted on read, written as `x`). `kcal` and the
optional `protein` are per ONE basis; rows with an empty name, non-numeric
kcal, or an unknown basis word are skipped. The optional `g` column
(SUB-687; `g_per_unit` accepted on read, written as `g`) is grams per one
unit on `x` rows — the piece↔gram bridge that lets autocomplete price
gram-typed quantities against piece-based foods; it is ignored on
`100g`/`100ml` rows and never inferred from the log. The pane upserts by
name (case-insensitive replace in place, never a dupe) and deletes by
position. Autocomplete prices the DB's basis over the log's replayed memory
and surfaces never-logged foods; a missing DB note only dims the pane's
Database section — logging keeps working (`src/lib/fooddb.ts`,
`src/lib/foodsuggest.ts`).

The weight note (SUB-707, `weight` prop, default "Weight Log") is a third
ordinary sheet, read-only to the pane: its csv fence carries `date,kg` —
same name-based, case-insensitive, order-free matching, extra columns
ignored. `date` is a local ISO day; rows with a malformed date or a
non-numeric or implausible `kg` (outside 20–400, catching digit slips) are
skipped, not errors, and a day logged twice keeps the last row. The pane
draws the days inside its 14-day window as a line over the kcal bars, on
weight's own vertical scale (window min/max, widened to at least 1 kg and
padded, so a 0.6 kg move reads as a move); unlogged days get no dot and the
line bridges them — weight is continuous, unlike kcal where absent ≠ 0. A
missing weight note means no overlay and no error chrome (`src/lib/weight.ts`,
`src/components/FoodDashboard.tsx`).

`feed` (SUB-518) is a curated newsfeed. Like `food` it does NOT own its data:
the dashboard note holds only config props, and the items live in a separate
sheet an external curator agent writes.

```yaml
---
type: dashboard
dashboard: feed
items: News Items      # title/stem of the items sheet (default "News Items")
curated: 2026-07-26 09:10   # optional; rendered verbatim; also parsed (leniently) for the
                            # head's ~36h staleness dot — a parse failure stays neutral (SUB-699)
---
```

The items note is an ordinary sheet (§5.1) whose csv fence carries the columns
`date,topic,title,source,url,blurb,why,fb` — matched by header name,
case-insensitive, order free. `date` is a local ISO day; `topic` is a freeform
slug (`plugins`, `scene`, `local`, `hardware`, `ai`, `world`, `wild` get a
palette hue, any other value renders with a neutral chip); `blurb` says what it
is and `why` says why it matters, shown as two distinct voices; `url` is opened
externally only when it's `http(s)` — anything else renders unlinked. `fb` is
`""` | `up` | `down`.

Stream order is `date` DESC, then the sheet's own row order within a date —
that intra-day order IS the curator's ranking, so the pane never re-sorts it.
Rows with a malformed date or an empty title are skipped, not errors.

**The app is the only writer of `fb`.** A vote is a conflict-guarded write of
that single cell (`setSheetCell`), so every other row and the curator's quoting
round-trip byte-identical; clicking the active verdict clears it. A curator
re-write between the pane's read and a click fails as a conflict and the pane
re-reads disk truth (`src/lib/feed.ts`, `src/components/FeedDashboard.tsx`).

`music-work` (SUB-595) is a read-only board over a production-tree index. Like
`food` and `feed` the dashboard note holds only config props; the rows live in
a separate sheet an external tree scanner writes.

```yaml
---
type: dashboard
dashboard: music-work
index: Work Index           # title/stem of the index sheet (default "Work Index")
scanned: 2026-07-30 00:10   # optional; rendered verbatim, never parsed
---
```

The index note is an ordinary sheet (§5.1) whose csv fence carries the columns
`category,client,job,year,last_active,files,size_mb,flags` — matched by header
name, case-insensitive, order free. `year` is the job's 4-digit year;
`last_active` a local ISO day; `files` and `size_mb` are counts (anything
unparseable reads as 0); `flags` is freeform scanner prose about the row's
dating, shown as a chip whose tooltip carries the text.

Three pivots over the same rows — year (default), artist, category — each
sorting its groups newest-year-first or A–Z, with jobs inside a group ordered
by `last_active` DESC and undated jobs last. A row with no job name or no
4-digit year is skipped, not an error; an empty or missing sheet is an empty
state, not an error.

**The app never writes this sheet** — the pane is read-only, so a scanner
re-write between reads costs nothing (`src/lib/musicwork.ts`,
`src/components/MusicWorkDashboard.tsx`).


### 5.3 Yield dashboard — ` ```csv ` snapshots

The yield dashboard reads and appends to a csv fence in its own note:

````markdown
```csv
at,yield_usd,principal_usd
2026-07-17 10:00,0,1000000
2026-07-17 11:00,60,1000000
```
````

- Header exactly `at,yield_usd,principal_usd`; `at` is local `YYYY-MM-DD HH:MM`;
  numbers parse as floats; rows are sorted by time when read.
- Append-only: the app adds rows inside the existing fence, or creates the fence
  at the end of the body when missing (`src/lib/dashboard.ts` `appendSnapshotToBody`).
  External writers should do the same — append, never rewrite history rows.
- Claims (SUB-318): a `claimed_usd` prop on the note holds the cumulative
  claimed total. `yield_usd` in csv rows is ALWAYS cumulative (claimed +
  current venue balance) — the Claim button sets `claimed_usd` to the last
  row's total, and the log form adds `claimed_usd` to entered venue balances
  before writing the row. History rows never change on a claim; external
  writers appending rows must add `claimed_usd` the same way.

### 5.4 Metrics dashboard — `cards:` + `{{Sheet.summary}}` bindings

Cards come from the dashboard note's frontmatter; each binds a label to a named
summary on a sheet:

```yaml
---
type: dashboard
dashboard: metrics
cards:
  - label: Total value
    bind: "{{Holdings.total}}"
    format: eur
    emph: true
  - label: Crypto share
    bind: "{{Holdings.crypto}}"
    format: number
    digits: 2
---
```

- `bind` is `{{Sheet.summary}}` (the `{{ }}` wrapper optional in parsing, canonical
  in files). The sheet resolves by title/stem; the name must be a **summary**
  (§5.1), not a column.
- `format`: `eur` | `usd` | `number` | `pct` (anything else → raw value);
  `digits`: decimal places, optional, **0–8** — the same bound the grid tile
  syntax takes (§5.6b). A card asking for more is clamped to 8 rather than
  refused, here and in the ` ```cards ` fence; anything that isn't a whole
  number reads as absent.
- `emph`: optional, `true` only (anything else reads as absent). Marks the
  card as one of the board's sharp anchors — at most two, first two in card
  order if more are flagged; with none flagged the first card is sharp.
  Unflagged cards render in the quiet voice (design principle 11).


### 5.5 Chart blocks — ` ```chart ` fences

A ` ```chart ` fence inside a dashboard note declares one chart (SUB-33). Config
is hand-editable `key: value` text, one per line; `#` comments allowed:

````markdown
---
type: dashboard
dashboard: charts
---

```chart
source: release
x: released:month
y: count
kind: bar
title: Releases per month
```

```chart
source: {{Holdings}}
x: asset
y: sum:value_eur
kind: line
```
````

Keys (`src/lib/chart.ts`; `source` always required, plus either `x` + `y` (row
binding) or `series` (summary binding)):

- `source` — a database type (`release`), or `{{Sheet Name}}` for a sheet. A
  database source reads every note of that type (case-insensitive type match);
  a sheet source reads its data rows **plus computed columns** (summaries are
  not rows — to plot those, use `series` below).
- `x` — the bucket axis: `<prop>` for a categorical axis (scalar values, or a
  string list joined with `, `), or `<date prop>:<bucket>` with bucket `day` |
  `week` | `month` for a date axis. Date axes accept scalar dates only; lists
  are skipped rather than choosing one item. Bucketing: day = the ISO day
  itself, week = the Monday of the containing week (Monday-first), month =
  `yyyy-mm`. A time suffix is ignored (`2026-07-17 10:28` buckets as
  `2026-07-17`).
- `y` — the reduction: `count` (rows per bucket), `sum:<prop>`, or `avg:<prop>`.
  The prop must hold numbers (numeric strings coerce).
- `series` — the summary binding (SUB-745): a comma-separated list of a sheet's
  named summaries (`series: etf, crypto, cash`), each plotted as one point in
  fence order. Sheet sources only, and exclusive with `x`/`y` — a fence carrying
  both, or `series` on a database source, is a parse error. Names match
  case-insensitively; the sheet's own casing labels the point. A name that is
  not a numeric summary on that sheet (a row column, a typo, an errored or
  non-numeric summary) errors the whole chart naming it, rather than dropping
  the point — a hand-named point set must not silently lose one.
- `by` — optional series split (SUB-941): a prop or column whose distinct values
  each become one series — stacked slices on a bar, one line each on a line
  chart, named by a legend above the plot. Row binding only, and exclusive with
  `series` (both name the series axis, so a fence carrying both is a parse
  error). Values fold case to group and keep their first-seen casing; series
  order is first-seen. A row whose `by` field is blank or unreadable is skipped
  like a missing x, never gathered into an invented series; a `by` field absent
  from the whole source is named in the chart's binding error alongside x and y.
  The current neutral token ramp distinguishes two series. Three or more render
  an in-place message pending the categorical-palette call in SUB-952/SUB-932.
  A stacked bar accepts non-negative `sum`/`count` measures; use `kind: line`
  for averages or negative split values. A split's series encoding replaces
  schema hue on a categorical x-axis.
- `kind` — `bar` (default) | `line`.
- `title` — optional; derived when absent (`Release per month`,
  `Sum of value_eur by asset`, `Holdings summaries`); a `by` split appends
  `, split by <field>`.

Semantics: prop lookup is case-insensitive; rows with a missing/unparseable x or
a non-numeric y are skipped (reported as a skip count); date axes sort ascending,
categorical axes keep first-appearance order. A dashboard renders every ` ```chart `
fence in body order; a malformed fence renders its parse error in place — it never
breaks the others, and fixing the text fixes the chart.

Every series of a `by` split shares the chart's x axis: a bar series carries the
whole (zero-filled) axis so stacks line up, and a line series omits keys it has
no rows for rather than drawing a fabricated zero. The chart's own point count
and skip count stay whole-chart figures.

Hover or focus any bar or point for a tooltip with the exact value, the x label,
and — on a split chart — every series at that x. Each chart is a single tab stop
with arrow/Home/End navigation along the axis; tooltips never print.

### 5.6 View embeds — ` ```view ` fences

A ` ```view ` fence renders a live, editable inline database table inside the
note editor (SUB-86, editable since SUB-796) — the hub-page primitive: prose plus a live cut of a database,
no navigation away. Config is hand-editable `key: value` text, one per line;
`#` comments allowed:

````markdown
```view
type: release
query: status:unreleased
view: table
sort: released:desc
limit: 5
columns: status, artist
```

```view
saved: umbra-unreleased
```
````

Keys (`src/lib/embeds.ts`):

- `type` — a database type (exact spelling, as in `type:` frontmatter).
- `query` — optional; the same operator language as the database filter bar
  (`status:live`, comma-OR `status:live,"in review"` (SUB-78), `due < 7d`,
  bare words match titles — `src/lib/query.ts`).
- `view` — accepted, but only `table` renders in v1; any other value falls
  back to table.
- `saved` — one-key alternative: a pinned view's id (or name), resolved
  case-insensitively; the pin's database, query and saved sort order drive the
  table. When present it wins over `type`/`query`; an explicit fence `sort:`
  overrides the saved order.
- `sort` — optional (SUB-942); `sort: <prop>` ascending, `sort: <prop>:desc`
  descending (`asc`/`desc`, either case). The property is matched
  case-insensitively against the database's own columns, plus `title`. The
  ordering IS the database table's: a select column follows its declared
  option order, a number sorts numerically, a date chronologically, and
  missing values sort last in both directions.
- `limit` — optional (SUB-942); a positive whole number of rows, applied
  AFTER the query and AFTER the sort — so `sort: released:desc` + `limit: 5`
  means "the five newest". The table then says "5 of 23 rows — this view's
  limit" rather than implying five is all there is.
- `columns` — optional (SUB-942); a comma-separated pick and order
  (`columns: status, artist`), matched case-insensitively against the
  database's columns and still bounded by the surface's column cap. Wins over
  a `saved:` pin's own curated list.
- Every ` ```view ` fence in the body renders its own table (unlike the
  single-match csv/formulas fences above).

Semantics: a fence with no usable keys, an unknown key, a malformed value, an
unknown database, an unknown column or sort property, or an unknown saved id
renders a quiet inline error card ("Unknown database “x”", "Unknown key
“sortt” — try type, query, saved, …") — never a crash, never a broken sibling
fence, and fixing the text fixes the card. Empty `sort:`, `limit:` and
`columns:` values are malformed; while editing, the caret keeps the raw fence
visible rather than flashing its error card.
Unknown keys were silently ignored before SUB-942; a typo now says so.

The table shows the title column plus the database's first four columns
(`dbColumns`) — or exactly the `columns:` list — and at most 50 rows in the
editor (200 on a workbook page). When rows are cut, the count line names WHICH
cut fired: an author's `limit:` reads "this view's limit", the surface's
safety cap reads "open the database for the rest". `total` is always the full
match count, so the shown/total pair is honest either way. The header
(database name + count) opens the full database; the title cell of a row opens
its note.

Editable (SUB-796). Every non-title cell edits in place with the database
pane's own semantics: a checkbox toggles on click, select/multi/date/relation
open their pickers, and text/number/url get an inline input that commits on
blur or Enter and cancels on Escape. Writes go through the same undoable prop
path the pane uses, so one undo reverts an inline edit either way. A "+ New"
row below the table creates a note of the fence's database — schema defaults,
template applied, plus the fence query's plain `key: value` equality filters
seeded so the new row belongs to the table it was added from (negations,
comparisons and OR-lists seed nothing). Rollup columns stay read-only, and no
board or aggregation footer is rendered. Clicking the embed's padding still
drops the cursor into the fence and reveals the source for editing.

The body stays plain markdown — any other tool sees the raw fence. The table
tracks the vault: it repaints when the note's text changes and when the vault
changes underneath, and a repaint keeps an open cell editor and its
in-progress value alive. Two stated limits: repaint-survival rides
CodeMirror's widget-reuse pass, which is bounded (a handful of block widgets
churning in one update, or an in-progress IME composition, can force a full
rebuild — the open editor closes cleanly and the half-typed value is dropped,
never miswritten); and ⌘Z while the caret is still in the note's text is the
editor's TEXT undo — prop-undo is surface-scoped (`docs/undo.md`), so undoing
an inline cell edit needs focus outside the typing surface, same as a
frontmatter edit.

### 5.6a Workbook pages — `pages:` (SUB-464)

Any dashboard may carry a `pages:` frontmatter list; when present (and
non-empty) the pane renders an Excel-style tab strip at the BOTTOM and
becomes a multi-page workbook. Page 0 is always the note itself, rendered by
its own `dashboard:` kind; its tab label is `pageLabel:` when set, else
"Overview". Each list entry adds one page:

```yaml
---
type: dashboard
dashboard: metrics
cards: [...]
pages:
  - label: Statements
    note: Label Statements     # a sheet or dashboard note, by title/stem
  - label: Releases
    view: release              # a database type…
    query: status:live         # …optionally filtered (§7 query language)
    sort: released:desc        # same optional cut keys as a §5.6 fence
    limit: 5
    columns: status, artist
  - label: Unreleased
    saved: umbra-unreleased    # or a pinned view by id/name
---
```

- An entry names exactly ONE of `note` / `view` / `saved`. `label` is
  optional — it falls back to the target, then `Page N`.
- `note:` resolves by title/stem, case-insensitive (the §5.1 sheet
  resolution). A sheet target renders the editable grid (edits write to the
  SHEET note, debounced, same optimistic-concurrency guard as the editor); a
  dashboard target renders its pane with its own `pages:` ignored — one tab
  strip, never nested. Anything else, a missing note, or a page pointing at
  its own workbook renders an in-place error page.
- `view:`/`saved:` render a read-only database table through the §5.6 embed
  semantics with full-page caps (8 columns / 200 rows). `sort:`, `limit:` and
  `columns:` use the same parser and semantics as a fence; explicit page
  options override a saved pin's display choices. `query:` applies to a
  `view:` page; a `saved:` page always uses the pin's own query.
- A malformed entry becomes an error page in place — the ` ```chart `-fence
  convention: it never breaks sibling pages. Unknown keys inside an entry
  are ignored (forward compat).
- The active tab is ephemeral UI state (like scroll position) — nothing
  about it is written to disk. External writers add/remove/reorder pages by
  editing the frontmatter list.


### 5.7 Recurring calendar entries — `repeat` / `repeat_until` / `repeat_skip`

A dated note repeats when its frontmatter carries a human-readable `repeat:`
prop (SUB-174) — Notion-Calendar-style, no raw RRULE anywhere:

```yaml
type: event
date: 2026-07-18
repeat: weekly              # the series cadence (see grammar below)
repeat_until: 2026-12-31    # optional: last occurrence, inclusive
repeat_skip: [2026-08-01]   # optional: individual occurrences to drop
```

Grammar for `repeat` (case-insensitive, trimmed): `daily` / `weekly` /
`monthly` / `yearly`, or `every N days|weeks|months|years` (N ≥ 1 integer,
singular forms accepted). Anything else → the note is treated as
non-repeating; there is no error and no entry explosion. Monthly/yearly
stepping clamps to the target month's length (Jan 31 → Feb 28 → Mar 31 —
each step is computed from the anchor, so the clamp doesn't drift).

Occurrences are **virtual**: one note on disk, many calendar instances —
nothing is ever materialized to other files. The entry's own date value is
the **anchor** (the first occurrence); every later instance is derived at
read time by `calendarEntries` (`src/lib/calendar.ts`), bounded by the window
the caller is rendering. `repeat` applies to **all** of a note's date props
identically (in practice recurring notes are events with a single `date`).

Semantics of the modifiers:

- `repeat_until` (YYYY-MM-DD, **inclusive**) ends the series: an occurrence on
  the until-day survives, the next one doesn't. An until before the anchor
  (usually a typo) truncates the series to just the anchor — the note itself
  is a real dated note and never disappears from the calendar; only
  `repeat_skip` can hide the anchor day.
- `repeat_skip` (list of YYYY-MM-DD) removes individual occurrences —
  **including the anchor day itself** (that is how "delete this occurrence"
  works on the first instance). A skipped anchor means the series has no
  draggable instance left in the grid.
- Deleting from the chip menu offers this one (skip) / this and following
  (`repeat_until` = day − 1; invoked on the anchor itself that means the whole
  series, so it trashes the note instead) / all (trash the note; recoverable
  from `.trash/`).

All three keys are reserved: they never count as calendar dates themselves,
however date-shaped their values (`repeat_until` is the trap), and they ride
along as ordinary frontmatter for any other tool.

**Recurrence ignores ranges** (SUB-596). If a repeating note's date prop
carries a range, the series expands from the span's **start** day and every
occurrence is a single day — the end is not carried onto them, and the
anchor's own multi-day bar is replaced by that first occurrence. A repeating
multi-day span is a second scheduling concept (overlapping occurrences, spans
longer than their own cadence) and is deliberately out of scope; the value
stays legal on disk and every non-calendar surface still reads it as a range.

### 5.8 Custom kind bundles — `.vault/kinds/<id>/`

> **Contract, not yet live.** This section is the on-disk format and the
> runtime contract the custom-kinds arc lands across several units; the
> loading mechanism, the enable pane and the dispatch branch ship after the
> format does. Until the arc completes, a `dashboard:` value naming a bundle
> is simply an unrecognized key and behaves as §5.2 says. **Once dispatch
> lands, a `dashboard:` value naming a bundle never falls through to
> charts-or-yield**: a kind that can't be resolved — broken manifest, unknown
> id, api out of range, not enabled, bytes changed since — renders a card
> naming the kind and the reason. That fallback is for typos; using it here
> would answer "show me `gear-log`" with a yield tracker. The format is
> documented here first so bundles written against it stay valid.

A **custom kind** is dashboard renderer code that lives in the vault. It
exists so that a dashboard nobody but its owner wants is a file, not a merge
into the app — "make me a board that shows X" becomes something an agent can
finish. The escape hatch, not the default path: a dashboard that can be
expressed with the built-in kinds and their markdown config (§5.2–§5.6)
should be.

```
.vault/kinds/gear-log/
  kind.json      # manifest (required)
  index.js       # entry, plain ES module, no import statements (required)
  style.css      # optional
  README.md      # optional, ignored by the app
```

`.vault/` because that is where config travelling with the data already lives
(§6–§8), and because hidden means kind code never shows up in search, the
sidebar or a view.

**The folder name is the kind id**, and a note reaches the kind by naming it:
`dashboard: gear-log`. Grammar `[a-z0-9][a-z0-9-]{0,39}` — lowercase letters,
digits and dashes, starting with a letter or digit, up to 40 characters. The
id is a path segment, a URL segment and a frontmatter value at once, so the
grammar is the intersection of what is unambiguous in all three.

`kind.json`:

```json
{
  "id": "gear-log",
  "title": "Gear log",
  "api": 1,
  "entry": "index.js",
  "description": "What is plugged into what, by room.",
  "style": "style.css",
  "icon": "zap",
  "author": "avery"
}
```

- `id` (required) must **equal the folder name**. A mismatch is an invalid
  bundle, not a silent preference for one of the two — the id is what a note
  and a served URL both use, and letting them disagree would make one bundle
  mean two things.
- `title` (required, non-empty) and `description` (key required, value may be
  empty) are what a human reads before deciding to trust the code.
- `api` (required, positive integer) is the ctx contract version the kind was
  written against. Above what the app speaks → "needs a newer Substrate"
  (the refuse-newer posture of §5b); below the app's floor → refused. In
  range → it mounts.
- `entry` (required) and `style` (optional) are **bare filenames inside the
  bundle**. Slashes, backslashes, `..`, a leading dot and control characters
  (`0x00`–`0x1F`, `0x7F`) are all rejected — in the app and again before any
  path join. A leading dot would hide the code that runs; a control character
  would let a filename carry the `0x0A` the bundle hash joins names with, so
  two different bundles could share one digest.
- `icon` (optional) resolves through the curated glyph set (§5.2); `author`
  (optional) is shown on the enable card.

Anything unrecognized in `kind.json` is ignored, so a future key doesn't
invalidate a bundle on an older app.

**Built-in kinds always win.** A bundle whose folder name collides with a
kind the app dispatches itself (§5.2, plus the reserved name `charts`) is
invalid, with "rename the folder" — never a shadow. Built-ins write to the
vault (task state, food log, feed read-marks), so shadowing one is a way to
capture those writes, and §5.2's dispatch table is a contract external
writers already rely on.

**A bundle is invalid loudly, never skipped.** Every failure above surfaces
as a card naming the kind and the specific reason. A kind that quietly
vanishes is indistinguishable from one that was never installed.

**Consent lives outside the vault.** Enabling a kind is an explicit
per-vault, per-device decision recorded in the OS app-config directory
(beside `config.json`), keyed by vault path — never in the vault itself.
Git-excluding an in-vault consent file would not help: folder-mirroring sync
tools copy `.vault/` wholesale, so a consent record a synced vault can carry
is not a consent record. The consequence is deliberate: a second device
consents again. That is what per-device means.

The record pins a **SHA-256 hash over the bundle's files** — the manifest,
the entry, and the style file when the manifest names one. Filenames sorted
by their UTF-8 bytes; for each, the filename bytes, `0x0A`, the file bytes,
`0x0A`; the digest is written `sha256:<hex>`. Filenames are inside the hash
so that a rename alone (swapping which file is `index.js`) cannot change what
executes without changing the digest. File bytes are hashed **exactly as they
sit on disk** — no BOM strip, no newline normalization, no re-serialization
of the parsed manifest — so every implementation of this digest agrees byte
for byte. When the bytes on disk stop matching
the enabled hash, the kind stops running and asks again — a synced vault
delivering new code into an already-trusted folder does not get to run it.

Custom kinds run with the **same access as Substrate itself**: they can read
and change anything in the vault. There is no sandbox; the enable decision is
the boundary. Nothing auto-enables from any install path.

#### The kind API — `mount(el, ctx)`

The manifest's `api` names a version of this contract. This build speaks
**api 1** and mounts nothing below it (`KIND_API` / `KIND_API_MIN`,
`src/lib/kinds.ts`); a manifest above it gets "needs a newer Substrate", one
below gets "written for a contract this build has dropped" — neither mounts,
both say so on a card.

The entry file is a **plain ES module with a default export**, no import
statements and no framework:

```js
export default {
  mount(el, ctx) {
    const draw = () => {
      el.innerHTML = `<div class="${ctx.css["dash-metrics"]}">…</div>`;
    };
    draw();
    const off = ctx.onChange(draw);
    return () => off();          // optional cleanup
  },
};
```

`mount(el, ctx)` is called **once per pane mount**, with `el` an empty element
the kind owns outright. Its return value, when it returns one, is a cleanup
function run on unmount — detach listeners and cancel timers there. The kind
does **not** re-mount on every vault change: it subscribes with `ctx.onChange`
and redraws itself.

The **host renders the head**. A kind draws its body only; the title bar, the
source-note button and the state dot are the app's, so every dashboard —
built-in or vault-resident — has one header.

**If `mount` throws, or the module fails to import, the pane renders an error
card naming the kind and the file.** Never a blank pane, and never the
charts-or-yield fallback.

`ctx` members, api 1:

| Member | Shape | What it is |
| --- | --- | --- |
| `ctx.api` | `number` | The contract version actually handed over — what the kind got, not what it asked for. |
| `ctx.el` | `Element` | The same element passed as the first argument, for convenience. |
| `ctx.note` | `{ path, title, props, body }` | The dashboard note the kind is mounted in: its vault path, title, frontmatter props and raw body. |
| `ctx.css` | `Record<string, string>` | Sanctioned class names — `dash-metrics`, `dash-metric`, `dash-label`, `dash-value`, `dash-table`, `dash-card`, `dash-section-label` and friends. Rendering through these is how a kind speaks in the app's voice and follows its theme; a kind may also ship its own `style.css`. |
| `ctx.notes(filter?)` | `⇒ Promise<NoteMeta[]>` | The note index — path, stem, title, folder, props, `updated_ms`, excerpt. The optional filter narrows it. |
| `ctx.read(path)` | `⇒ Promise<…>` | One note's frontmatter and body. |
| `ctx.sheet(title)` | `⇒ Promise<…>` | A sheet fence, parsed and evaluated — headers, typed rows, computed columns — so a kind doesn't reimplement the sheet grammar (§5.6). |
| `ctx.setProp(path, key, value, expected)` | `⇒ Promise<…>` | Write one frontmatter property. |
| `ctx.writeBody(path, body, expectedBody)` | `⇒ Promise<…>` | Replace a note's body. |
| `ctx.create(…)` | `⇒ Promise<NoteMeta>` | Create a note — title, folder, type, props, body. |
| `ctx.onChange(cb)` | `⇒ unsub` | Subscribe to vault changes; call the returned function to unsubscribe. This is the redraw signal. |
| `ctx.openNote(path)` | `⇒ void` | Open a note in the app, the way a row click does. |
| `ctx.toast(msg, action?)` | `⇒ void` | The app's single toast slot; the optional action is a `{ label, run }` button. |
| `ctx.setState(s \| null)` | `⇒ void` | Feed the head's state dot — `{ color, label }` shows it, `null` keeps it quiet. |

**`expected` and `expectedBody` are required on writes.** Both are
compare-and-swap guards: the write is refused with a conflict rather than
applied when the value on disk has changed since the kind read it
(`expected: { value }`, `{ value: null }` = "expected absent"; `expectedBody`
is the body the kind believes is there). The app itself may write
unconditionally in places where it knows it holds the only copy; a kind never
does — an unconditional write from vault-resident code is a clobber of
whatever the user or another surface did in between. Reads and writes ride the
app's own IPC wrappers (`vault_write_body`'s `expected_body` CAS, §13.1;
`vaultSetProp`'s `expected`, `src/lib/ipc.ts`), so a kind inherits the
existing conflict guards and undo semantics for free rather than growing a
second, weaker set.

**ctx grows additively inside an api version**, so kinds **feature-check**
rather than bump:

```js
if (ctx.sheet) { /* use it */ } else { /* parse the fence yourself */ }
```

A member added in a later build appears on `ctx` without changing `api`; a
kind that checks before calling keeps running on both. `api` only moves when
something existing changes shape or leaves.

`ctx` is **ergonomics, not a boundary.** It exists so the common things are
one call instead of twenty lines, not to constrain what a kind can reach — a
kind runs with the app's own access either way, and the enable decision is the
only boundary there is.

External writers: `.vault/kinds/` is app-owned. Write a bundle there only
deliberately, and never touch the consent record — it is not in the vault by
design.

### 5.9 Calc lines — `= expression` (SUB-834)

A body line whose first non-space character is `=` (at most 3 leading spaces —
markdown's own block threshold, so a 4-space-indented `= 1 + 1` stays a code
block) computes, and the answer renders beside it as a dim inline chip. The
answer is **never written to the file**: any other markdown reader sees exactly
the expression the user typed, nothing else. `===` setext underlines and a lone
`=` are not calc lines; lines inside ``` fences never compute (`src/lib/calc.ts`
`isCalcLine` / `fencedLines`).

- **Expressions**: `+ - * /`, parentheses, unary minus. Numbers read in both
  dialects (`1.234,56` and `1234.56` — same coercion as number cells) and take
  a `k`/`M`/`B` shorthand glued to the number (`3.9M`, `12k`).
- **Units**: a number may carry a unit — currency codes and symbols
  (`25 USD`, `$25`, `1.234,56 €`), mass/length/time/data units (`5 kg`,
  `12 km`, `250 ms`, `1.5 GB`), display-only codes (`128 BPM`, `-14 LUFS`).
  The vocabulary is `src/lib/units.ts` (single source of truth, mirrored by
  `schema.rs` for column formats). `+`/`-` require the same dimension — the
  right side converts into the left's unit; a bare number adopts its partner's
  unit (`100 € + 19` → `119 €`). `*`/`/` take unit×scalar, unit÷scalar, and
  same-dimension ratios (unit÷unit → plain number). Currency converts through
  the app-wide cached rates (§12 `net-fx-rates`); never through anything
  stored in the note.
- **Conversion**: a trailing `in <unit>` converts the whole result —
  `= 25 USD in EUR`, `= 5 miles in km`. `in` is reserved for this; the inch
  spells itself `inch`/`inches`.
- **Variables**: `= name: expression` binds `name` for calc lines *below* it
  (top-down, per note; forward references are unknown-name errors). Only calc
  lines bind — a prose line `rent = 1450` never captures. The binding line
  still shows its own value.
- **Line aggregates**: a bare `= sum`, `= avg` or `= count` totals the
  contiguous run of lines directly above that parse as quantities (list
  markers `-`/`*`/`1.` are stripped first). An empty line — or any
  non-quantity line — ends the run. The first (topmost) line of the run sets
  the result's unit; the rest convert into it.
- **Errors are quiet**: a line that can't compute shows a dim `–` with the
  reason on hover — never an error wall inside prose.
- Results format per the `number-format` setting (§12): `de` `1.234,56`
  (default) or `intl` `1,234.56`.

Agent note: calc lines are *read-time* sugar — an external writer never needs
to compute or update anything. Write the expression, the app renders the
answer.

## 5b. `.vault/format.json` — config format versions (covers §6–§8b)

One sidecar records which format version each hidden config file is in
(`src-tauri/src/vaultfmt.rs`). It exists because two app versions can share a
vault — phone⇄Mac sync, a laptop that hasn't updated, a restored backup — and
an older app rewriting a newer file used to silently drop what it didn't
understand.

```json
{ "schema": 1, "views": 1, "folders": 1, "notifications": 1, "calendars": 1, "kinds": 1, "tagfolders": 1, "mounts": 1 }
```

- Keys are `schema`, `views`, `folders`, `notifications`, `calendars`,
  `kinds`, `tagfolders`, `mounts` (§5c, §6, §7, the notification sub-section,
  §8, §5.8, §8b). Current version for all eight: **1**.
- `kinds` versions the **bundle format** of §5.8, not any one file: it says
  which shape of `kind.json` and which bundle layout the vault's
  `.vault/kinds/` folders are written in. **RESERVED** — the key is defined
  by the format unit that documents §5.8, and nothing reads or enforces it
  yet. Refuse-newer for `kinds` (a version above what the app knows means
  this build does not understand the bundles well enough to enable them) and
  the surface that says so land with the loader units of the custom-kinds
  arc, alongside §5.8's own "contract, not yet live" status.
- **A missing sidecar, or a missing/non-positive-integer entry, reads as
  version 1** — the current format, which is what every existing vault is
  already in. Nothing migrates on upgrade; the sidecar just appears on the
  next write of a config file. A corrupt sidecar reads as all-v1 too, so a
  torn write can never lock anyone out of editing.
- **The version is NOT stored inside the config files.** It can't be:
  `schema.json` is parsed as a map of type entries, so a top-level number
  makes shipped builds fail to parse the whole file and read an empty schema;
  `folders.json`, `calendars.json`, and `mounts.json` are JSON arrays with
  nowhere to put a key. The files keep exactly the shape they had. External
  writers should ignore the sidecar unless they're deliberately writing a
  newer format.
- **Refuse-newer**: when a file's recorded version is above what the running
  app knows, the app treats that ONE file as read-only. Reads keep working
  normally; the write path fails with "This vault was written by a newer
  Substrate … update the app to edit \<thing\>" through the caller's usual
  error surface. Every other file in the vault stays editable.
- **Migration**: an older file is upgraded through a chain of pure
  `v_n → v_n+1` transforms before the write lands, and the file as it stood is
  copied to `.vault/backup/<name>.v<N>.json` first (one slot per file per
  source version; rerunning overwrites it). Only v1 exists today, so every
  chain is empty — the rails ship, the migrations don't exist yet.
- Neither `.vault/format.json` nor `.vault/backup/` is watched (§13 rule 2) —
  they're read from disk on access, and a version stamp never triggers a
  config-changed event.

**`.vault/backup/` also holds one non-format artifact** (SUB-1011). The
folders.json → mounts migration (§8) rewrites notes and config, so it needs a
recovery point first. Normally that is a version-history snapshot — but a vault
with history disabled (the user's own git repo, §11) can never have one, and
the migration used to defer on every launch forever. Such a vault instead gets
`.vault/backup/mounts-migration.<unix-ms>/`, written before the rewrite:

```
.vault/backup/mounts-migration.1754300000000/
├── folders.json          # the mappings the migration removes
├── mounts.json           # the registry as it stood (absent on a first run)
├── mounts/               # the per-mount index dir, if any
└── notes/<rel>.md        # every note of every mapped type, at its vault path
```

- It is a **plain file copy**, restorable by hand — no app command reads it
  back. History-enabled vaults get the snapshot and no duplicate backup.
- It is staged under a dot-prefixed sibling and renamed into place last, so a
  directory under the real name is always a complete backup.
- If the backup cannot be written, the migration **defers** exactly as it did
  before and the vault is left untouched — no rewrite without a recovery point.
- Nothing prunes these; a vault that migrated once has one, and it is safe to
  delete after the mounts look right.

## 5c. `.vault/calendars.json` — read-only external calendars

An optional JSON array subscribes the global calendar to external iCalendar
feeds. The app never creates it by default. Each entry has exactly this shape:

```json
[
  {
    "url": "https://example.test/team.ics",
    "name": "Team",
    "tint": "teal",
    "enabled": true
  },
  {
    "url": "/Users/me/Calendars/family.ics",
    "name": "Family",
    "tint": "violet",
    "enabled": false
  }
]
```

- `url` is either an `http://` / `https://` ICS address or an absolute local
  path ending in `.ics`; adding a remote URL is the user's explicit consent
  for Substrate to fetch it. Remote requests and every redirect are restricted
  to publicly routable addresses. A feed is capped at 8 MB.
- `name` is a 1–80 character display label. `tint` is one of `gray`, `blue`,
  `indigo`, `violet`, `pink`, `red`, `orange`, `yellow`, `green`, `teal`.
  `enabled` is optional on disk and defaults to `true`.
- Feed events are read-only. They render beside note-backed dates but never
  become notes, participate in search, or support calendar drag/edit actions.
  Recurrence and time zones are expanded only for the visible calendar window.
- Fetched ICS bodies, timestamps, and errors are machine-local in
  `calendar-feeds-cache.json` under the OS app-config directory, not the vault.
  The UI reads that cache synchronously; network and file refreshes run in the
  background at most once per feed per 30 minutes (plus a manual refresh).
  A failed refresh retains the last good body for offline use. One malformed
  feed or event is reported/skipped without blanking other feeds.
- The list itself is vault data, so it syncs: adding a feed on one device makes
  every synced device fetch it in the background too, under that device's own
  network.
- A malformed `calendars.json` is shown as a config error and is never silently
  overwritten. Unknown entry keys are rejected so misspelled subscription
  settings cannot appear to work.

## 6. `.vault/schema.json` — database schema

Per-type property schemas. Notes keep plain YAML values; this file only drives
pickers, option order, dot colors, and database icons in the UI — deleting it
loses no data. Missing or corrupt JSON reads as empty; the next write recreates
it (pretty-printed, 2-space indent; key order unspecified — it's a hash map).

Exact shape — `{ "<type>": { "icon"?: <DbIcon>, "home"?: <folder path>, "<prop>": <PropSchema> } }`:

```json
{
  "release": {
    "icon": { "glyph": "music", "tint": "violet" },
    "home": "Umbra",
    "status": {
      "options": [
        { "value": "live", "color": "green" },
        { "value": "in review" },
        { "value": "mastering", "color": "yellow" }
      ]
    },
    "released": { "options": [], "kind": "date" },
    "contract": { "options": [], "kind": "file" },
    "contact": { "options": [], "kind": "relation", "type": "contact" },
    "link": { "options": [], "kind": "url" },
    "format": {
      "options": [{ "value": "Vinyl", "color": "violet" }, { "value": "Digital" }],
      "kind": "multi"
    }
  },
  "gear": {
    "icon": { "emoji": "🛠" },
    "category": {
      "options": [{ "value": "mixer" }]
    },
    "in use": { "options": [], "kind": "checkbox" },
    "price": { "options": [], "kind": "number", "format": "euro", "description": "Approximate is fine — current resale value." }
  },
  "contact": {
    "email": { "options": [], "kind": "email" },
    "phone": { "options": [], "kind": "phone" }
  }
}
```

Type-entry fields:

- `icon` — reserved key holding the database's icon (SUB-27), omitted when the
  type has none (the UI then shows the auto-glyph: first letter in a rounded
  square). A user prop literally named `icon` is shadowed by it — the key is
  reserved. A type entry holding only an icon (no props) is valid and keeps the
  icon alive when every prop demotes out.
- `home` — reserved key holding the database's home folder (SUB-85): a
  vault-relative slash path, validated like any folder path on write
  (`vault/schema.rs` `set_schema_home`); blank or absent means no home. When set, the
  database nests into the sidebar Folders tree at that folder — the folder's
  row keeps its on-disk name and gains a DB chip (SUB-611), clicking it opens
  the database view, new entries land there explicitly — and the database
  leaves the flat Databases section. Renaming the folder retargets the `home`
  (subtree included), trashing it clears the key (the database goes homeless
  — but the home is parked in the trash sidecar and comes back on restore
  unless the database found a new home meanwhile, §10).
  A user prop literally named `home` is shadowed — the key is reserved, like
  `icon`.
- `"<prop>"` — any other key is a property name mapping to a PropSchema.

DbIcon fields (all optional, blank strings normalized away on write):

- `glyph` — id of a built-in outline glyph (`GLYPHS` in `src/lib/dbicons.ts`).
  An unknown id is stored as-is and falls back to the auto-glyph.
- `emoji` — an emoji character (the user's Notion habit). One mark only: when
  both arrive, emoji wins and the glyph drops.
- `tint` — a muted palette name from the same `--opt-*` vocabulary as option
  colors; tints the glyph (emoji render in full color — a tint with no mark at
  all drops on write). Unknown names store as-is and render untinted.
- Writes replace the whole icon at once (`vault/schema.rs` `set_schema_icon`); no
  mark at all removes the `icon` key.

PropSchema fields:

- `options` — array of `{ "value": string, "color"?: string }`, always present in
  app-written files (`[]` for date/file/relation/url/email/phone/checkbox/number/rollup
  kinds, which have no options;
  select and `multi` props keep theirs here). `color` is optional and names
  a muted palette dot: `gray blue indigo violet pink red orange yellow green teal`
  (`OPTION_COLORS` in `src/components/SelectMenu.tsx`, tokens `--opt-*` in
  `src/styles.css`). An unknown color string is stored as-is and renders the
  default muted dot (`--text-3` fallback).
- `kind` — omitted entirely for select props (free text with options);
  `"text"` = explicit free text (SUB-43): a schema-registered text column that
  survives the demote rule, so the column shows for every entry even with no
  values; `"date"` = ISO-day value (optionally carrying ` HH:MM`, SUB-270)
  with a calendar picker (`notify` = macOS alert on the day; `notifyBefore` = an ADDITIONAL lead-time alert that many days earlier, SUB-842 — date-kind only, independent of `notify` so either may stand alone, 0/absent = off and anything longer than 365 clamps); `"file"` = path link (§4); `"relation"` = a typed link to
  entries of the database named by the entry's `"type"` key (stored as the
  target's title/stem or a YAML list, rewritten on rename); `"multi"` (SUB-79)
  = a select with several values per note — options/colors exactly like
  select, but the note's value is a YAML string list (`format:\n  - Vinyl\n
  - Digital`), one value per option, each rendering its own dot. A scalar is
  legal for one value (`format: Vinyl`); an emptied list removes the prop,
  same as relation values. The picker toggles membership instead of
  replacing, and `key:value` filters match each list entry per value (§7's
  OR syntax pairs naturally). `"url"` (SUB-172) = an external link: the value
  is the plain URL string (no migration, no wrapper), rendered as a clickable
  link — display text is the stripped title (no scheme, no `www.`, no
  trailing slash; `urlDisplayTitle` in `src/lib/url.ts`), clicking opens the
  system browser, editing shows and edits the raw URL. `"email"` / `"phone"`
  (SUB-181) = contact links: the value is the plain string exactly as typed
  (no stripping — unlike url), rendered as a clickable link that opens
  `mailto:<value>` / `tel:<value>` with the OS handler; for `tel:`, spaces
  and dashes strip from the dialed number only, never from the displayed
  value (`contactHref` in `src/lib/url.ts`). `"checkbox"` (SUB-173) = a
  boolean: checked stores the YAML scalar `true`; **absent/empty means
  unchecked — unchecking removes the prop rather than writing `false`**
  (keeps frontmatter clean; a stored `false` still reads as unchecked).
  Cells and note chips render a small check square that toggles on one
  click — no editor popup — and display surfaces read "✓" / blank.
  `"number"` (SUB-188) = a numeric column: the value stays exactly what's
  stored today (a plain YAML scalar — string or number, no migration), the
  optional `format` field below shapes only the display; table cells
  right-align, editing shows the raw stored string, and a non-numeric
  value renders exactly as typed — never destroyed, never hidden.
  `"rollup"` (SUB-678) = a DERIVED column, wired by the
  `relation`/`prop`/`agg` fields below: follow a relation prop of the SAME
  database, aggregate one prop's values across the rows it links to. The
  value is computed on read and stored nowhere — no frontmatter value ever
  lands (a hand-authored one is overridden on display), the cell is
  read-only, and the column can itself be footer-aggregated, sorted and
  filtered like any numeric column. See "Rollup properties" below.
  A kind
  prop has no
  options, except `multi`, which keeps them.
- `type` — relation-kind only (`target` in the IPC/Rust naming): the target
  database's type string — the same string its notes carry in `type:` — trimmed
  on write. Writing a relation without a target is refused; a `type` arriving
  on any other kind (or a kindless prop) drops on write.
- `format` — number-kind only: the display format, modeled the way relation
  models `type`. `"euro"` renders German-style `1.234,56 €` (dot thousands,
  comma decimals — 2 decimals only when the value has decimals, trailing
  ` €`); `"percent"` (SUB-196) renders through the same de-DE path with a
  ` %` suffix — `8,5 %`, `1.250,25 %` (the stored number IS the percent —
  no ×100 math); `"plain"` is the default and stores
  as absent (the key is omitted). Since SUB-834 the same field also names the
  column's UNIT: any `src/lib/units.ts` code is a valid value (`USD`, `GBP`,
  `kg`, `km`, `ms`, `BPM`, `LUFS`, …), and `euro`/`percent` stay forever as
  the on-disk aliases for `EUR` and `%` — one field, no migration. A cell
  whose stored scalar carries its OWN unit of the same dimension
  (`25 USD` in a EUR column) renders converted into the column's unit, marked
  (hover: original value, rate, as-of date); the stored value is untouched —
  **rows keep their unit**. Footer aggregations convert the same way and
  carry the same marker; a cell whose unit can't convert (unknown code, no
  rate, wrong dimension) renders as typed and is skipped by sums — never a
  silently wrong number. Display-only — the note's stored value
  never changes, and display parsing uses the same coercion as the table
  footer's sums (`parseCellNumber` in `src/lib/aggregate.ts`), so cells and
  calculations never disagree. Unknown formats are refused on write (the unit
  vocabulary is mirrored in `schema.rs`, kept in step with units.ts); a
  `format` arriving on a non-number kind drops.

  Since SUB-834 the same field may equally name a **unit**: any code from the
  unit registry (`src/lib/units.ts`, mirrored as `UNIT_CODES` in
  `src-tauri/src/vault/schema.rs`) — `USD`, `GBP`, `CHF`, `kg`, `g`, `km`,
  `ms`, `BPM`, `LUFS`, `dB`, `%` and the rest. Codes are matched
  case-insensitively and stored in their canonical spelling (`usd` writes as
  `USD`); only codes are accepted, not the registry's word aliases
  ("dollars"). `"euro"` and `"percent"` remain valid forever as the aliases
  for `EUR` and `%` that existing vaults already carry — one field, no
  migration, and a vault written before units reads and writes exactly as
  before.

  **Rows keep their own unit.** A cell in a unit column may store a bare
  number (`1450`) or a quantity (`25 USD`, `$25`, `500 g`). The scalar stays
  byte-identical on disk — nothing is converted on entry and no stored value
  is ever rewritten. A quantity in a *different* unit of the *same* dimension
  renders converted into the column's unit, marked so the shown figure never
  passes for the stored one; currency conversion uses the app's FX rates,
  linear units (mass, length, time, data) need none. A value that cannot
  convert honestly — a foreign dimension, an unknown unit, a currency with no
  rate — renders exactly as typed rather than as a wrong number, and drops
  out of footer aggregations the way non-numeric text always has. The footer
  names both what it folded in and what it left out, so a mixed-unit column
  is never silently summed. Because a quantity is a legal value here, the
  vault doctor (§14) does not flag `25 USD` in a number prop; real junk
  (`ask`, `25 furlongs`) is still flagged.
- `relation` — rollup-kind only (SUB-678): the NAME of the relation prop on
  the same database to follow (not a database name — the relation prop's own
  `type` names the related database). Required on write; it must already
  exist as a relation-kind prop of the same database (matched
  case-insensitively). Renaming that relation prop retargets the reference
  (same-database sweep); a `relation` arriving on any other kind drops.
- `prop` — rollup-kind only (SUB-678): the prop on the RELATED database to
  read. Required on write (any non-empty name — the related database's
  schema is not consulted). Renaming that target prop DOES retarget the
  reference (SUB-740): every rollup that reads it through a relation pointing
  at the renamed prop's database has its `prop` rewritten, case-folded — see
  the rollup sweeps below.
- `agg` — rollup-kind only (SUB-678): the aggregation over the linked rows'
  values — `sum` | `avg` | `min` | `max` | `count`, the table footer's
  Calculate vocabulary (SUB-74, `src/lib/aggregate.ts`). Refused on write
  outside the vocabulary; an `agg` arriving on any other kind drops.
- `description` — any kind, kindless select props included (SUB-191): a
  one-line entry hint shown muted where values are typed (the property picker
  popup on a table cell, the note's chip editor). Notion-parity field —
  Notion property descriptions carry real entry guidance in live vaults.
  Trimmed on write; an empty (or blank) string stores as absent — the key is
  omitted — which is also how a description is cleared. Unlike `type` and
  `format` it is never dropped by kind, and it does not keep an emptied prop
  alive: a description arriving with no kind and no options demotes away
  with the entry like any other field.
- Absent from the file = free text. Writing `options: []` with no `kind` via
  `vault_schema_set` **removes** the entry (demote — the remove-property UI
  path); an emptied type drops out of the file unless it still has an `icon`
  or a `home`.
- App-side normalization on write (`vault/schema.rs` `set_schema_prop`): values trimmed,
  deduped case-insensitively, blank colors dropped; unknown kinds and number
  formats rejected.

### Relation properties — stored values, rename integrity, `related()`

A relation prop is a typed link between databases: with the schema above, a
`release` note's `contact` prop points at entries of the `contact` database.
The schema entry only says WHERE the prop points; the notes hold plain YAML
values — the target's display title (`title:` prop, else stem) as a scalar for
one target, a string list for several, the prop absent for none:

```yaml
contact: Gero        # one target
contact:             # several targets (flow style parses too)
- Gero
- Noa
```

- Values ride the normal prop discipline (§2): a relation is authored as a
  string or a string list via `vault_set_prop`; an emptied list removes the
  prop; non-string lists are refused. Targets match case-insensitively, value trimmed — and only by name:
  two target notes sharing a title are indistinguishable as values.
- **Renaming a target rewrites the values** (`vault/mod.rs` `relation_rewrites`),
  in the same pass as the `[[wikilinks]]` (§2): every prop declared
  `kind: "relation"` in the SOURCE note's type schema that named the old title
  or stem stores the new title, scalars and list entries alike. Same-named
  free-text props, and props on types with no schema entry, are untouched.
- **Moving a target rewrites nothing** — values name titles, not paths, so a
  folder change can't break the link (`related()` keeps resolving).
- **Trashing or deleting a target rewrites nothing either** — the value stays
  as plain text naming a gone note, exactly like a wikilink to a trashed note
  (§3).
- **Demoting or deleting the schema entry** (re-kind it, or demote to free
  text) leaves the values on the notes but ends the machinery: rename rewrites
  and `related()` are schema-driven and stop when the entry is gone.
- `related()` (`vault_related`) is the structured backlink: every other note
  holding this note's title or stem in a relation prop **aimed at this note's
  type** (the schema `type`, compared case-insensitively). One entry per
  (note, prop) — `{ path, title, db_type, prop }`, sorted by title then prop —
  however many list entries hit. An untyped note can't be aimed at, so any
  relation naming it points at it.
- Validation lives on the write path only: a hand-edited relation entry
  without `type` still drives rename rewrites, but `related()` counts it only
  for untyped targets.

### Rollup properties — derived columns, stored nowhere (SUB-678)

A rollup prop answers "what do the linked rows add up to" on every row of a
database — e.g. a Releases row showing what the release earned by rolling
`sum` over the Royalty Ledger rows it relates to. The schema entry carries
only the wiring; the VALUE is computed on read (in the frontend,
`src/lib/rollup.ts`) and never lands in frontmatter:

```json
"release": {
  "entries": { "options": [], "kind": "relation", "type": "ledger" },
  "earned":  { "options": [], "kind": "rollup", "relation": "entries", "prop": "amount", "agg": "sum" }
}
```

- `relation` names the relation prop ON THE SAME database to follow (its
  `type` names the related database); `prop` names the prop to read on each
  linked row; `agg` folds the values (`sum`/`avg`/`min`/`max`/`count` — the
  footer's Calculate vocabulary, §7 `aggregations`).
- Linked rows resolve exactly like relation values do (§6, above): the
  related database matched case-insensitively by `type:`, its rows by title
  or stem, case-insensitive and trimmed. A dangling value (a trashed or
  renamed-away target) links nothing and is skipped.
- Values go through the shared numeric coercion (`parseStrictNumber`), like
  the footer: non-numeric targets are skipped by `sum`/`avg`/`min`/`max`;
  `count` counts linked rows with a non-empty target value. An empty
  relation (or no numeric inputs) renders empty — the footer's
  label-without-value convention; `count` of zero links is `0`.
- The derived cell is read-only (a computed value has no write path),
  renders in the app's de-DE number dialect, and behaves like a numeric
  column everywhere else: it can be footer-aggregated, numerically sorted,
  filtered, and exported. It never groups a board or table (a board drag
  writes the group prop).
- Rollups read STORED values only: a rollup naming another rollup as its
  target prop reads nothing, because derived values never land in props.
- Sweeps: renaming the followed relation retargets `relation` (same
  database); renaming the rollup itself moves its schema entry like any
  prop; renaming the TARGET prop on the related database retargets `prop`
  on every rollup that reads it through a relation pointing at that database
  (SUB-740) — including a rollup on the same database through a
  self-relation. Both directions match case-insensitively, the way the
  evaluator resolves schema keys and `type:` values; a rollup whose relation
  targets a different database keeps its `prop` even when the renamed name
  collides. Deleting the followed relation degrades the rollup to empty —
  never to an error.

### `.vault/notifications.json` — due-notification state

Fired/snoozed state for §6's `notify: true` / `notifyBefore` date props (`src-tauri/src/notify.rs`),
persisted so a due date never refires across restarts. App-owned — external
writers should leave it alone (a missing or corrupt file just reads as empty
state, so deleting it means today's already-fired dues fire again).

```json
{
  "fired":   { "Inbox/Call Gero.md|due|2026-07-17": 1752742800 },
  "snoozed": { "Releases/SMP-031.md|deadline|2026-07-21": 1752861600 }
}
```

- Keys are `<note path>|<prop>|<YYYY-MM-DD>` (the due date — the occurrence
  day for a recurring note); values are unix seconds — for `fired`, when it
  fired; for `snoozed`, quiet-until.
- A **lead-time** alert (SUB-842, `notifyBefore: n`) keys as
  `<note path>|<prop>|<YYYY-MM-DD>|lead` — the date stays the DUE date, not
  the day the alert fires, so the lead and the day-of alert of one occurrence
  carry distinct keys and fire independently. The trailing `lead` marker only
  counts as a marker when it is the final segment AND the segment before it
  parses as a date, so a prop literally named `lead` still keys and parses
  normally. Lead alerts fire at the value's own `HH:MM`, else 09:00, on
  `due − n` days; they snooze exactly like day-of alerts.
- A scheduler in the main process (alive as long as the tray, no window
  needed) scans every 60s and fires a macOS notification when a notify-flagged
  date prop is due: at the time the value carries (`YYYY-MM-DD HH:MM`), else
  09:00 local. A range fires on its **start** — the key and the fire time both
  come from the opening endpoint, so a span notifies once, when it begins. Items are marked fired and persisted **before** delivery, so a
  slow or ignored notification can't double-fire.
- A `repeat:` note (§5.7) notifies per **occurrence**: the scheduler mirrors
  the calendar's expansion arithmetic — never materializing the series — and
  fires when today is an occurrence day, at the anchor's fire time.
  `repeat_until`/`repeat_skip` are honored exactly as on the calendar (the
  anchor itself is never hidden by an until, but can be skipped), and the
  fired key carries the occurrence day, so each occurrence fires exactly once
  and the 14-day pruning below keeps working.
- Dues that pass while the app isn't running do NOT fire late; the one
  late-fire is an explicit snooze expiring. A **missed lead day** likewise
  fires nothing — the day-of alert is the backstop, so a machine that was
  asleep through the heads-up still gets told on the day (SUB-842). Snoozing moves the key from
  `fired` to `snoozed` (later today / tomorrow at the prop's fire time).
- **A snooze that outlives its occurrence day still fires** (SUB-737):
  "tomorrow" on a *weekly* deadline targets a day the series doesn't land
  on, so the scan also walks the `snoozed` map itself for expired entries
  and fires them off-series — an explicit snooze is a user request, not a
  missed fire. It fires on the first scan at or after the snooze expires
  (the snoozed date when the app is running; later if it wasn't), and never
  before the key's own occurrence day has arrived. It fires **once** (the
  key is marked `fired` before delivery like any other), the notification
  still names its occurrence day, and the series is unaffected — the next
  regular occurrence fires on its own key. Re-snoozing a late-fired
  notification behaves like any other snooze. A snooze is **stale** and
  does not fire while the deadline it names no longer exists in that shape:
  note deleted or moved, prop gone, the `notify` flag (or, for a lead key,
  `notifyBefore`) gone, note completed or
  `calendar: false`, or a `due`/`repeat`/`repeat_until`/`repeat_skip` edit
  that means the key's day is no longer an occurrence. (The entry itself
  stays in the map until the 14-day prune — if the vault changes back
  within that window, the snooze fires then.)
- Entries whose due date is >14 days past are pruned on scan, keeping the
  file small. The file is device-local and **excluded from vault history**
  (§11, `.git/info/exclude`) — the scheduler writes it off the engine lock,
  so tracking it let it dirty the tree mid-resolve (SUB-568).
- Unknown top-level keys are preserved across app writes (SUB-433). The
  file's format version lives in `.vault/format.json` (§5b); a version newer
  than the app knows makes the file read-only — the scheduler still honours
  what's on disk, it just stops persisting changes.

### `.vault/jobs-exit.json` — launchd exit-status rings

Recent run outcomes for the jobs dashboard (`src-tauri/src/jobs.rs`, SUB-706):
the machine-local history that turns "the job's last exit was fine" into
"3 of the last 5 runs failed". App-owned — external writers should leave it
alone; a missing or corrupt file reads as empty state and the rings simply
rebuild from observation.

```json
{
  "jobs": {
    "com.example.news-selfheal": { "pid": null, "exit": 1, "ring": [0, 1, 1, 0, 1] }
  }
}
```

- One entry per launchd label: `pid`/`exit` are the previous poll's picture
  (the dedupe key), `ring` the recent exit statuses, oldest first, capped at
  10. A label whose picture is entirely empty (paused, never ran) is never
  persisted.
- Sampling rides the dashboard's 60s `jobs_read` poll — no new launchd
  verbs, and the file is only rewritten when a picture actually changed.
  **Polls are not runs:** the poll sees only the latest run, so a run that
  starts and ends between polls leaves no trace — ring counts are
  approximate, a floor on how often the job ran. A new run is recorded on an
  exit-status flip or a pid turnover/end; the identical picture twice is one
  run.
- Device-local and **excluded from vault history** (§11) like
  `notifications.json` — it is written from the IPC poll outside the engine
  lock. Unknown top-level keys are preserved across app writes (SUB-433).
- Deliberately NOT versioned in `.vault/format.json` (§5b): the state is
  disposable and self-healing, so there is nothing to migrate and nothing a
  newer app could destroy that observation won't rebuild.

## 7. `.vault/views.json` — layout preferences, sidebar order, saved views

Per-database layout choice, same file discipline as schema.json:

```json
{
  "release": { "view": "board", "group_by": "status", "sorts": [{ "key": "released", "dir": -1 }], "hidden": ["notion_id"] },
  "gear": { "view": "table", "table_group_by": "category", "aggregations": { "price": "sum", "manual": "count" } },
  "$sidebar": { "dashboards": ["Dashboards/Portfolio.md"], "databases": ["gear", "release"], "collapsed": ["folders", "dbpins:release"], "folders": ["Projects", "Inbox"], "dashgroups": ["Dashboards/Money"], "pins": ["Inbox/Studio setup.md"], "keys": { "ctrl+1": "today", "mod+2": "dash:Dashboards/Portfolio.md", "mod+3": "db:gear" } },
  "$folders": { "Life": { "icon": { "emoji": "🌱" } }, "Life/Admin": { "icon": { "glyph": "folder", "tint": "teal" } } },
  "$views": [
    {
      "id": "releases-in-review",
      "name": "Releases — in review",
      "db": "release",
      "query": "status:\"in review\"",
      "sort": { "key": "released", "dir": -1 },
      "view": "table"
    }
  ]
}
```

- `view`: one of `list`, `table`, `board`, `gallery` (anything else is rejected
  by the app).
- `group_by`: optional; the prop a board groups its columns by. Omitted when unset.
- `table_group_by` (SUB-184): optional; the prop a table groups its section
  rows by. A separate key from `group_by` — a table never inherits the
  board's grouping and vice versa. Sections follow the schema's option order
  (unschema'd values after, alphabetically), the "No <prop>" section trails,
  empty sections don't render. Omitted when unset. `vault_rename_prop` /
  `vault_clear_prop` (§4) keep this key in sync like `group_by`.
- `aggregations` (SUB-74): optional; the table layout's per-column footer
  calculations — column name → one of `sum`, `avg`, `min`, `max`, `count`
  (`count` = non-empty cells; the rest parse cells as numbers and skip
  non-numeric ones). An absent column key means no calculation. Computed over
  the rows visible in the table (view filter applied). Omitted when empty.
  `vault_rename_prop` / `vault_clear_prop` (§4) keep these keys in sync —
  moved or dropped in place, so a footer never keys on a stale prop.
- `sorts` (SUB-326): optional; the database's remembered sort — the same
  ordered `{ "key", "dir": 1 | -1 }` list a saved view's `sorts` carries
  (validation matches: `dir` other than ±1 is rejected; an empty list stores
  as absent). Header clicks write it, so a sort survives navigating away.
  A saved view's own sort still overrides inside that pin.
- `hidden` (SUB-326): optional; prop names hidden from the database's
  table/list columns (the header right-click checklist / a column caret's
  "Hide property"). Absent or empty = everything shows. Names are stored
  verbatim; entries naming no current column are inert but kept. The inverse
  of a pin's curated `columns` shown-list — a prop added later shows by
  default here, stays hidden in a curated pin. Since SUB-642 this flat list
  is only the SEED a layout without its own `hidden_per_layout` set falls
  back to on read — pre-SUB-642 files carry just it, feeding both layouts
  (backward compatible), and the first per-layout write replaces it.
  `vault_rename_prop` / `vault_clear_prop` (§4) keep `sorts` keys and
  `hidden` entries in sync like `group_by` — renamed in place, dropped with
  the prop (emptied lists leave the file).
- `hidden_per_layout` (SUB-642): optional; `{ "table": [...], "list": [...] }`
  — column visibility curated independently per layout, so hiding a table
  column no longer rewrites every list row's subtitle and curating a list
  no longer strips the table. Each set sanitizes like the flat `hidden`
  (entries trim, empties drop, an emptied set collapses to absent; a sets
  object with nothing left leaves the file). A layout with no set of its own
  reads the flat `hidden` seed; the first per-layout write materializes both
  layouts' sets and drops the flat key, so a written file is always fully in
  the new shape. Board/gallery have no curation UI and never carry a set.
  `vault_rename_prop` / `vault_clear_prop` (§4) sweep these entries like the
  flat list's.
- `widths` (SUB-404): optional; table column widths in px, prop name →
  integer width (the header drag handles). The reserved `title` key sizes
  the Name column — real prop names never collide with it (it's not a
  column key). Zero-width entries are dropped on write; an emptied map
  stores as absent. Clamps (60–800px) are the UI's business — the engine
  stores what it's given.
- `wrap` (SUB-404): optional; prop names whose table cells wrap instead of
  clipping to one line (a column caret's "Wrap text"; `title` names the
  Name column here too). Absent or empty = everything clips. Entries trim
  on write, empties drop.
  `vault_rename_prop` / `vault_clear_prop` (§4) carry `widths` keys and
  `wrap` entries along like `sorts`/`hidden` — renamed in place (an entry
  already at the new name wins), dropped with the prop.
- `grid` (SUB-607): optional; `true`/`false` pins this database's table
  grid lines (vertical column rules) on or off, overriding the global
  `db-grid` setting (§12). Absent = follow the global. The UI clears the key
  when a toggle lands back on the global value, so a database without an
  explicit override keeps following the setting; the engine stores what it's
  given.
- Keyed by database type string (the same string as the notes' `type:` prop).

Keys starting with `$` are reserved — real database names never start with
`$`, so they never collide with prefs in the flat map. Unknown reserved keys
are ignored by readers and **ride along on writes** — including unknown keys
inside a single database's pref, which are preserved when that pref is
rewritten (SUB-433). Current reserved keys:

- `$sidebar` — sidebar section ordering and collapse state: `dashboards`
  (note paths) and `databases` (type names), each a drag-ordered array;
  entries not in the list append after, stale entries are dropped by the UI.
  Since SUB-605 `dashboards` is ONE flat list shared by several surfaces, the
  same shape `folders` and `pins` use below: the Dashboards section's own rows
  are one group, and each content folder whose tree row hosts dashboards is
  another, so only relative order within a group matters. A dashboard note
  living OUTSIDE the dashboards home folder renders under its folder's row in
  the Folders tree instead of in the Dashboards section (never both), so moving
  a dashboard between folders can change which surface owns it — the entry
  follows the path either way (SUB-466).
  `dashgroups` (SUB-698) is the Dashboards section's second lane: a
  drag-ordered array of vault-relative FOLDER paths, one per subfolder GROUP
  HEADER shown in that section (SUB-466). It is separate from `dashboards`
  because a group header orders against its sibling headers, never against
  the dashboard note rows — an array of strings like `folders`, with the same
  append-unlisted / drop-stale handling. Renaming or moving a group folder
  retargets its entry and its whole subtree, and carries the `dashboards`
  rows inside the folder along with it; trashing the folder drops them.
  Omitted (and read as empty) when nothing is ordered — a views.json written
  before this field existed loads unchanged.
  `folders` (SUB-401, generalized by SUB-585) is the same shape for the
  Folders tree: ONE flat list of vault-relative folder paths at any depth —
  each sibling group (the roots, or one folder's children) reads its own
  members out of the list in order, so only relative order within a group
  matters and unlisted folders append alphabetically; a folder rename
  retargets its entries (subtree included), trashing a folder drops them
  (parked in the trash sidecar, restored with the folder — §10). `pins`
  (SUB-410) lists pinned note paths, in row order — any note, database-typed
  or not. A pinned note's row renders under its home folder's row in the
  Folders tree (SUB-585); pins with no tree row (vault root, Journal,
  Dashboards) render in the flat Pinned section. The list is again one flat
  order, each surface reading its own members in sequence. Renaming or moving
  a pinned note retargets its entry (a folder rename
  carries the pins inside along), trashing the note or its folder drops it,
  and a path with no live note simply doesn't render. `keys` (SUB-467) maps a
  user-assigned key token to the sidebar destination it opens — an object,
  written in sorted key order. Both token grammars belong to the frontend: the
  key is `"mod+<digit>"` or `"ctrl+<digit>"` today (`mod` = ⌘ or ⌃), and the
  value is one of `note:<path>`, `dash:<path>`, `folder:<path>`, `db:<type>`,
  `sv:<id>`, `journal`, or a bare view name (`today`, `all`, `trash`, …). The
  engine treats the key token as opaque and keeps only the VALUES truthful:
  renaming or moving a note or folder retargets them (a folder rename carries
  everything inside it along), renaming a database retargets its `db:` entry,
  and trashing a note or folder, deleting a saved view, or deleting a database
  drops the binding — the key token itself never changes, since the user
  assigned that key and keeps it. Omitted when nothing is assigned.
  `collapsed` (SUB-70)
  lists the chevron-collapsed sidebar sections —
  `"dashboards"`, `"pinned"`, `"databases"`, `"folders"` — plus one
  `"dbpins:<type>"` id per database whose saved-view pins are folded. Omitted
  when nothing is collapsed.
- `$folders` — per-folder metadata (SUB-84), keyed by vault-relative folder
  path (slash-joined, as in the sidebar tree). Currently one field: `icon`,
  a database icon in the SUB-27 model (`emoji` or curated `glyph` id,
  optional muted `tint` name — same normalization: emoji wins over glyph,
  tint only with a mark, no mark removes the entry). A folder rename
  retargets its keys, subtree included; trashing a folder drops them (parked
  in the trash sidecar, restored with the folder — §10). An
  emptied `$folders` map drops the key from the file.
- `$views` — saved views (SUB-18): an **ordered array** (pin order in the
  sidebar) of named queries over one database. Fields: `id` (stable slug,
  unique), `name`, `db` (type string), optional `query` (the SUB-7 operator
  syntax, stored verbatim — bare words match the note title; a comma-separated
  value is an OR over one prop (SUB-78), e.g. `status:live,"in review"` —
  quote any segment containing a space or comma; date props also
  take comparisons (SUB-66): `due < 7d` / `released >= 2026-01-01`, with `Nd`/
  `Nw` durations measured from today), optional
  `sort` (`{ "key": <prop or "title">, "dir": 1 | -1 }`), optional `sorts`
  (SUB-199: the full ordered key list of a multi-key sort — sorting is
  lexicographic over it, secondary keys are shift-clicked in the table
  header, the list caps at 3. Written only when 2+ keys are active; `sort`
  always mirrors the first key so older readers keep working, and readers
  treat a view as `sorts ?? (sort ? [sort] : [])`), optional `view` /
  `group_by` / `table_group_by` (layout and grouping overrides; absent falls
  back to the database's own pref), optional `columns` (SUB-212: the ordered
  property keys this view renders in table/list layouts, the title column
  always leading; absent = the database's default column union, keys naming
  no known column are ignored).
  Upserts match by `id` and keep position; validation rejects empty
  id/name/db, unknown layouts, and `dir` values other than ±1 (in `sort` or
  any `sorts` entry).

### Exported link folders — `.substrate-view` (SUB-810)

A saved view can be **exported** as a real folder outside the vault whose
entries are symlinks to the notes the view matches — so Finder, a sample
browser, or any file dialog sees the query's result as an ordinary folder.
The export is explicit: the user picks Export (choosing where, once) or
Regenerate from the pin's menu. Nothing watches, and nothing regenerates in
the background.

- The folder carries a `.substrate-view` marker file at its top level. Its
  first line reads `Managed by Substrate — safe to delete.`, followed by
  plain-language terms and the fields `view`, `view-id`, `vault` and
  `generated`. **The marker is the entire permission to replace the
  folder's contents**: Substrate refuses to export into any non-empty folder
  that lacks it (an empty folder is adopted, since the save dialog just made
  it), and refuses a marked folder whose `view-id` names a different saved
  view — one pin's folder never becomes another's.
- Entries are **symlinks, never copies** — no vault content lives in the
  folder, so deleting it loses nothing. Symlinks rather than Finder aliases
  because the kernel resolves them for every reader; a Finder alias is an
  opaque bookmark blob that only Finder and bookmark-aware Cocoa apps follow,
  and any browser walking the folder with ordinary file APIs would find a
  small binary file where the note should be.
- Regeneration rebuilds the folder from scratch: managed symlinks are removed
  and recreated, the marker is rewritten. A **real file someone put in the
  folder is left untouched** and reported back, never deleted.
- Link names are the source files' own names, made unique deterministically:
  sources sorted by vault-relative path, the first keeping the plain name and
  later collisions taking ` 2`, ` 3`, … before the extension. The same view
  therefore always produces the same folder.
- **Which folder a view exports to is device-local**, recorded in
  `view-exports.json` in the OS app-config dir (beside `config.json`), keyed
  by view id and carrying the vault path — never in the vault, because an
  export path is true for exactly one machine and `.vault/` syncs. Removing
  the pin drops the record; the folder on disk stays.
- Sync/backup pipelines should skip these folders — they are derived, and
  following the links would duplicate vault content. The marker file is the
  reliable thing to exclude on.

### `.vault/templates/<type>.md` — per-type entry templates

One optional markdown file per database type (SUB-17): its frontmatter becomes
create-time prop defaults, its body the starting body with `{{title}}` /
`{{date}}` substituted (`src/lib/templates.ts`; `{{date}}` is the creation day,
except calendar-created entries where it is the picked day, SUB-60). Hidden like
the rest of `.vault/` — never indexed, searched, or watched, so a template never
pollutes its own database. **The one hidden-path exception (SUB-59):** the note
commands (`vault_read` / `vault_write_body` / `vault_set_prop`) accept the
explicit path `.vault/templates/<type>.md` (flat, `.md`) so templates edit
in-app like any note; a write creates the dir and file on first use and
preserves frontmatter exactly as for ordinary notes. Every other hidden path
stays unreachable through those commands.

## 8. `.vault/mounts.json` — mounted folders (reality mounts)

A **mount** shows a real folder on disk as a database: every matching file is
a row, read from a live index. Nothing is imported, nothing is copied, and
**no note is written until a row is annotated** — at which point one sidecar
note is created for that file and nothing else. The folder itself is strictly
read-only: files are stat'd and read for their identity hash, never written,
moved, renamed or deleted.

A mount is split across two places on purpose:

- **`.vault/mounts.json`** — the portable half: identity, name, globs, watch
  flag. Synced, and deliberately **path-free**.
- **This machine's app config** (`appcfg.rs`, outside the vault) — mount id →
  local absolute path. NOT synced, because the same folder lives at a
  different path on every machine, and on some machines it isn't there at all.

Missing or corrupt reads as no mounts, same file discipline as schema.json.
Mounts are added in-app — "Mount a folder…" from the sidebar Folders "+" menu
or the All-databases manager's row menu, which also runs the first scan — or
edited by hand (JSON array):

```json
[
  { "id": "9f1c…-uuid", "name": "Album pool", "globs": ["*.als"], "watch": true }
]
```

- `id` — UUID v4, generated once, never reused. Every sidecar, index file and
  machine binding refers to it, so it is the one field nothing may rewrite.
- `name` — required, unique case-insensitively. **A mount IS a schema type**:
  registering one creates a database of that name (§6), which is what gives
  its sidecars schema'd props, options and views for free. Renaming the
  database renames the mount and vice versa; deleting either drops both.
- `globs` — optional; case-insensitive file-NAME patterns with `*` as the only
  wildcard. Empty/absent = every non-hidden file; subfolders recurse,
  dot-names are skipped.
- `watch` — optional, default `false`. Opts the mount into the live watcher
  (below), and only takes effect on a machine where it is bound.
- Any other key is preserved verbatim across app writes (SUB-433). The file's
  format version lives in `.vault/format.json` under `mounts` (§5b); a version
  newer than the app knows makes the registry AND the per-mount indexes below
  read-only.

### `.vault/mounts/<id>.json` — the last-known index

One app-owned file per mount, rewritten wholesale by every scan. It is what
the board renders from, which is why it is synced: a machine that has never
seen the folder still shows the rows, and every annotation on them.

```json
{
  "scanned": "2026-08-03T11:04:19+02:00",
  "files": [
    { "rel": "2026/kick take 3.als", "size": 481920,
      "modified": "2026-07-31 18:22", "created": "2026-07-31",
      "identity": "b1e0…", "missing": false }
  ]
}
```

- `rel` — path relative to the mount root, `/`-separated, the row's key.
- `size`/`modified`/`created` — the intrinsic columns (`%Y-%m-%d %H:%M` and
  `%Y-%m-%d`, local). Row `name` and `extension` are derived from `rel`.
- `identity` — the file's **content identity** (below); what sidecars bind to.
- `missing` — the index remembers the file and the last scan didn't find it.
  Such a row is kept and greyed, never dropped, and keeps its sidecar.

**Content identity** (`vault/mounts.rs` `file_identity`): hex SHA-256 over the
file's complete byte stream, read through a bounded buffer. It is stable
across renames, moves, and copies to another machine, and two same-sized files
with matching headers and tails still differ when any middle byte differs. A
rescan matches the previous index **by identity first** (so a renamed file
keeps its row and its annotations), then by `rel` (so a file edited in place
keeps its row and gets a fresh identity). Two files with identical content
share an identity, so the match is one-to-one: each row claims its own
previous entry and a duplicated file stays **two rows**, never collapses into
one (`mount_scan_duplicate_content_stays_two_rows`).

### Sidecars — the note a row grows when you annotate it

Setting a prop on a row for the first time creates one **ordinary note** at
`Mounts/<mount name>/<file stem>.md`. It has no special status: it is a note
of the mount's type, editable, syncable, greppable, in history like any other.

```yaml
---
type: Album pool
mount: 9f1c…-uuid
mount_file: 2026/kick take 3.als
mount_identity: b1e0…
created: 2026-07-31
status: promising
---
```

- `mount` / `mount_file` / `mount_identity` are engine-owned bindings, hidden
  from the row's props. Annotating refuses them anywhere, and the schema
  refuses them as prop names on a type that is a mount — so they can't be
  reintroduced through the database side either. Everything else is the
  user's.
- Sidecars are found by their `mount` prop, not by their folder — a note filed
  elsewhere keeps working. A scan refreshes whichever of `mount_file` /
  `mount_identity` drifted, so a rename and an in-place edit can't both break
  the binding.
- A sidecar whose file the index no longer knows still gets a row, marked
  missing. An annotation is never invisible because a drive is unplugged.
- Renaming a mount renames its schema type and moves `Mounts/<name>/` with it.

### Unbound, missing, and unmounting

On a machine where the mount has no binding, or the bound folder is gone, the
board still renders from the last-known index with its rows marked missing,
plus a "Locate folder…" affordance that binds a path and rescans. This is a
normal state, not an error — `vault_doctor` reports it as a **warn** about
this machine (§15), never as a broken vault.

Unmounting drops the registry entry and the index. `cleanup: false` (plain
"Unmount") leaves every sidecar as an ordinary note — dormant, and reattached
by content identity if the folder is ever mounted again. `cleanup: true`
("Unmount and trash its notes…", double-confirmed) trashes the sidecars and
the now-empty database; they are recoverable from `.trash/` (§10), never
hard-deleted. **The mounted folder is untouched either way.**

### Live watcher

`vault/watch.rs` `watch_folders`: recursive FSEvents over every `"watch": true`
mount that is **bound on this machine**, 300ms debounce, rescanning on change
and emitting `vault:changed`. `mounts.json` is itself watched (like
`schema.json` and `views.json`, §13 rule 2), so registry edits and `watch`
flips apply without a restart; the machine's bindings are re-read on every
refresh, so binding a folder starts watching it live. One catch-up scan runs at
app launch when the watch set is non-empty — at least one mount both opted in
**and** bound on this machine; an opted-in mount whose folder lives on another
machine leaves nothing to catch up on here. The opt-in exists so big archive
folders don't churn — opted-out mounts scan on demand only ("Rescan mounted
folders" in the palette). The per-mount index files under `.vault/mounts/` are
NOT watched: the app writes them itself.

### Migration from `.vault/folders.json`

Mounts replace the old folder-backed databases, which materialized one stub
note per file. On engine load, every mapping left in `.vault/folders.json` is
migrated (`migrate_folder_mappings`), behind a `before mounts migration`
history snapshot: a mount is created carrying the mapping's type name, globs
and watch flag; its folder is bound on this machine; the existing stub notes
of that type are **adopted as sidecars** (their `file`/`modified`/`size`/
`missing` props dropped, since the index carries them now — user props and
bodies untouched) and moved into `Mounts/<name>/`; the folder is scanned; and
only then is the mapping removed. Removing the mapping last makes the whole
thing idempotent and crash-safe: a retry re-adopts into the same mount by name
and skips notes already adopted. Afterwards there is one folder concept, not
two; `folders.json` remains a legal file only so an interrupted migration has
something to resume from.

## 8b. `.vault/tagfolders.json` — tag folders

A JSON array of saved tag queries. Each one shows in the sidebar next to real
folders with a tag icon, and opens the notes matching its rule. **No note
moves on disk for a tag folder** — the folder is a query, not a location. The
app never creates the file by default; folders are built in-app (Folders "+"
→ "New tag folder…") or edited by hand. Same file discipline as the rest of
§6–§8: missing or corrupt reads as no folders.

```json
[
  {
    "id": "tf-7k2m9x4a",
    "name": "Live set",
    "tags": ["demo", "live"],
    "match": "any",
    "exclude": ["archived"],
    "icon": { "glyph": "tag" }
  }
]
```

- `id` — stable, opaque, unique within the file. It's what the app's view
  state and sidebar order reference; renaming a folder never changes it.
- `name` — the sidebar label (required, non-empty).
- `tags` — the positive tags, without `#`, matched case-insensitively. **An
  empty list matches nothing**, so a half-built folder can never sweep the
  whole vault into view.
- `match` — `"any"` (default) or `"all"`. `any`: the note carries at least one
  of `tags`. `all`: it carries every one.
- `exclude` — the NOT rules. A note carrying any excluded tag is out, however
  well it matched. Optional; default empty.
- `icon` — optional sidebar glyph override, same shape as a database icon
  (§6). Absent = the tag glyph.
- Any other key is preserved verbatim across app writes (SUB-433), and the
  file's format version lives in `.vault/format.json` (§5b) — a version newer
  than the app knows makes this one file read-only.

**Acting on a tag folder tags the note.** Creating a note inside one, or
dragging a note onto it, writes the folder's `tags` to that note's `tags:`
prop (§3b) and nothing else: the file stays exactly where it is, and a
created note is born where loose notes are born. `exclude` is **never**
applied — a NOT rule is a filter, not something the app stamps on a note — so
a folder that says "tagged `demo`, but not `archived`" applies only `demo`. An
ANY folder still applies all of its positive tags: the author picked them as
the folder's meaning.

## 9. `.assets/` — embedded binaries

Flat store for pasted/imported files. Dot-prefixed → never indexed, never watched,
never in history.

- Names: the source **filename only** (path components stripped), stem sanitized
  like a note title, extension lowercased alphanumeric (else a default: `png` for
  pastes, `bin` for imports). Collisions dedupe: `bounce.wav`, `bounce 2.wav`…
- Referenced solely by `![[name]]` from note bodies, matched case-insensitively —
  the same way the filesystem resolves them.
- Orphan GC: an asset no note body references anymore is collectable from the
  Assets pane. **Trashed notes don't count as references** — trashing the last
  embedding note orphans the asset. Deleting an asset moves it to the trash
  (§10) — recoverable until the trash is emptied — but assets are **never
  history-tracked**: binary blobs are deliberately excluded from git (§11), so
  the trash copy is the only recovery path.
- Export bundle copies the note plus every `.assets/` file it embeds into
  `<dest>/.assets/`, so the `![[...]]` targets still resolve.
- Non-media assets (PDF, docx, html, …) render as file chips in the editor
  (§3): click opens them in the OS-default app. Export and print treat them
  like every other asset — print emits `embedded file · <name>`.

## 10. `.trash/` — recoverable deletion

Delete = move into the trash, never unlink:

```
.trash/1752768000000/Inbox/Capture anything.md
       └ deleted_ms  └ original vault-relative path, verbatim
.trash/1752768000100/Projects/            ← a trashed folder: the whole subtree
.trash/1752768000100/Projects.folder      ← marker naming it as one entry
.trash/1752768000100/Projects.folder.json ← its parked view-config (SUB-480)
.trash/1752768000000/Inbox/Capture anything.md.note.json
                                          ← a trashed note's parked sidebar
                                            config (SUB-666)
.trash/1752768000200/.assets/bounce.wav   ← a trashed asset (§9), name only
.trash/1752768000300/.templates/release.md ← a deleted database's template (§8)
```

- The `<deleted_ms>` folder is the deletion timestamp (unix millis); collisions
  bump it by 1ms. A trash entry's **id** is `<deleted_ms>/<original path>`.
- **Folders trash recursively**: the whole directory moves, empty subfolders
  included. A sibling `<id>.folder` marker file marks the tree as ONE trash
  entry — its notes list/restore/delete-forever with the folder, not
  individually. The marker lives next to the tree (never inside it), so restore
  stays a clean rename and nothing marker-shaped lands back in the vault.
- **A trashed folder parks its view-config** (SUB-480) in a sibling
  `<id>.folder.json` sidecar, next to the marker for the same reason. Deleting
  a folder clears config that lives outside it — its `$folders` icon (subtree
  included), any schema `home` pointing into it, its `$sidebar.folders` row,
  the `$sidebar.pins` of notes inside, and every `$sidebar.keys` binding
  targeting the folder or its subtree (SUB-499) — and the sidecar is what
  restore reads to put all of it back. Shape:

  ```json
  {
    "folder_meta":     { "Projects": { "icon": { "glyph": "folder" } } },
    "schema_homes":    { "task": "Projects" },
    "sidebar_folders": [{ "path": "Projects", "index": 1 }],
    "sidebar_pins":    [{ "path": "Projects/One.md", "index": 0 }],
    "sidebar_keys":    { "3": "folder:Projects", "4": "note:Projects/One.md" }
  }
  ```

  Paths are stored as they were at delete time; restore remaps them onto
  wherever the folder lands (a dedupe rename means `Projects` → `Projects 2`)
  and reinserts sidebar rows at their parked `index`, clamped to the list's
  current length. **Restore into a changed world yields**: a database that
  found a new home meanwhile keeps it, a home folder another database now
  claims is not taken, an icon set on the restore path in the meantime is
  left alone, and a key token reassigned meanwhile keeps its newer target —
  parked config only ever fills a gap, never overwrites. A
  missing or corrupt sidecar reads as "nothing parked": the tree still
  restores. The sidecar is written best-effort at delete, is never listed as
  its own trash entry, and is purged on restore, on delete-forever, and with
  an orphan marker.
- **A trashed note parks its sidebar config** (SUB-666) the same way, in a
  sibling `<id>.note.json` sidecar. Deleting a note clears its `$sidebar.pins`
  row (SUB-410) and every `$sidebar.keys` binding pointing at it — `note:` and
  `dash:` alike (SUB-467) — so the sidecar is what restore reads to put both
  back. Only the pin's index and the key tokens are stored; the note's path is
  implicit, since restore knows where the note landed. Shape:

  ```json
  { "pin_index": 0, "sidebar_keys": { "3": "note", "4": "dash" } }
  ```

  Restore remaps onto wherever the note landed (a dedupe rename means
  `Scratch.md` → `Scratch 2.md`), reinserts the pin at its parked index clamped
  to the list's current length, and **yields to a changed world** exactly as the
  folder sidecar does: a key token reassigned meanwhile keeps its newer target,
  and an already-pinned path is left alone. A missing or corrupt sidecar reads
  as "nothing parked": the note still restores. Written best-effort at delete,
  never listed as its own trash entry, purged on restore and on
  delete-forever. A bulk delete parks one sidecar per note, under that note's
  own id.
- Restore puts the note/folder back at its original path; if something new sits
  there, the restored item gets a numbered name (`Vessel Songs 2.md`,
  `Projects 2`) — restore never overwrites. Emptied timestamp folders are
  pruned; orphan markers (tree gone, marker left) are dropped on list.
- Permanent delete (single or empty-trash) unlinks the trash copy only. The
  note's pre-trash snapshots stay in history under its original path (§11).
- **Assets trash into a `.assets/` mirror** inside the deletion folder, holding
  the bare filename (an asset has no vault path beyond `.assets/`). The mirror
  is dot-prefixed exactly like the live store, so the note walk skips it and a
  trashed asset can never be mistaken for a trashed note. Restore renames it
  back into `.assets/`, re-running the §9 collision dedupe when the name was
  reoccupied. Since assets carry no history, restoring or permanently deleting
  one has no history side effect, and empty-trash purges them with everything
  else.
- **Templates trash into a `.templates/` mirror** the same way (SUB-781):
  deleting a database moves its `.vault/templates/<stem>.md` into
  `.trash/<deleted_ms>/.templates/<stem>.md` instead of unlinking it. The
  dot-prefix keeps it out of the note walk, so it lists as its own trash kind
  (`template`), never as a note. Restore renames it back into
  `.vault/templates/`; if the type was recreated with a fresh template
  meanwhile, the restored file takes a numbered stem (`release 2`) — never
  overwrites — and serves the type of that landed stem. Templates are
  history-tracked under `.vault/` (§11) but have no per-note purge, so the
  trash row offers restore and delete-forever only.
- Only `.md` files, marked folders, `.assets/` and `.templates/` mirror files
  are listed in the trash UI.

## 11. `.git/` — version history

The vault is a quiet local git repo (branch `main`, author `Substrate
<substrate@local>`), created and managed by the app. Global/system git config,
hooks, and signing are disabled for its commands.

**Ownership.** Repos the app creates are stamped with `.git/substrate-owned`
(content `1\n`). If the vault is ALREADY a git repo without that stamp, the
repo is the user's own: history runs disabled — `History::new` still succeeds
(the app boots fine) but writes nothing under `.git` (no config, no
`info/exclude`, no sentinel), every mutating op is a no-op (snapshots simply
report "nothing committed"), reads refuse, and purge/trim never run. The
History panel shows a quiet "vault has its own git history" state. Migration:
vaults Substrate initialized before the stamp existed carry no sentinel — on
first boot they're adopted (stamped) when every commit on every ref is
authored by `Substrate <substrate@local>`, or when nothing was committed yet;
any other authorship leaves the repo foreign forever. A `.git` FILE (worktree
pointer) is always foreign.

- **Snapshots** land as commits: one baseline at app launch, then after activity
  (the vault quiet for 120s, or a 600s continuous editing stretch, checked every
  15s), and a final one at quit. A clean tree never commits. Labels: `snapshot`,
  `snapshot (quit)`, `restore <path>`, `snapshot (history trimmed)`.
- **Excluded** (via `.git/info/exclude`, written at init —
  `src-tauri/src/history.rs` `EXCLUDE_CONTENT`): `.assets/`, `.trash/`,
  `.DS_Store`, and the device-local state files written off the engine lock —
  `.vault/notifications.json` (SUB-568) and `.vault/jobs-exit.json` (SUB-706).
  Everything else is tracked — notes, `.vault/schema.json`, `.vault/views.json`,
  `.vault/mounts.json` + `.vault/mounts/`, `.vault/folders.json`,
  `.vault/templates/`, `Settings.md`.
- **Why `.assets/` is excluded — text syncs, binaries don't.** The vault's
  binaries are studio files: masters, stems, bounces, artwork. Git stores every
  version of every one of them forever, and the same exclude list governs the
  phone sync transport (§11 remotes), so tracking `.assets/` would mean pushing
  multi-GB history over the wire to a device that has neither the disk nor the
  need. Snapshots stay cheap and text-shaped — which is what makes purge, trim,
  and diff tractable at all. `.trash/` is excluded for the mirror reason: it is
  already a recovery mechanism (§10), and history-of-the-trash is history twice.
  **Consequence, by design:** a vault pulled onto a second device has all its
  notes and none of its assets, so every `![[embed]]` resolves to nothing there.
  That is expected, not damage — the app renders those embeds as *"not on this
  device"* rather than as broken links (SUB-444,
  `src/lib/embedstate.ts`). Getting binaries onto another
  device is a separate job for a file-sync leg (§15), not for git.
- **Restore** writes the old content over the file and snapshots immediately — a
  new commit on top, never a rewrite.
- **Purge** (per note) rewrites history to drop that file under every name it ever
  had, then `gc --prune=now` — physically gone from disk. **Trim** drops all
  snapshots older than a cutoff. Either rewrite first deletes every ref sync owns
  in the same repository (`refs/substrate/sync-merge`, `…/sync-resolutions`,
  `…/sync-staging`, and all `refs/remotes/substrate/*`): left in place they would
  pin the whole pre-rewrite graph and the prune would keep the purged objects
  alive on disk. The next push simply runs with no baseline, as a first push.
- **Background maintenance is pinned off.** Every time the app opens an owned
  vault it sets `maintenance.auto=false` and `gc.auto=0` in the vault's LOCAL
  `.git/config` (idempotent; `src-tauri/src/history.rs` `History::new`,
  SUB-603). Reason: `git commit` spawns a **detached** `git maintenance run
  --auto` whose `repack -d -l --cruft` grandchild deletes every loose object
  and its fanout directory *asynchronously — after the commit already
  returned*. Two things break when it lands. (1) It races the libgit2 writes
  on the sync path (observed: a lockfile rename into `objects/46/` failing
  ENOENT). (2) The mobile history rewrite requires loose objects, so a packed
  vault flips `require_loose_objects` and purge/trim start refusing on a vault
  the user never touched. **A Substrate vault is never packed** — that is the
  product contract, not a tuning preference. External writers must not
  re-enable either key.
- **Sync extras**: a vault configured for phone sync may carry
  `.git/substrate-sync-cert.der` — the pinned server certificate for the
  `substrate` remote (public material; the token never lives in the repo) —
  and `.git/substrate-sync-rewritten` — a marker any history purge/trim
  writes (both engines' `finish_rewrite`, SUB-713) and the next successful
  push deletes. While it stands, a rejected push is reported as "the remote
  still holds the old history" with the manual recovery steps
  (`scripts/vault-sync-server/README.md`, "After a client-side history
  rewrite") instead of raw git wording.
- External writers: **never touch `.git/`** — no commits, no config, no excludes.
  Your file writes are picked up and snapshotted by the app itself.

### Sync conflicts and how they resolve

A pull merges the remote into local history three ways. When the same file
changed on both sides in ways git can't merge, the pull **refuses**: the
worktree is left exactly as it was (no conflict markers are ever written to a
note) and the report lists the conflicted paths.

The pending merge is parked in git, not in memory, so a half-resolved merge
survives quitting the app:

- `refs/substrate/sync-merge` — the remote commit the refused pull tried to
  merge. Its presence is what "a conflicted pull is waiting" means. It is
  cleared by any clean pull, and self-heals if the commit disappears or HEAD
  already contains it. If a background snapshot happens to converge the two
  sides mid-resolution, the parked merge is dropped only while *no* choice has
  been recorded yet — reading the conflict state never destroys choices the
  user already made.
- `refs/substrate/sync-resolutions` — a blob of `{ "<path>": "mine" | "theirs"
  | "both" }`, the choices made so far. The three versions themselves are never
  copied anywhere: they are read back out of the merge base, HEAD, and the
  parked remote commit on every read. When a later pull re-parks the merge, a
  choice is kept only if that path is still conflicted with byte-identical
  content on both sides; anything the new remote commit actually changed goes
  back to undecided, so a choice never applies to content the user never saw.

Per conflicted file the user picks one of three outcomes. **Nothing is ever
lost** — every outcome keeps both contents reachable:

- **Keep mine** — the worktree keeps this device's version; the remote version
  stays reachable as the merge commit's second parent.
- **Take theirs** — the worktree takes the remote version; this device's stays
  reachable as the merge commit's first parent (the pre-merge HEAD).
- **Keep both** — this device's version stays at its path and the remote
  version is written beside it as `<name> (conflict <YYYY-MM-DD>).md`, both
  tracked. The date comes from the remote commit's timestamp, so the name is
  deterministic. If that name is already taken — a second conflict on the same
  file the same day — a counter is appended until it is free: `<name> (conflict
  <YYYY-MM-DD> 2).md`, ` 3`, and so on, so an earlier copy is never replaced.
  Unavailable when one side deleted the file — there is no
  second copy to keep, and both sides remain reachable through the parents
  anyway.

Once every conflicted file has a choice, finishing writes one merge commit with
both parents, message `vault sync merge (conflicts resolved: N kept mine, N
took theirs, N kept both)` — only the outcomes actually used are listed.
Finishing early is refused and names the undecided paths.

**Frontmatter is not merged semantically.** Conflicting frontmatter keys are
*reported* — key, base, mine, theirs — so the choice is informed, but the
chosen side's file is taken whole. A per-key merge (take `status` from one
side, `tags` from the other) is a deliberate follow-up; the reporting pass
(`gitsync.rs` `prop_conflicts`) is the seam it would grow from.

## 12. App-level conventions

Plain notes the app treats specially — all optional, all just files:

- `Settings.md` (vault root) — app settings as frontmatter: `capture-hotkey`
  (default `alt+space`), `close-to-tray` (default `false`), and the ⌘⇧T terminal
  HUD's `terminal-command` (agent CLI typed into the fresh shell; empty = plain
  shell), `terminal-cwd` (start folder, `~` expands; empty = the vault folder),
  `terminal-dock` (SUB-864, `bottom` or `right`, default `bottom`; anything else
  reads as `bottom`), `terminal-height` (window fraction `0.2`–`0.9`, default
  `0.45`, used when docked bottom) and `terminal-width` (window fraction
  `0.2`–`0.7`, default `0.38`, used when docked right) — both sizes are also
  written by dragging the panel's inner edge (SUB-863), and each side keeps the
  size last chosen for it, so flipping the dock restores it; an out-of-range
  value typed into the note falls back to the default rather than clamping,
  `terminal-font` (SUB-862, font family for the HUD terminal — one name or a
  comma-separated chain; names are normalized (quotes optional, spaced names
  quoted for you) and restricted to letters/digits/space/`_``.``-`, anything
  else is dropped; the app's mono stack is always appended, so a typo'd or
  rejected value degrades to mono; empty = that mono stack alone; a nerd font
  goes here to get powerline glyphs),
  `terminal-actions` (a list of `Label: command` quick actions offered in the
  command palette, each typed into the HUD's shell; a fresh vault is seeded
  with one entry for the `/setup` skill below), and
  `drop-hint` (default `true`; `false` hides the drag-over copy-vs-⇧-link
  hint), `db-grid` (SUB-607, default `true`; `false` turns off the
  vertical grid lines in database tables globally — a database's own
  views.json `grid` override, §7, wins either way), `window-opacity`
  (SUB-951, macOS desktop only, default `90`; how solid the window is over the
  desktop in percent, `80`–`100` — the wallpaper shows through, blurred by
  macOS's own material rather than by a CSS filter over the notes, and `100`
  removes the material for exactly the old fully-solid window. Only the window
  ground and the note column take the alpha; panels, popovers and menus stay
  opaque so the depth hierarchy survives. An out-of-range or unparseable value
  falls back to `90` rather than clamping, and on every other platform the key
  is inert and the ⌘, sheet hides the slider), `show-agent-files`
  (SUB-831, default `false`; only an explicit `true` lists the root
  `AGENTS.md`/`CLAUDE.md` — and, since SUB-878, `Settings.md` itself — in the
  app's note surfaces; the key keeps its original name for existing vaults,
  the ⌘, sheet labels it "Show app files" — see the concealment entry below),
  and the SUB-833 "Send as link" pair: `share-relay-url` (http(s) URL of the
  handoff relay the encrypted copy uploads to; fresh settings notes seed
  `https://drop.substrate.zone`, and an existing note with no key uses that
  runtime default without being rewritten. `disabled` (what the Settings form
  writes when cleared) or an explicit empty value disables hosted sharing;
  legacy `off` remains accepted on read for existing settings notes;
  the hosted default and the self-hostable relay speak the same protocol — see
  `scripts/handoff-relay/README.md`) and
  `share-relay-token` (optional bearer token, only for relays that gate
  uploads), and the SUB-955 appearance dials: `glow` (0–100, default `0`,
  the bloom around dashboard chart strokes, dots and emphasised values —
  bars join above 70; `0` is the shipped look and switches the effect off
  entirely rather than drawing a zero-width one), `accent-tone` (`sky` —
  the default and the shipped SUB-932 family — `teal`, `indigo` or
  `violet`; picks the hue the dashboard accent family and the categorical
  series ramp wear, on screen and in print, while the state colours
  red/amber/green stay put) and `accent-tone-nudge` (−12..12 degrees of
  hue offset around the chosen tone; out-of-range values clamp, and the
  bound is what keeps every ramp colour clear of 3:1 on both grounds).
  All three degrade to their default on any value the reader can't make
  sense of. Alongside them:
  `number-format` (SUB-834, `de` — the default — writes `1.234,56`,
  `intl` writes `1,234.56`; an unset or unrecognized value reads as `de`), and
  the SUB-834 outbound-request switches, one per request the app can make, all
  default `true` and all turned off only by an explicit `false`:
  `net-link-titles` (a captured link asks that site for its page title — off
  still captures the note, it just keeps the bare URL as the title),
  `net-fx-rates` (currency conversions read rates from frankfurter.dev — off
  is to use the last saved rates and show their date; gated in `useFxRates`,
  the single fetch seam) and `net-share-relay`
  ("Send as link" uploads the encrypted copy to the relay above — off makes
  the action explain the switch instead of sending). Enforced at the app's
  request-initiating call sites, not in the engine — see
  `docs/security-config.md`. Hot-reloaded
  within a second of saving; the ⌘, sheet is a typed form over the same keys.
  Unlike the other notes here it is not merely seeded on first run: the desktop
  app writes it on launch whenever it is absent (SUB-473), so vaults predating
  the setting get one, and deleting it brings back the defaults. No write
  happens if `.vault/format.json` says a
  newer app owns the vault (§5b). Desktop-only, and skipped on a vault that has
  a sync remote — both for the same reasons as the `AGENTS.md` backfill below.
  An existing note is split in two (SUB-973): **the frontmatter is never
  touched** — those are the user's values, and a key they removed simply means
  "default" — while the **body**, which is the app's own per-key documentation
  and rots as settings are added, is refreshed under the known-revisions rule
  below whenever it still byte-matches a body the app shipped. The body is
  hashed on its own; a note with no frontmatter at all is treated as the
  user's entirely.
- `AGENTS.md` (vault root) + `CLAUDE.md` + `.claude/skills/setup/SKILL.md` —
  the orientation the agent CLI in the ⌘⇧T terminal HUD reads about the vault
  it is running inside (SUB-474): `AGENTS.md` is this format in one page,
  `CLAUDE.md` is a one-paragraph pointer at it for agents that auto-load only
  that filename (SUB-802), and `/setup` is a
  skill that interviews the user and writes further skills fitted to their
  actual schema. Deliberately no other prebuilt skills — one that doesn't know
  the user's real types and folders proposes against an imagined schema.
  Both are written when **absent**, on every launch, not only on first run
  (`vault/seed.rs` `seed_agent_files`), so deleting one brings the shipped version
  back. **Known revisions (SUB-973)**: `seed.rs` also embeds the full text of
  every revision of each of these files the app has ever shipped (`SEED_FILES`,
  with the historical ones frozen under `src/seed/revisions/`). On launch, a
  file whose text still matches *any* shipped revision is one nobody has
  touched, so it is replaced with the current text — otherwise every existing
  vault would keep its original `AGENTS.md` forever while the agent door it
  documents moves on. A file matching no shipped revision is the user's and is
  never overwritten, whatever is in it. Matching is by **bytes** of the
  canonical form (`normalize`): trailing newlines dropped, and the app's bundle
  identifier folded to its `com.example.substrate` placeholder, which is the
  form the frozen revisions are stored in — a vault seeded before that fold
  still holds the literal identifier and must keep reading as untouched. An
  FNV-1a fingerprint over the same canonical form narrows the candidates first,
  but a hash match alone never authorizes an overwrite, so a user edit that
  happened to collide with a shipped fingerprint is still left alone. Only a
  **regular file** is considered: a symlink at a seeded path — live or dangling
  — is the user's arrangement and is neither replaced nor written through. A
  refresh writes through `write_atomic` like any other vault write, so the
  watcher re-indexes it as an ordinary external edit and concealment (below) is
  unchanged. Changing a seed's text means freezing the outgoing text as a new
  `revisions/` file and appending it in the same commit — a unit test
  (`seed_revisions_stay_in_lockstep_with_the_seed_text`) fails until it is
  there, since a missing entry would freeze every existing copy. They carry no
  format version of their own, so the boot-time write is guarded at vault level
  by `vaultfmt::vault_written_by_newer_app` (§5b) — a vault a newer Substrate
  has written gets no backfill. It is also **skipped whenever the vault has a
  sync remote configured** (`gitsync::sync_configured`): two desktops sharing
  one vault would each invent the file locally on their next launch and
  snapshot it, so the pull would see the same path added on both sides from
  different blobs — an add/add conflict, which parks *all* syncing until
  someone resolves it by hand. A syncing vault gets these files the way it gets
  every other note: from whichever device seeded them, over sync. Only the
  standalone vault, where nobody else can be writing, is backfilled at boot.
  The backfill is **desktop-only**: the phone's
  vault container is pre-created before the engine starts, so a local write
  there would turn the first sync pull into an unrelated-histories merge. On
  mobile these files arrive with everything else through git sync (§11), which
  excludes only `.assets/`, `.trash/`, and `.DS_Store` — so a skill written on
  one device shows up on the others. `.claude/` is hidden (§1) and therefore
  never a note; `AGENTS.md` is an ordinary, frontmatter-less note in the index.
  **In-app concealment (SUB-831; SUB-878 added `Settings.md`)**: the engine
  indexes all three root files
  normally — external tools, Finder and sync see nothing special — but the
  app's own note surfaces (lists, palette, search, sidebar counts, wikilink
  completion) filter them out unless `Settings.md` says
  `show-agent-files: true` (the ⌘, sheet's "Show app files" switch), so a
  fresh vault reads
  as the user's blank slate. Wikilinks to them still resolve and open, and
  the ⌘, sheet's "edit raw" opens `Settings.md` with the switch off —
  concealment is presentation, not access control. Frontend-only by design:
  the filter is one memo boundary in `App.tsx` over the exact root paths
  (`src/lib/settings.ts` `APP_FILES`).
- `Inbox/` — default folder for new/captured notes; auto-created on launch.
- `Journal/YYYY-MM-DD.md` — daily notes (⌘D). Title is the ISO date string;
  recognized by path, so any note in `Journal/` with a real date name is a daily.
- `Sketchpad.md` — standing scratch note at the root, resolve-or-create like a
  wikilink target.
- `Calendar/` + `type: event` — standalone calendar entries file themselves here
  with a date prop (default `date: YYYY-MM-DD`). Databases keep their own folders;
  the calendar discovers their date props per §4. Per-note opt-out: `calendar:
  false` hides a note from the calendar (the note's ⋯ menu writes/removes it,
  SUB-175).
- `type: reference` — a link captured from the clipboard: filed in `Inbox/` with
  `url:` prop; the title starts as the bare URL (scheme/`www.` stripped) until a
  fetched page title renames it.
- `type: ableton-project` — the Ableton album pool (SUB-37): one row per project
  folder, written by the external `scripts/import-ableton.ts` (run by hand;
  `npm run import:ableton -- <pool>`). The source tree is strictly **read-only**
  — the script and the app only ever `stat` `.als` files, never parse, write,
  move, or delete them. Rows are ordinary
  notes it owns outright — unrelated to the mounts of §8, which index a folder
  without writing a note per file; mounting the same pool would render its own
  rows beside these rather than rewrite them. The
  script owns `file` (the `.als` as a `~/…` link), `modified`/`size` stamps,
  `last_touched` (ISO day, `kind: date`; from an als_introspect sidecar when
  given, else the `.als` mtime) and the musical props
  `tempo`/`tracks`/`devices`/`length_seconds`
  (sidecar-only, numeric). `status` (sketch/promising/album?), `vibe`,
  `next_action`, and the body are the user's — re-imports never touch them. A
  bounce render sitting next to the `.als` is embedded by path (`![[~/…]]`,
  §3) — linked in place, never copied.

## 13. Rules for well-behaved external writers

The rules below are the contract. [`docs/integrations.md`](integrations.md) is
the practical companion — runnable bash and python snippets, the
`scripts/append-row.ts` helper, and what actually happens on screen when an
external write races an open editor.

1. **Prefer the app's IPC when it's running** (§14) — the engine stays consistent,
   links get rewritten on rename, snapshots batch correctly. Direct file writes
   are first-class when the app is closed, or for bulk work.
2. **The watcher picks changes up live.** Recursive FSEvents over the vault,
   300ms debounce; more than 500 changed paths in one burst triggers a full
   rescan. No restart, no manual refresh. Writes under dot-paths (`.git`,
   `.assets/`, …) are deliberately invisible to it — with one exception:
   edits to `.vault/schema.json`, `.vault/views.json`,
   `.vault/folders.json`, `.vault/calendars.json`, `.vault/tagfolders.json`,
   and `.vault/mounts.json` are picked up live and
   surface as a separate `vault:config-changed` event (the app's config
   listeners re-read the
   files from disk; no note refetch fires). Everything else under `.vault/`
   (templates, notification state, `jobs-exit.json`, `format.json`, `backup/`,
   the per-mount indexes under `mounts/`)
   stays unwatched and is re-read from disk on every access.
3. **Write atomic-ish**: temp file in the same directory + rename. The watcher
   debounce absorbs bursts, but a torn write can be indexed mid-state. The app
   itself follows the same discipline (`vault/mod.rs` `write_atomic`): notes,
   assets, and `.vault/*.json` land as a dotted same-dir temp file
   (`.<name>.tmp-<pid>`, invisible to indexer and watcher) then rename into
   place — a crash mid-write leaves the previous content, never a truncated file.
   The temp file is fsynced before the rename and the directory after it, so
   the guarantee holds across power loss too, not just app crashes — external
   writers who care about power-loss durability should do the same.
4. **UTF-8 text, LF or CRLF.** Invalid UTF-8 is decoded lossily (mojibake in the
   UI); files containing NUL bytes are ignored entirely.
5. **Additive by default.** Preserve existing frontmatter and fences; append rows
   to csv fences; don't reorder or re-quote frontmatter gratuitously (but never
   depend on key order — the app sorts keys when it rewrites frontmatter).
6. **Filenames follow titles.** Create with the final title. If you rename a file
   directly, update the `[[links]]` yourself — or use the IPC rename, which
   rewrites them vault-wide.
7. **Never write inside `.git/`** (app-owned), and treat `.trash/` as read-only.
   Drop files into `.assets/` only by its naming rules (§9) — via IPC when possible.
8. **Stay out of hidden paths** unless you mean it: nothing under a `.` component
   is indexed, searched, or watched.
9. **Don't bump `.vault/format.json`** (§5b) unless you're deliberately writing
   a format the app doesn't know yet — a version above the app's makes that
   one config file read-only in Substrate until it updates. Leaving the
   sidecar alone is always right for an external writer, including one adding
   its own keys: unknown keys in the older config files ride along
   untouched at v1; `calendars.json` deliberately rejects unknown entry keys (§5c).
   `.vault/backup/` is the app's pre-migration copies — read it, don't
   depend on it.

### 13.1 Concurrency contract

What an external writer may assume about *when* its writes are seen, and what
the app is doing to the vault at the same time.

**One vault engine, one lock.** Every IPC operation in §14 serializes on a
single `AppState(Mutex<Engine>)` (`src-tauri/src/lib.rs:50`). There is no
per-note locking and no reader/writer split: two IPC calls never interleave
inside the engine, and neither does an IPC call and a watcher batch. Locks are
held for exactly one engine call and **never across an `await`** — that is what
makes deadlock impossible, and it holds even though a good handful of commands
are `async` (currently 14: the file picker, the two proxy-pane status calls, an
FX rate fetch, the coding scan, token usage, folder-DB rescan, vault sync
push/pull, and the five history commands). The ones that do touch vault state
never hold the guard across the suspension point: they take an `AppHandle`
instead of `State<_>` and run their whole body inside `blocking(move || …)`
(`lib.rs:160`, a `spawn_blocking` wrapper), locking the engine on the blocking
thread — a `MutexGuard` is not `Send`, so the compiler enforces this. It *can*
stall: a few operations do real filesystem work under the lock — full-text
search (`src-tauri/src/commands/search.rs:10`), folder-DB rescan
(`commands/schema.rs:20`), note-bundle export (`commands/assets.rs:25`;
plain-text export at `:20` writes without the lock) and any
`rescan()` (`src-tauri/src/vault/mod.rs:864`, full walk + FTS rebuild) — and
everything else waits behind them.

**What runs on background threads.** All are plain detached `std::thread`s;
there is no async runtime in the state layer.

- **Vault watcher** (`lib.rs:641`) — `notify` v8, recursive, 300ms debounce
  (`src-tauri/src/vault/watch.rs:151`). Takes the engine lock to apply changes
  (`lib.rs:659`), then emits `vault:changed` / `vault:config-changed`.
- **Folder-DB watcher** (`lib.rs:701`) — holds the engine lock across a
  whole `sync_folders()` pass.
- **Auto-snapshot ticker** (`lib.rs:458`) — 15s tick (`SNAP_TICK`,
  `lib.rs:87`); commits once the vault has been quiet 120s or dirty 600s
  (`lib.rs:85-86`). Takes the history lock, **never** the engine lock.
- **Due-date notifications** (`notify.rs:644`) — 60s scan (`SCAN_INTERVAL`,
  `notify.rs:53`); grabs list/schema under the engine lock, then releases it
  before delivering.
- **URL enrichment** (`src-tauri/src/commands/notes.rs:122`) — fetches the page
  *outside* the lock, then takes it to write the note.
- **Vault sync is not one of these.** `vault_sync_push` / `vault_sync_pull`
  (`src-tauri/src/commands/vaultsync.rs:74`, `:93`) are `async`, but their work
  runs inside `blocking(…)`; they lock the engine only long enough to clone the
  vault root (`sync_root`, `vaultsync.rs:21`) and, on push, to inspect the
  working tree behind `sync_push_gated` — never across the network git — so a
  slow sync never blocks editing.

**What an external writer may assume.** Disk is authoritative. Your write is
picked up ~300ms after it lands (`apply_changes`, `vault/mod.rs:891`; over 500
paths in one burst it escalates to a full rescan). If the watcher can't be
constructed the app falls back to a 45s poll (`vault/watch.rs:52`) and says so via
`vault:watch-degraded` — worst-case staleness is 45s, not forever. Note
*bodies* are never cached (`Engine::read`, `vault/mod.rs:1067`, hits disk every
call); only the metadata/link/FTS indexes lag, and only for that window.

**Non-UTF-8 notes are readable but not writable (SUB-556).** The engine reads
on two different lanes. The *display/index* lane is lossy (`read_lossy`,
`src-tauri/src/vault/mod.rs:401`): invalid bytes become U+FFFD so a mangled file
still lists, previews, and indexes instead of breaking the view — and a file
containing a NUL byte is reported as "not a text file" rather than decoded at
all. The *write* lane is strict (`read_strict`, `mod.rs:419`): every path that
reads a note in order to write it back — `write_body`, prop sets, renames,
frontmatter edits — decodes with `String::from_utf8` and **refuses the whole
operation** if that fails, with

> this note is not valid UTF-8 — saving would replace the unreadable bytes, so
> the edit was refused; fix the file's encoding outside Substrate first

The refusal is the contract, not a bug: a lossy decode followed by a write
would make the U+FFFD substitutions permanent and silently destroy the original
bytes. So an external writer may leave non-UTF-8 files in the vault — they stay
visible and stay byte-identical — but the app will never rewrite one. Fix the
encoding outside Substrate first. (Regression tests:
`write_body_refuses_an_unreadable_note_instead_of_stripping_it`, `mod.rs:2322`;
`invalid_utf8_note_is_never_rewritten_through_a_lossy_decode`, `mod.rs:3308`.)

**What you may not assume.** There is no lock you can take, no advisory file,
and no transaction spanning two files — the app may be mid-write on a
different note while you work. If you're editing a note the user may also have
open, prefer the IPC `vault_write_body`, which carries an `expected_body`
compare-and-swap (`lib.rs:141`) and fails rather than clobbering a concurrent
edit; a direct file write has no such guard and last-writer-wins.

## 14. The IPC surface (preferred operations)

Tauri commands the frontend uses — the same operations an in-app agent should
prefer (`src-tauri/src/lib.rs`, grouped):

- Notes: `vault_root` `vault_list` `vault_read` `vault_write_body` `vault_create`
  `vault_set_prop` `vault_rename` `vault_move` `url_capture`
- Links/search: `vault_resolve` `vault_backlinks` `vault_related` `vault_search`
  `vault_search_full`
- Trash: `vault_delete` (moves to trash) `vault_trash_list`
  `vault_trash_restore` `vault_trash_delete` `vault_trash_empty`
  `vault_delete_folder` (folder + subtree to trash)
  `vault_trash_restore_folder` `vault_trash_delete_folder`
  `vault_trash_restore_template` `vault_trash_delete_template` (§10 templates)
- Assets: `vault_save_asset` `vault_read_asset` `vault_import_asset`
  `vault_asset_info` `vault_assets_orphaned` `vault_assets_delete` (to trash)
  `vault_assets_restore` `vault_assets_trash_delete`
- Schema/views: `vault_schema_read` `vault_schema_set` `vault_schema_set_icon`
  `vault_schema_home_set` (§6 `home`) `vault_views_read` `vault_views_set`
  `vault_saved_views_read`
  `vault_saved_view_set` `vault_saved_view_delete`
  `vault_sidebar_order` `vault_set_sidebar_order`
  `vault_folder_meta_read` `vault_folder_icon_set` (§7 `$folders`)
- Templates: `vault_template_read` `vault_template_list` — plus explicit-path
  `vault_read` / `vault_write_body` / `vault_set_prop` under `.vault/templates/`
  (§7) for editing a template in place
- Databases (SUB-43): `vault_create_type` `vault_rename_type`
  `vault_delete_type` `vault_rename_prop` `vault_clear_prop` — bulk sweeps;
  take `history_snapshot` immediately before any of them rewrites notes
- Vault folders: `vault_folders` `vault_create_folder` `vault_rename_folder`
- Tags: `vault_tags` (the vault's tag universe with counts)
  `vault_tag_folders_read` `vault_tag_folders_write` (§8b)
  `vault_note_add_tags` (adds tags to a note's `tags:` prop; never moves it)
- Mounts (§8): `mounts_list` `mount_add` `mount_bind` `mount_rescan`
  `mount_rows` `mount_annotate` `mount_remove` — `mount_annotate`
  is a mount's only write path into the vault, and every scan is read-only on
  the mounted folder
- Files: `path_exists` `file_open` `file_reveal` `file_pick` `file_read_text`
  `vault_folder_files` (SUB-812 — the loose files of ONE folder; see §1)
- History: `history_status` `history_list` `history_diff` `history_restore`
  `history_snapshot` `history_purge_note` `history_purge_notes` `history_trim`
- Windows: `agenda_open_note` `agenda_open_capture`
- Export: `export_text` `export_note_bundle` `print_window`
- Integrity: `vault_doctor` — read-only report, never writes (§15)

All take vault-relative note paths and return JSON-shaped results; the engine
re-indexes affected paths before returning, so the next `vault_list` reflects
the write.

## 15. `vault_doctor` — the read-only integrity report

`vault_doctor` scans the whole vault and returns everything it found wrong. It
**never writes** — no repair, no "fix" affordance anywhere in the app; a repair
slice, if it ever lands, will be separate commands. Agents can call it directly;
the in-app report (⌘K → "Vault doctor") renders the same JSON and offers
copy-as-JSON, so what you read on screen is exactly what the command returns.

```jsonc
{
  "scanned_ms": 1753400000000,   // wall clock at scan time
  "notes": 412,                  // notes indexed when the scan ran
  "findings": [
    {
      "kind": "broken-link",     // see the table below
      "severity": "error",       // "error" | "warn"
      "paths": ["Releases/Slow Bloom EP.md"],  // vault-relative; `.vault/…` for config findings
      "subject": "umbra unreleased",           // the thing that failed to resolve
      "detail": "wikilink target resolves to no note"
    }
  ]
}
```

Findings are sorted by kind, then severity (errors first), then path — a stable
order, so two scans of an unchanged vault produce byte-identical JSON.

| `kind` | Meaning | Severity |
| --- | --- | --- |
| `broken-link` | `[[target]]` matches no note title or stem, and names no database (a link to a database opens its view, §3) | error |
| `broken-relation` | a `relation` prop (§6) names a note that doesn't exist; or the named note doesn't wear the relation's `target` type | error / warn |
| `broken-embed` | `![[file]]` with no file behind it — under `.assets/` (error) or linked in place (warn: the volume may just be unmounted, §3) | error / warn |
| `broken-view-ref` | a ` ```view ` fence (§5.6) naming a `saved:` view that was deleted, or a `type:` that is not a database | error |
| `ambiguous-target` | two or more notes share a title or filename stem, so a wikilink to that name resolves to whichever the index reached first — create-dedupe is per-folder, so this is how cross-folder collisions surface (§3) | warn |
| `stale-config` | `.vault/*.json` pointing at something gone: a schema type with zero notes, a `home`/folder-mapping path that no longer exists, a views or saved-view entry for an unknown type. A mount that is unbound on this machine, or whose bound folder is gone, is a **warn** and never an error: its board still renders from the last-known index and "Locate folder…" fixes it (§8) | warn / error |
| `invalid-prop` | a `date` or `number` prop whose value does not parse under the schema's kind — the value is reported, never rewritten | error |

`paths` holds every note involved: one entry for most findings, one per
colliding note for `ambiguous-target`, and the config file (`.vault/schema.json`,
`.vault/views.json`, `.vault/mounts.json`, `.vault/folders.json`) for
`stale-config`.

