# Changelog

<!-- Generated from src/lib/changelog.ts by scripts/gen-changelog.ts.
     Edit that file, then run `node scripts/gen-changelog.ts`. -->

## 0.27.0 — 2026-08-23 — The day gets a spine, and every exit is one door

### Highlights

- Today plans the day: pick one thing as the day's headline, the scheduled lane says
  what is happening now and how long until the next thing, the capture line writes a
  note that is already on the day, and wrapping the day leaves one journal line with the
  leftovers cleared.
- One door out: every way a note leaves this machine goes through the same share dialog.

### New

- Quick capture pivots: ⌘K inside the capture window jumps to the vault palette carrying
  what you typed — one global chord in from anywhere, and ⌘K always means search. The
  palette's own chord retires to an empty Settings binding.
- The About row can ask the release feed whether this build is current, and answers
  plainly: current, update available with an Install action, or unreachable.

### Improved

- The accent tone dial drives the whole app's accent family — one tone across rings,
  selections, buttons and charts.
- Hub boards pack tight: tiles fill the hole under a short neighbor, a callout can claim
  the double-width card, and a tile can own a custom span.
- A paused hosted vault names the pause and walks the way out of it from the sync pane —
  including replacing the server's copy, with what that costs stated before anything
  moves.

### Fixed

- Calendar week: the all-day strip, the weekday header and the day canvas share one
  scrollbar lane, so the columns line up again; the focused day is a quiet top mark
  instead of a loud ring; a month cell rings only while its day number holds keyboard
  focus.
- Tab-indented list lines hang by their prefix tabs instead of collapsing at the wrap.
- A database draft title paints one accent ring, not a frame in a frame.

## 0.26.0 — 2026-08-22 — Dashboards find one voice, and the app explains itself

### Highlights

- Every dashboard speaks one voice: the whole board family got a design pass — one error
  banner, one empty-state dialect, one rhythm on screen and on paper, with page breaks
  that respect charts and hubs that reflow for print. Custom kinds run contained, and
  kind authors get a real contract: drop the shipped kind-api.d.ts next to your bundle
  and your editor knows every ctx member. And the docs finally say it plainly: the app
  is dark-only.
- The app teaches what it needs, where you are: the sub-item switch stays visible
  wherever it could apply and says why it's off, naming the relation it needs; /heatmap
  scaffolds explain their own keys and an unfinished fence gets a calm what-goes-here
  card instead of a parse error; a bare dashboard note asks what kind it should be
  instead of silently becoming the yield tracker.

### Improved

- A calendar week's worth of feel: multi-day drags can't strand an event anymore,
  drag-over paints a quiet outline instead of a blue slab, ranges take an end hour in
  the peek, ⌘⌫ deletes the selected event, the Upcoming panel resizes and can live in
  the right rail, and the shortcut HUD folds its runs of digit keys into one tidy cap.
- Settings grew tabs — the one long page is now organized into surfaces you can actually
  find things on.
- Table Name cells behave like cells: one click renames in place, double-click or Enter
  opens the note — and errors across the app dropped their "Error:" stutter and speak
  the shared banner, with sync failures announced to screen readers the moment they
  arrive.
- A history rewrite (sealing a note) that pauses hosted sync now says so immediately
  instead of surfacing minutes later — and the pause reads as something to act on, not a
  permanent red.

### Fixed

- Sheets keep their shape: a totals row caps at three summaries per column (the rest
  fold into the footer chips), an oversized row lets go of its pin instead of covering
  the data, and the column names stay legible above it all. Ragged CSV rows are named
  instead of silently absorbed.
- A fence the parser rejects but that is properly closed draws its error in place
  instead of a silent blank board.
- A busy vault no longer saturates the file watcher — settle pushes fire when your edits
  settle again, not at the ten-minute fallback.
- The shelf's dates and Recall's counts read the vault's own dials: both now follow your
  date and number settings, not the machine's locale.

## 0.25.0 — 2026-08-21 — Search includes the past, and the vault syncs itself

### Highlights

- Search can include the past — an opt-in, on-device index over your vault's history
  answers from versions you edited away, matches landing in the time scrubber at the
  moment they existed — and it reads your pictures: text inside screenshots and images
  is searched on-device, and a picture that answers opens at the matching words.
