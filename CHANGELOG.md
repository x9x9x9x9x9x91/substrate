# Changelog

<!-- Generated from src/lib/changelog.ts by scripts/gen-changelog.ts.
     Edit that file, then run `node scripts/gen-changelog.ts`. -->

## 0.19.0 — 2026-08-02

- Tasks board v2: a Now/Later split so today's list stays short, checkoff straight from
  the board, and snooze to push a task out of sight until it matters.
- The proxy dashboard reads at a glance now — each account row carries one quota bar for
  its binding window, with 5-hour and 7-day usage as compact rings beside it.
- Calendar peek opens beside the entry instead of covering it, and the click that
  dismisses a peek no longer starts composing a new entry underneath.
- First-run seed vault got a real flagship: a Label Overview dashboard (catalogue,
  releases, roster) replaces the abstract Yield APR sample.
- Vault writes hardened end to end: exports, asset imports and template deletes are
  atomic (no half-written files on a crash), deleted templates route through the trash,
  and restoring an old version warns when it would bury a newer external edit.
- Security pass: credential stores are denied from asset scope, URLs are logged without
  embedded credentials, terminal palette quick actions respect the PTY trust check, and
  importers fail closed on a bad vault target.
- Notifications stay monotonic across the spring DST gap, and doctor's folder-mapping
  check understands ~ paths.
- The project is public now: AGPL-3.0 licensed, with contribution and security-reporting
  guidelines — and release builds carry no trace of the machine that built them.

## 0.18.0 — 2026-08-02

- Sheet formulas grew a real vocabulary: LOOKUP across sheets (and per row),
  SUMIF/COUNTIF with multiple criteria, wildcards and comparisons, SUMPRODUCT for
  weighted averages, LAST(), date arithmetic with TODAY(), and identifiers in any
  language.
- Databases can roll up values from related databases — a rollup column derives counts,
  sums and lists from linked rows, straight from Notion imports too.
- Three new dashboards: Jobs shows every scheduled background task with its run history
  and pause control, Attention surfaces tasks that need a look, and Waiting collects
  everything blocked on someone else.
- Map a folder: point the app at any folder of notes and it becomes a database, from the
  sidebar or the palette.
- The sidebar got a clarity pass — cleaner grouping, dashboard groups with their own
  menus and remembered order, and app-wide zoom. Calendar months render Notion-style
  lines with identity bars and done-states, and week blocks are as tall as their actual
  duration.
- Food tracking: your weight curve overlays the 14-day strip, kcal expressions compute
  portions inline (ph basis + math), and typing negative kcal logs exercise directly.
- Dashboards can print — agenda, food, and the other portable kinds produce a clean
  paper layout.
- Renaming a note no longer risks losing keystrokes typed mid-rename — the editor
  relabels in place instead of reloading, and carries in-flight text across a title
  change. Multi-file paste imports every file, and a dropped asset lands at the drop
  point, not the live cursor.
- Notifications got honest: recurring deadlines fire on each occurrence day, snoozes
  survive past midnight, nothing late-fires for a future day, and completed or
  calendar-hidden notes stay quiet.
- Number cells read German-style decimal commas, and audio files in database rows gained
  a play button.

## 0.17.0 — 2026-07-30

- Dragging finally works in the app itself — reorder the sidebar, drop notes into
  folders, move dashboards, drag board cards. It always worked in tests and never on the
  Mac; the desktop shell was swallowing every drag before the app could see it.
- One straight icon column down the whole sidebar — dashboards, databases and folders
  line up instead of each section picking its own indent.
- Dashboards can live in your folders: drop one on any folder in the tree and it shows
  up right there, still opening as a dashboard.

## 0.16.0 — 2026-07-30

- A date can now be a range — pick a start and an end in the same picker, see it as a
  span across the calendar, and sort and filter by when it actually runs. Imports from
  Notion keep their end dates too.
- Select text in a note for a floating menu: extract the selection into its own linked
  note, turn it into a heading or list, or copy it as Markdown.
- The news feed has a refresh button that sends the curator out for a fresh sweep
  instead of waiting for the next scheduled one.
- The sync dashboard reads as sentences — each backup leg states its finding in plain
  words, with hairline rows and ticks that stay put at any window width.
- The token-usage pane now counts subagent transcripts too, so delegated work no longer
  hides from the totals.
- Fixed: background git maintenance could repack a vault's history store; sidebar pins
  under a dashboard folder rendered twice; extracted-note titles could carry characters
  the engine refuses.

## 0.15.0 — 2026-07-25

- Dashboards share one design language — a single header, mono micro-labels, hairline
  structure, and round state dots instead of boxed cards.
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
- The menu bar gets a proper monochrome tray icon, and vault writes survive power loss.
- Text typed straight into a new note is no longer cut mid-word into its title, and
  keystrokes aimed at the note list are no longer swallowed by the editor — the brief
  auto-focus delay after a note opens now yields the moment you type or click.

## 0.14.0 — 2026-07-23

- Sheet rows and columns can be deleted and reordered from the context menu.
- The sidebar de-nests saved views, wears curated folder and dashboard icons, and drops
  the Sketchpad entry — Notes now lists only untyped, unfiled notes.
- The coding dashboard aligns lane age, behind-count, and commit age to shared rails.

