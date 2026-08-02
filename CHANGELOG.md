# Changelog

<!-- Generated from src/lib/changelog.ts by scripts/gen-changelog.ts.
     Edit that file, then run `node scripts/gen-changelog.ts`. -->

## 0.20.1 — 2026-08-02 — The updater's first flight

### Highlights

- This release shipped through the new update channel. If a toast offered it and a
  restart brought you here, the updater has now proven itself end to end — signed
  artifact, verified signature, background install.

### Improved

- Fresh downloads get this version directly; everyone on 0.20.0 gets the toast.

## 0.20.0 — 2026-08-02 — It updates itself now

### Highlights

- Substrate keeps itself current: when a new version ships, a toast offers it, one click
  installs in the background, and a restart finishes the job. This is the last version
  you download by hand.
- Database views inside notes are editable now — click a cell to change it, tick
  checkboxes in place, and add rows with + New, all without leaving the note.

### New

- Type /view to drop a database view into a note: a picker lists your databases, and
  choosing one builds the view and steps the cursor past it.
- Setting up a new vault can wire in your AI agent: the welcome flow asks which agent
  CLI you use and puts it one shortcut away in the built-in terminal.

### Improved

- Agent instruction files (AGENTS.md, CLAUDE.md) stay out of your notes list — the app
  conceals them unless a settings toggle says otherwise, and the Welcome note now gives
  a fuller tour.
- The command palette understands synonyms — create, make and add all find the New
  commands.
- This changelog reads better: each release leads with its flagship, and the rest is
  grouped into New, Improved and Fixed.

## 0.19.0 — 2026-08-02 — A board that knows what's next

### Highlights

- Tasks board v2: a Now/Later split so today's list stays short, checkoff straight from
  the board, and snooze to push a task out of sight until it matters.

### New

- The project is public now: AGPL-3.0 licensed, with contribution and security-reporting
  guidelines — and release builds carry no trace of the machine that built them.

### Improved

- First-run seed vault got a real flagship: a Label Overview dashboard (catalogue,
  releases, roster) replaces the abstract Yield APR sample.

### Fixed

- Calendar peek opens beside the entry instead of covering it, and the click that
  dismisses a peek no longer starts composing a new entry underneath.
- Vault writes hardened end to end: exports, asset imports and template deletes are
  atomic (no half-written files on a crash), deleted templates route through the trash,
  and restoring an old version warns when it would bury a newer external edit.
- Security pass: credential stores are denied from asset scope, URLs are logged without
  embedded credentials, terminal palette quick actions respect the PTY trust check, and
  importers fail closed on a bad vault target.
- Notifications stay monotonic across the spring DST gap, and doctor's folder-mapping
  check understands ~ paths.

## 0.18.0 — 2026-08-02 — Sheets learn to compute

### Highlights

- Sheet formulas grew a real vocabulary: LOOKUP across sheets (and per row),
  SUMIF/COUNTIF with multiple criteria, wildcards and comparisons, SUMPRODUCT for
  weighted averages, LAST(), date arithmetic with TODAY(), and identifiers in any
  language.
- Databases can roll up values from related databases — a rollup column derives counts,
  sums and lists from linked rows, straight from Notion imports too.

### New

- A new Attention dashboard surfaces the tasks that need a look.
- Map a folder: point the app at any folder of notes and it becomes a database, from the
  sidebar or the palette.
- Dashboards can print — agenda, food, and the other portable kinds produce a clean
  paper layout.

### Improved

- The sidebar got a clarity pass — cleaner grouping, dashboard groups with their own
  menus and remembered order, and app-wide zoom. Calendar months render Notion-style
  lines with identity bars and done-states, and week blocks are as tall as their actual
  duration.
- Food tracking: your weight curve overlays the 14-day strip, kcal expressions compute
  portions inline (ph basis + math), and typing negative kcal logs exercise directly.

### Fixed

- Renaming a note no longer risks losing keystrokes typed mid-rename — the editor
  relabels in place instead of reloading, and carries in-flight text across a title
  change. Multi-file paste imports every file, and a dropped asset lands at the drop
  point, not the live cursor.
- Notifications got honest: recurring deadlines fire on each occurrence day, snoozes
  survive past midnight, nothing late-fires for a future day, and completed or
  calendar-hidden notes stay quiet.
- Number cells read German-style decimal commas, and audio files in database rows gained
  a play button.