- The vault syncs itself: push when your edits settle, pull when you open, focus, or
  just wait — one toggle in the Sync pane. And hosted sync grew up around it: enrollment
  and remote shown, passphrase change in place, a health check that stops a failing leg
  or a skewed clock from reading green, pushes that verify what the server claims to
  hold, and a store that warns before it fills.

### New

- Notes learn structure: a note with a handles: line becomes a person page whose
  appearances rail collects every calendar entry, database row, and mention that already
  names them — and tables and boards grow expandable sub-item trees from a marked parent
  relation, with rollups that keep counting while a branch is folded.
- External drives join the vault as mounts that outlive the unmount: a shelf in the rail
  you can browse with the disk in a drawer, each drive saying how long since it was last
  seen — and a mounted folder of Ableton projects puts tempo, key, track count, and Live
  version on the board.
- The dashboard family goes public: cards, charts, progress thermometers, calendar
  grids, heatmaps and timelines are documented kinds with slash commands, joined by
  boards for scheduled jobs, repo health, folder sync, and tax season. ⌘K creates a
  dashboard by name with a starter note, and the cookbook comes to you — browse and
  install recipes inside the app, a ready personal-finance workbook included.
- Speak a note: voice capture ships for everyone, started by hotkey or button, with the
  microphone prompt naming every way a recording can begin — and quick capture can show
  what you were doing as a chip on the capture window, off by default behind a new
  Experimental section in Settings.
- The editor meets you halfway: /table drops a scaffold and a rendered table grows from
  its own edges, right-click edits cells in place, the filter bar teaches its whole
  grammar, completion reaches view fences, wikilink anchors and aliases, live values and
  frontmatter, seal, lock, and print are reachable from every surface that can use them
  — and a property's schema can declare how fresh its values should stay.
- iOS home-screen widgets show your dashboard tiles from the last-synced vault and
  deep-link back into the note.

### Improved

- Polish across the board: wrapped list lines hang-indent under their own text, the
  outline toggle joined the note tool row, every dashboard explains itself in its own
  words, a saved view reads the same in the app and headless, the ⌘K palette carries
  every destination with its real keycaps, and the tray agenda dims what you finished.

### Fixed

- A truth sweep: rows from mounted folders stay in search scope, a revealed row the
  window hasn't painted is scrolled to instead of lost, out-of-range coercions stop
  leaking Infinity into values, money rounds in decimal space so 1.005 keeps its cent,
  tables inside blockquotes render as tables and keep your first keystrokes when they
  grow, a Live 12 set's root note reads correctly, and an idle pull that cannot read the
  tree fails instead of reporting no change.

## 0.24.0 — 2026-08-11 — Search reads your properties, and bulk edits sign their work

### Highlights

- Search reaches into properties: plain-text search now answers from property values —
  text, numbers, even checkboxes — a property-only hit shows the value that matched and
  says so, and the ⌘K palette marks exactly what matched, accents and all, in the same
  match language as full search.
- Bulk sweeps sign their work: a sweep that touches many notes commits under its own run
  summary — receipts and time travel name the run instead of blaming each note on an
  anonymous edit — and an outside tool writing through the agent door is credited as
  itself.

### New

- Changing a property's type warns before it costs you: the schema editor names what a
  retype will destroy — select options and their colors, a number's format, the risk a
  checkbox conversion overwrites values — before you press Save.

### Improved

- Installing an update shows its download progressing — a slow fetch is no longer a
  click that looks dead.
- Filing pickers rank by recency: the databases you touched last come first, instead of
  the biggest ones — and menu rows that carry an icon always draw it.
- Scrolling got soft edges everywhere: board columns, list and gallery views and Today's
  day scroller fade at the scroll stops instead of clipping mid-glyph, keyboard walks —
  the ⌘K palette's included — land rows clear of sticky headers, footers and the fades,
  the palette stopped painting a duplicate section header on cold open, and the Music
  Work board uses its full pane width.
- Calendar craft: month chips answer hover, an expanded day cell fades like everything
  else, the week view's opening scroll clears the first hour label, and hub head counts
  stopped over-promising.

### Fixed