## 0.13.0 — 2026-07-23

- A "New sheet" command in the palette.
- The sidebar collapses to a slim rail and back.
- A shareable public mirror of the app, with a dashboards guide and an example vault.

## 0.12.1 — 2026-07-23

- Right-click note rows on Today, Search, and Trash; calendar agenda rows gain a menu
  with Mark done.
- Currency conversion is cached globally and never written into your notes as a
  property.
- Sidebar counts tuck after the label when a shortcut shares the row.

## 0.12.0 — 2026-07-23

- Quick-add remembers what you eat — autocomplete with a quantity grammar, so "200g
  oats" logs itself.
- The calorie surface shows distance to your goal and a week-vs-goal figure, and
  exercise can be logged the same way.

## 0.11.1 — 2026-07-23

- Dashboards use the full content width — grids stopped truncating on normal windows.

## 0.11.0 — 2026-07-23

- Vault sync: push and pull your vault against your own server over authenticated HTTPS,
  with the token held in the OS keychain.
- Substrate runs on a phone — single-pane navigation, readable calendar days, and
  layouts that stack instead of squeezing.
- A calorie surface: log meals against a daily band, with undo, a day strip, and a
  seven-day average.
- A coding dashboard listing your repositories sorted by what needs attention.
- Every control is reachable by keyboard — sidebar, rows, calendar, pickers, search
  results, and backlinks.
- Databases remember per-database column visibility and sort order.
- The yield board gains a two-click Claim with full undo history.

## 0.10.6 — 2026-07-21

- Gallery covers stay square at any density, and the placeholder recedes so the title
  leads the card.
- Journal ghost days say they are writable instead of looking empty and dead.
- Line charts space points by real time — irregular snapshots stopped lying about their
  shape.
- ⌘/ opens the shortcuts overlay in the editor without toggling comments.

## 0.10.5 — 2026-07-20

- Alignment fixes across the status pane.

## 0.10.4 — 2026-07-20

- Quota lines show when each window resets.

## 0.10.3 — 2026-07-20

- Usage bars fill by real usage, not an estimate.

## 0.10.2 — 2026-07-20

- Real-vault polish round — aligned summary columns, compact chart numbers.

## 0.10.1 — 2026-07-20

- Charts get flat fills, status-coloured bars, and a disciplined axis.
- Tables gain text hierarchy — quiet uppercase headers, dates a step dimmer.
- A hairline seam separates database blocks from loose notes in lists.
- The window opens maximized instead of at a fixed size, and a failed weekly verify
  reads as the alert it is.
- The calendar peek no longer dismisses itself the moment it opens.

## 0.10.0 — 2026-07-20

- A music download surface: queue albums, watch the transfer tail, cancel mid-run.
- Click a calendar entry to peek at it — edit title, date, time, and status in place.
- Databases get a view tab bar and one consolidated toolbar.
- Note property rows follow the schema's order, with aligned labels.
- Large databases paint lazily — 1400-row tables no longer stall the pane.
- Select properties sort by their schema option order, not alphabetically.
- A wider reading measure and more air in cells.

## 0.9.0 — 2026-07-20

- Today is a day-agenda decision surface — what is scheduled, due, overdue, and picked,
  in one place.
- The sync dashboard became a control surface: start, inspect, and hold your backup jobs
  from the app.
- Sync refuses to start a run while a sweep is already in flight.
- Restoring an old version of a note now lands in the open editor instead of being
  overwritten.

## 0.8.1 — 2026-07-19

- Saved views nest under the database they belong to.
- Database panes stopped going blank on reserved schema keys.

## 0.8.0 — 2026-07-19

- Select many table rows at once and set a property, or trash them, in one action.
- Dates carry an optional time of day, preserved across calendar, menus, and every
  display surface.
- The week view renders day columns as cards.
- Wikilink autocomplete on [[, and find-in-note on ⌘F.
- Import a CSV as a database from inside the app; attach any file type as a chip.
- A filter that dead-ends at zero rows now says why, and search hits open in their home
  context with Esc returning to results.
- Trashing, moving, and renaming notes flush pending edits first, and a toast offers
  Undo.
- Numbers, money, percentages, and file sizes all render in German formatting.

## 0.7.0 — 2026-07-18

- Embedded views rebuild themselves when the vault changes on disk.
- Today and Calendar re-render when the day rolls over at midnight.
- Switch saved views from inside the pane, and a freshly saved view reveals its pin.
- Audio notes open faster — waveform decoding is deferred off the first render.
- Renaming a note no longer rewrites links inside embedded assets.

## 0.6.1 — 2026-07-18

- Bar charts stand on a baseline and stop skipping empty time buckets.
- Menus group destructive actions behind a hairline.
- Markdown tables and view embeds speak the same card language, with a quiet open
  affordance.
- The sidebar yields width in narrow windows.

## 0.2.0 — 2026-07-17

- Added saved views, richer schemas and select fields, and spreadsheet-style sheets.
- Upgraded the editor and command palette, including faster capture workflows.
- Added note history and trash recovery.
- Fixed drag interactions and expanded the app's keyboard-driven controls.

## 0.1.0 — 2026-07-17

- Established the local-first Markdown vault, SQLite search, backlinks, and file
  watcher.
- Shipped the founding three-pane interface with editing and command palette basics.