## 0.17.0 — 2026-07-30 — Drag and drop, for real this time

### Highlights

- Dragging finally works in the app itself — reorder the sidebar, drop notes into
  folders, move dashboards, drag board cards. It always worked in tests and never on the
  Mac; the desktop shell was swallowing every drag before the app could see it.

### New

- Dashboards can live in your folders: drop one on any folder in the tree and it shows
  up right there, still opening as a dashboard.

### Fixed

- One straight icon column down the whole sidebar — dashboards, databases and folders
  line up instead of each section picking its own indent.

## 0.16.0 — 2026-07-30 — Dates get a second half

### Highlights

- A date can now be a range — pick a start and an end in the same picker, see it as a
  span across the calendar, and sort and filter by when it actually runs. Imports from
  Notion keep their end dates too.

### New

- Select text in a note for a floating menu: extract the selection into its own linked
  note, turn it into a heading or list, or copy it as Markdown.

### Fixed

- Fixed: background git maintenance could repack a vault's history store; sidebar pins
  under a dashboard folder rendered twice; extracted-note titles could carry characters
  the engine refuses.

## 0.15.0 — 2026-07-25 — Dashboards become instruments

### Highlights

- Dashboards share one design language — a single header, mono micro-labels, hairline
  structure, and round state dots instead of boxed cards.

### New

- Notes with broken frontmatter now say so in the app and offer a repair, instead of
  quietly refusing property edits.
- Drag a file into a note while holding Shift to link it in place rather than copying it
  into the vault; a hint pill teaches the gesture.
- A contextual info view explains whatever the pointer is over, docked in the
  lower-left.
- Table cells can be edited in place, columns resized by dragging their header, and text
  wrapped per column.
- A terminal HUD on ⌘⇧T, a settings sheet on ⌘,, and palette quick actions.
- "Remove from sidebar" un-homes a database from its folder row, and root folders can be
  reordered.

### Fixed

- The menu bar gets a proper monochrome tray icon, and vault writes survive power loss.
- Text typed straight into a new note is no longer cut mid-word into its title, and
  keystrokes aimed at the note list are no longer swallowed by the editor — the brief
  auto-focus delay after a note opens now yields the moment you type or click.

## 0.14.0 — 2026-07-23 — Sheets and sidebar tidy-up

### New

- Sheet rows and columns can be deleted and reordered from the context menu.

### Improved

- The sidebar de-nests saved views, wears curated folder and dashboard icons, and drops
  the Sketchpad entry — Notes now lists only untyped, unfiled notes.

## 0.13.0 — 2026-07-23 — New sheet, collapsible sidebar

### New

- A "New sheet" command in the palette.
- The sidebar collapses to a slim rail and back.
- A shareable public mirror of the app, with a dashboards guide and an example vault.

## 0.12.1 — 2026-07-23 — Context menus everywhere

### New

- Right-click note rows on Today, Search, and Trash; calendar agenda rows gain a menu
  with Mark done.

### Fixed

- Currency conversion is cached globally and never written into your notes as a
  property.
- Sidebar counts tuck after the label when a shortcut shares the row.

## 0.12.0 — 2026-07-23 — Smarter calorie logging

### Highlights

- Quick-add remembers what you eat — autocomplete with a quantity grammar, so "200g
  oats" logs itself.

### New

- The calorie surface shows distance to your goal and a week-vs-goal figure, and
  exercise can be logged the same way.

## 0.11.1 — 2026-07-23 — Wider dashboards

### Fixed

- Dashboards use the full content width — grids stopped truncating on normal windows.

## 0.11.0 — 2026-07-23 — Vault sync, phones, and food

### Highlights

- Vault sync: push and pull your vault against your own server over authenticated HTTPS,
  with the token held in the OS keychain.
- Substrate runs on a phone — single-pane navigation, readable calendar days, and
  layouts that stack instead of squeezing.

### New

- A calorie surface: log meals against a daily band, with undo, a day strip, and a
  seven-day average.
- Databases remember per-database column visibility and sort order.
- The yield board gains a two-click Claim with full undo history.

### Improved

- Every control is reachable by keyboard — sidebar, rows, calendar, pickers, search
  results, and backlinks.

## 0.10.6 — 2026-07-21 — Density and honesty pass

### Improved

- Journal ghost days say they are writable instead of looking empty and dead.