- Money tells the truth: footer sums say how many text cells they skipped, fractional
  currencies show both cents, the yen keeps its zero-decimal precision, an all-text
  numeric column keeps its footer marker — and a footer counts "1 row", not "1 rows".
- History answers the question you asked: fact keys match case-insensitively in both
  tenses — history queries, receipts and live reads now agree — and a bulk sweep records
  only the notes it actually swept.
- Fixes with names: the + property chip keeps a bare-key draft — Enter turns it into a
  real key instead of eating it; backlinks refresh while you watch, stop re-fetching on
  your own autosaves, and their header counts right; palette actions, failed copies and
  schema-save refusals surface as toasts instead of console lines; rollups survive being
  configured on a mounted database; the hidden import stamp neither poses as a property
  row nor answers search; and an empty gallery result says so across the pane, not
  inside one cell.

## 0.23.0 — 2026-08-08 — Every fact shows its receipts, and agents get a proper front door

### Highlights

- Receipts: every property remembers who set it. Hover a chip and a small clock appears
  — click it for the value's history, each change as value, author and time ("You",
  "Claude (via MCP)", an outside tool by name), newest first. Click a row to jump time
  travel to that exact moment; the footer links the note's full history and always says
  how far back the record goes.
- Agents get a front door: a built-in MCP server — with a headless CLI twin — lets
  Claude and other assistants read and write the vault through the app's own rules,
  never behind its back. You grant each client its folders in Settings and revoke them
  there; a client without a grant cannot connect at all. The door's manual ships with
  the public repo.

### New

- The calendar gains a day view — one day, laid out by hour, alongside month and week —
  and events stretch: drag an event's edge to set how long it runs, or set an end time
  in the peek.
- Today grew into its job: notes can be picked into the day from other lists, dateless
  notes can be picked at all, and the whole pane drives from the keyboard.
- Notes grow tags: #hashtags typed in prose and a tags: property both count, and tag
  folders in the sidebar collect every note carrying theirs — saved queries you never
  have to write.
- Prose can compute: an inline code span opening with = renders its answer in place (`=
  Masters.count` reads as a number inside the sentence), and numbers understand units —
  columns carry one, sums and averages respect it, and 25 USD in EUR is an expression,
  not a search.
- Audio, both directions: a folder of audio plays as a playlist, with a mini-player that
  keeps it going while you work anywhere else in the app; and voice capture records from
  the capture surface, transcribed on this machine — the audio never leaves it — and
  files as one note holding the recording and its searchable text.
- Reach, in both directions: substrate:// links open the app from anywhere onto a note
  or a prefilled capture box; search sees into mounted folders; sheets gain a totals
  row, filtered sums, and column notifications that open the sheet at the row that
  fired; property kinds can ship as bundles inside the vault; dashboards compose on a
  grid; hub notes render calendar and timeline fences, a month grid and a date-axis arc
  drawn live from the data they query; a settings dial picks the one locale every date
  renders in; and a glow dial with curated accent tones joins Settings.

### Improved

- The design refresh: the big empty states draw purpose-made hero marks in the app's
  lit-slab language, onboarding leads with the product mark, hover copy on the main
  surfaces moved into instant styled tooltips, the front-door empties offer their one
  clear action as a real button, live database embeds on hub pages edit like the
  editor's own tables, and back and undo gained mouse paths.

### Fixed

- Fixes with names: dashboards paint from the snapshot they already hold instead of
  flashing blank; a failed bulk write says which notes failed and why; property edits
  from the palette report their errors; editing a chip shows the new value immediately
  instead of snapping back; and mounted folders behave on case-insensitive disks.

## 0.22.0 — 2026-08-03 — Time travel for the whole vault, and a calendar that follows your feeds

### Highlights

- Time travel: scrub the whole vault back to any past snapshot and read it as it was —
  notes, dashboards and sheets all render from that moment, past mode is strictly
  read-only with a clear cue, and restoring takes a safety snapshot first so the present
  is never lost.
- The calendar can subscribe to external calendar feeds (ICS): subscribed events appear
  alongside your vault's own dates, day cells count everything they show and say when a
  day is busy, and feeds are fetched carefully — capped, contained, and every outbound
  fetch named in the docs.

### New

- Remind me before it's due: date properties take a lead time, and the reminder fires
  that many days ahead of the day-of alert.
- Sheets and charts read better: charts split into series with by: — one measure pivoted
  by a second column — and answer a hover or keyboard focus with an exact-value tooltip
  card, while summary formula lines group by blank lines, the summary bar ranks its
  chips, and one shared error reports once instead of cascading down every dependent
  line.
- Two designed PDF exports join the generic print: a note one-sheet (artwork, title
  block, quiet fact rows) and a clean database table sheet.
- Browse the dashboard cookbook inside the app and install any recipe into your vault
  with one click.
- A tax-readiness dashboard over two sheets shows where the year stands — category
  totals, the receipts still owed, and a plain verdict on whether it is fit to hand
  over.

### Improved

- A fresh vault seeds a reading + travel showcase — a small realistic library and trip
  log — instead of the old demo theme.

### Fixed

- The app stopped being picky about typed input: German-style decimals (1,5) are
  understood in sheet grids, hand-edited log rows, settings and the terminal-size box,
  frontmatter and Settings.md keys are no longer case-sensitive — queries, filters,
  rollups, charts, dashboards and notification schedules read Status and status alike —
  and notification times accept single-digit hours (9:00), with a hand-edited
  out-of-range lead time no longer silently stopping the reminder scheduler.
- Edge-case markdown now survives everywhere it renders: link URLs containing
  parentheses stay intact, notes saved with Windows line endings show their views and
  charts, and numbered lists that follow bullet lists keep their numbering in print. The
  food dashboard likewise reads better — under-floor days in light green instead of
  warning yellow, and the weight overlay clear against the bars.

## 0.21.0 — 2026-08-03 — Send a note as a link, and a tasks board that knows what's urgent

### Highlights

- Send as link: any note becomes an encrypted, self-expiring link you can hand to anyone
  — no account, no reader app. The relay only ever stores ciphertext (the key rides in
  the link fragment and never leaves your side), links can burn on first read or expire
  after 1–30 days, and you can point the app at your own self-hosted relay.
- The tasks board leads with urgency now: overdue, today and this-week buckets come
  first, checkboxes are visible on every row, due dates and priority edit inline,
  quick-add lives at the top, and snoozed tasks park in their own section until their
  wake day.

### New

- Hub dashboards render view fences as live database tables — the same editable views
  notes get, now on your home hub.
- A public dashboard cookbook ships with the repo: eight copy-paste recipes for boards,
  feeds and trackers, with a section on the landing page to browse them.

### Improved

- The built-in terminal grew up: drag it to the size you want, dock it at the bottom or
  the right edge, and give it its own font from Settings.
- This What's-new pane is easier to scan — group labels read as section rules and only
  headlines carry dots.
- Seeded vaults conceal the app's own files (Settings.md, agent instructions) from your
  notes list by default, and the seeded AGENTS.md now points agents at the repo docs and
  covers tasks.

### Fixed

- An update package could carry stray macOS metadata files that made some installs fail
  with "Update failed" — release packaging now strips and gates against them.

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

- The Tasks board knows what's next: a Now/Later split so today's list stays short,
  check-off straight from the board, and snooze to push a task out of sight until it
  matters.

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

- Two new dashboards: Attention surfaces the tasks that need a look, and Jobs shows
  every scheduled background task on this machine with its run history and pause
  control.
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
  portions inline (a per-100g basis plus math), and typing negative kcal logs exercise
  directly.

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
- The news feed has a refresh button that sends your curator out for a fresh sweep
  instead of waiting for the next scheduled one.

### Improved

- The sync dashboard reads as sentences — each backup leg states its finding in plain
  words, with hairline rows and ticks that stay put at any window width.

### Fixed

- Background git maintenance could repack a vault's history store; sidebar pins under a
  dashboard folder rendered twice; extracted-note titles could carry characters the
  engine refuses.

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
- A terminal HUD (⌘⇧T), a settings sheet (⌘,), and palette quick actions.
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

### Fixed

- The coding dashboard aligns lane age, behind-count, and commit age to shared rails.

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
- A coding dashboard listing your repositories sorted by what needs attention.
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

### New

- The sync dashboard became a control surface: start, inspect, and hold your backup jobs
  from the app.

### Fixed

- Sync refuses to start a run while a sweep is already in flight.
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