### Fixed

- Gallery covers stay square at any density, and the placeholder recedes so the title
  leads the card.
- Line charts space points by real time — irregular snapshots stopped lying about their
  shape.
- ⌘/ opens the shortcuts overlay in the editor without toggling comments.

## 0.10.5 — 2026-07-20 — Stability and polish under the hood

### Fixed

- Alignment fixes across the status pane.

## 0.10.4 — 2026-07-20 — Stability and polish under the hood

### Improved

- Quota lines show when each window resets.

## 0.10.3 — 2026-07-20 — Stability and polish under the hood

### Fixed

- Usage bars fill by real usage, not an estimate.

## 0.10.2 — 2026-07-20 — Stability and polish under the hood

### Fixed

- Real-vault polish round — aligned summary columns, compact chart numbers.

## 0.10.1 — 2026-07-20 — Visual polish across every surface

### Improved

- Charts get flat fills, status-coloured bars, and a disciplined axis.
- Tables gain text hierarchy — quiet uppercase headers, dates a step dimmer.
- A hairline seam separates database blocks from loose notes in lists.

### Fixed

- The window opens maximized instead of at a fixed size, and a failed weekly verify
  reads as the alert it is.
- The calendar peek no longer dismisses itself the moment it opens.

## 0.10.0 — 2026-07-20 — Downloads, peeks, and view tabs

### Highlights

- A music download surface: queue albums, watch the transfer tail, cancel mid-run.

### New

- Click a calendar entry to peek at it — edit title, date, time, and status in place.
- Databases get a view tab bar and one consolidated toolbar.

### Improved

- Note property rows follow the schema's order, with aligned labels.
- Large databases paint lazily — 1400-row tables no longer stall the pane.
- A wider reading measure and more air in cells.

### Fixed

- Select properties sort by their schema option order, not alphabetically.

## 0.9.0 — 2026-07-20 — Today, rebuilt

### Highlights

- Today is a day-agenda decision surface — what is scheduled, due, overdue, and picked,
  in one place.

### Fixed

- Restoring an old version of a note now lands in the open editor instead of being
  overwritten.

## 0.8.1 — 2026-07-19 — Sidebar homes and blank panes

### Improved

- Saved views nest under the database they belong to.

### Fixed

- Database panes stopped going blank on reserved schema keys.

## 0.8.0 — 2026-07-19 — Bulk edits, time of day, and the week view

### Highlights

- Select many table rows at once and set a property, or trash them, in one action.

### New

- Dates carry an optional time of day, preserved across calendar, menus, and every
  display surface.
- The week view renders day columns as cards.
- Wikilink autocomplete on [[, and find-in-note on ⌘F.
- Import a CSV as a database from inside the app; attach any file type as a chip.

### Improved

- A filter that dead-ends at zero rows now says why, and search hits open in their home
  context with Esc returning to results.

### Fixed

- Trashing, moving, and renaming notes flush pending edits first, and a toast offers
  Undo.
- Numbers, money, percentages, and file sizes all render in German formatting.

## 0.7.0 — 2026-07-18 — Live vault, faster open

### New

- Switch saved views from inside the pane, and a freshly saved view reveals its pin.

### Improved

- Audio notes open faster — waveform decoding is deferred off the first render.

### Fixed

- Embedded views rebuild themselves when the vault changes on disk.
- Today and Calendar re-render when the day rolls over at midnight.
- Renaming a note no longer rewrites links inside embedded assets.

## 0.6.1 — 2026-07-18 — Charts stand up, menus calm down

### Improved

- Menus group destructive actions behind a hairline.
- Markdown tables and view embeds speak the same card language, with a quiet open
  affordance.

### Fixed

- Bar charts stand on a baseline and stop skipping empty time buckets.
- The sidebar yields width in narrow windows.

## 0.2.0 — 2026-07-17 — Views, schemas, and sheets

### New

- Added saved views, richer schemas and select fields, and spreadsheet-style sheets.
- Added note history and trash recovery.

### Improved

- Upgraded the editor and command palette, including faster capture workflows.

### Fixed

- Fixed drag interactions and expanded the app's keyboard-driven controls.

## 0.1.0 — 2026-07-17 — The local-first vault

### New

- Established the local-first Markdown vault, SQLite search, backlinks, and file
  watcher.
- Shipped the founding three-pane interface with editing and command palette basics.
