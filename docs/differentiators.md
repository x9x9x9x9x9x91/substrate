# Differentiators — the "only Substrate does this" register

The living list of what makes Substrate distinct from Notion, Obsidian,
Anytype, Logseq, and friends. It feeds the public site (`site/index.html`,
"only here" section) and any outward copy.

**Rules of the register:**

- **Advertise only what's shipped.** The planned list is roadmap material,
  clearly marked as such.
- **Lockstep (same-merge update):** any merge that ships a distinctive
  user-visible capability — or lands an item from the Planned list — updates
  this file in the same merge: move planned → shipped, add the new line,
  prune anything a competitor has caught up on. Same discipline as
  `docs/vault-format.md` format lockstep; the merge isn't finished without it.
- Claims must be checkable against the repo. Every line here should survive
  "don't trust the copy — read the source".

*Graduated 2026-08-02 from the internal register, which was
reviewed that day against README, the full CHANGELOG (0.1→0.20), and current
competitor state (Obsidian Bases 1.9/1.10, Anytype, Logseq DB split,
Capacities, Affine).*

## Shipped — advertise now

### The core claims

- **Own your data, keep Notion's databases** — plain markdown + YAML; typed
  properties (select/date/url/email/phone/checkbox), relations + rollups
  (0.18), table/board/list/gallery views plus an app-wide calendar over
  every dated note, saved views, templates,
  group-by, bulk edit. Delete the app, keep everything.
- **Agent-first by design** — everything the UI does is achievable by editing
  files; external edits are first-class (live FSEvents watcher). The proof
  artifact: `docs/vault-format.md` is a 2,200+-line on-disk contract written
  for external writers/agents — layout, normalization, a concurrency
  contract, rules for well-behaved external writers — plus a
  `.vault/format.json` version sidecar (an older app can't corrupt a newer
  vault's config) and **vault doctor**, a read-only integrity report (broken
  links/relations/embeds, invalid typed values). "The second brain your AI
  can actually operate." No incumbent can claim it: Notion is cloud-walled,
  Logseq's DB version made the database canonical (the market is moving away
  from files-as-truth), Anytype/Affine store in their own formats and only
  export markdown.
- **Linear-grade speed** — instant search (SQLite FTS5), lazy paint
  (1400-row tables don't stall), keyboard-reachable everything, ⌘K palette.
- **Local reality** — link/index real files on disk; Shift-drag links in
  place without copying (0.15). **Reality mounts**: mount any folder as
  a database and every file in it is a row — no import, no copies, and no note
  written until you annotate one, at which point a single sidecar note appears
  beside it. Rows bind to files by content hash, so a rename or a move keeps
  its annotations, and a folder that isn't on this machine still renders its
  rows from the last-known index instead of disappearing. And the way back
  out: **export a saved view as a folder of links** other apps can see — a
  query like "unfinished / 128bpm" becomes a real folder for a sample browser
  or a file dialog, rebuilt on demand from the pin's menu. The folder is
  marked, holds only links, and is refused if it isn't ours, so it is always
  safe to delete and never holds your data. Obsidian sees only markdown;
  Notion and Anytype require importing a copy into their store.
- **Full history, zero setup** — vendored libgit2: every vault gets complete
  git history, in-app diff/restore, and a whole-vault time scrubber: pick any
  commit and notes, databases, dashboards, schemas, and saved views all render
  together as they were, read-only, without checking out over the live vault.
  Restore one note from there, or return to the untouched present. Purge is
  physically gone (history rewrite + `gc --prune=now` — accidents fully
  removable, not hidden). Trash parks a note/folder's surrounding config too
  (icon, pins, sidebar row); restore into a changed world yields, never
  overwrites. Vs Obsidian File Recovery: 7-day snapshots, .md/.canvas only,
  no whole-vault view; vs Notion: per-page, cloud. Plus atomic,
  power-loss-durable vault writes (temp → fsync → rename → fsync dir).
- **Local-first, no account, no cloud requirement** — sync (0.11) is
  push/pull against your own server, HTTPS + keychain token, self-hosted;
  the E2E-encrypted design is committed (see In flight). **Open source,
  AGPL** (0.19) — the trust argument Notion structurally can't make.

### The distinctive surface set (each a screenshot candidate)

- **Audio as annotatable content** — waveform embeds, play buttons on database
  rows (0.18), deferred peak decode, and timestamped comments authored by
  clicking the waveform. Markers seek on click; their file binding, timestamps,
  and text remain grep-readable markdown. Careful claim: Obsidian has waveform
  *plugins*; ours is native, zero-config, and lives inside database views.
- **A folder of audio is a playlist** — a folder view lists the loose files
  sitting next to its notes, plays the audio ones in place (nothing imported,
  nothing copied), and a persistent bottom bar keeps them playing while you
  navigate the whole app. Careful claim: the differentiator is
  *continue-while-browsing over files the app never took ownership of* —
  Notion and Obsidian both stop the audio when you leave the page, and both
  want the file inside their own store first.
- **Real cross-database lookup columns over plain files** — a `view` fence
  column can be a dotted `relation.property` path: "the release date of the
  release this mastering job points at", lined up beside the job's own
  columns and sortable by it. One hop, computed on read, rows never multiply,
  nothing written to disk — the join lives in the fence, not in a schema
  migration. Notion needs a rollup property created in the database to show
  the same value; Obsidian Bases needs a hand-written formula chain
  (`asFile()`) to reach a linked note's properties.
- **Sheets** — plain-text formula tables: LOOKUP across sheets, SUMIF/COUNTIF
  with wildcards, SUMPRODUCT, date arithmetic, identifiers in any language.
- **Live values in prose** — an inline code span of the form `` `= expr` ``
  computes from your sheets and renders as the number, inside the sentence:
  "the label has `` `= Masters.count` `` releases". Read-only and volatile —
  the file keeps the expression, never the answer, so any other markdown
  reader shows readable code and nothing rots. Notion needs a formula property
  on a database row; Obsidian needs Dataview inline queries (a plugin, and a
  different query language than its tables use). Here it's the same engine the
  sheets run, reaching into ordinary prose.
- **Units & inline math** — any note line starting with `=` computes live
  (`= 3.9M * 0.04`, per-note variables, `= sum` over the lines above), with
  real units: `= 25 USD in EUR`, `= 5 kg + 500 g`. Number columns carry units
  too — a `$` row in a `€` column converts on display and in sums, marked
  with the rate's date, while the file keeps exactly what was typed. Notion
  numbers are dumb floats; Obsidian needs a plugin stack for half of this.
  Every outbound call this rides (the rates fetch) has an off switch in
  Settings.
- **Dashboards as a mini-app platform** — metrics/stat cards, charts, hub
  pages (prose + live embedded views), food/kcal tracking (quantity grammar —
  "200g oats" logs itself, weight-curve overlay), tasks (an urgency-led board:
  Overdue/Due today sections, quick-add, checkoff with a real undo, Now/Later,
  snooze round trip, a kanban view by area with drag-to-recategorize, and a
  sort switch — urgency/priority/due/age), news feed with agent curator, plus
  **workbook pages** —
  any dashboard grows spreadsheet-style bottom tabs (sheet grid / dashboard /
  database cut).
  Machine-specific dashboard kinds exist in the author's private build and
  are deliberately not product features — the platform is the claim, and the
  cookbook (`cookbook/`) is the evidence.
- **Global capture** — ⌥Space from any app, menu-bar tray, zero-decision
  Inbox.
- **Real notifications** — date+time props fire real notifications with
  snooze, recurrence, lead-time reminders ("remind N days before"),
  DST-safe. Notes apps don't do this; task apps don't own your notes.
- **Notion importer** — pages land as notes, database rows land typed, date
  ranges survive (`start → end`). Rollups then compute over the imported
  data. The exit ramp is paved; select colors and Notion-side
  relations/rollups don't transfer yet.
- **Terminal HUD** (⌘⇧T) with PTY trust checks — a notes app that can host
  your shell.
- **Print** — dashboards/agenda produce clean paper layouts (0.18), and any
  note or database view exports as a *designed* PDF: a one-sheet (hero
  artwork + title + quiet fact rows + body — a press sheet straight from a
  release note) or a clean data listing (the CSV export's printed twin).
  Nothing fetched at export time; images come from the vault only.
- **Sync conflicts that never lose either side** — a conflicted pull
  *refuses* (conflict markers never land in a note); per file keep-mine /
  take-theirs / keep-both, conflicting frontmatter keys reported before
  choosing; a half-resolved merge survives quitting. Ships with its own
  Mac-side sync server scripts.
- **Ephemeral encrypted handoff** — right-click → Send as link: the note is
  sealed AES-256-GCM client-side, the key travels only in the URL fragment,
  the default hosted relay at `drop.substrate.zone` and the free self-hostable
  relay (`scripts/handoff-relay/`) are both ciphertext-only blob stores; the
  relay-served viewer still makes operator trust explicit;
  burn-after-open or 1/7/30-day expiry. No competitor has this client-sealed
  ephemeral share. It works out of the box without making the self-host path
  second-class.
- **Tag folders that act** — `#tags` in prose and a `tags:` prop are one
  set, and a saved tag query sits in the sidebar as a folder (chips +
  any/all + "but not …", no query language anywhere). The twist is that it
  accepts work: make a note inside one, or drag a note onto it, and the
  folder's tags are written onto the note — **nothing moves on disk**, so the
  same note can live in as many of these as it earns. Filing without a
  filing cabinet.
- **Recurring dates in human-readable frontmatter** — `repeat: every 3
  weeks`, no RRULE anywhere; occurrences are virtual (one file, many
  instances); delete offers this-one / following / all.
- **External calendars without an account** — subscribe to remote or local
  `.ics` feeds beside vault-backed dates; events stay visibly read-only, refresh
  off the UI thread, and keep the last good cache offline.
- **Exports that respect the data** — note → PDF (full note, not the visible
  viewport), note → portable markdown bundle with its assets, database → CSV
  exactly as the view shows. An Ableton project-pool importer ships in
  `scripts/import-ableton.ts` (folder of .als → database, source tree
  read-only).
- **Reflexes — the vault reacts on its own** — a plain `.vault/reflexes.json`
  turns file events into rules: a note appears, changes or leaves and the
  vault files it, tags it, fills a missing prop, spawns a companion note from
  a template, or notifies. Data, not code — a closed verb set, no scripting,
  and no delete verb (there never will be one). Off until you flip one switch
  per vault, silent when it fires, and every fire lands in a receipts log with
  `dry_run` to rehearse. Cascades stop themselves (echo window, depth limit,
  per-rule cooldown, a breaker that pauses a rule that keeps failing).
  Automation you can read in a text file and audit after the fact.
- **The long tail**: German-locale numbers, date ranges + times, board drag,
  in-place cell edit, broken-frontmatter repair dialog, URL capture with
  credential stripping + background title enrichment, tray agenda popover,
  signed/notarized release pipeline.

## Competitor cheat-sheet (for honest copy)

- **Obsidian Bases** (core, 1.9/1.10): views over frontmatter —
  table/cards/list/map, formula props, summaries. No relations/rollups, no
  board or calendar view, no typed select colors; data entry stays
  YAML-first. Everything else here (audio, sheets, dashboards, notifications,
  history depth) is plugin territory or absent. Watch: their roadmap adds
  plugin-extensible functions + a view API.
- **Anytype**: closest philosophically (local-first, E2E sync, free) — but an
  object store, not plain files; no agent/script story; thin ecosystem.
- **Logseq**: the file-based version is in maintenance mode; the DB rewrite
  made SQLite canonical. The "plain files + real databases" seat is being
  *vacated*, not contested.
- **Capacities**: cloud-based — different species. **Affine**: local-first
  but block/whiteboard-first, own format.
- **Notion**: the feature bar, but slow, cloud-owned, and agents stop at the
  app boundary (their own agents included).

## In flight — don't advertise yet

- **iOS**: the app runs on the phone and the sync round-trip is proven in the
  simulator; not yet distributed (TestFlight pipeline in progress). Say "iOS
  in development", nothing more. Real-device + real-Mac endpoint handshake is
  explicitly unverified; assets deliberately don't sync to the
  phone — notes-only.
- **E2E-encrypted sync**: the design direction is committed, not shipped —
  say "self-hosted sync today, E2E encryption is the committed design".
  Current
  transport is authenticated git-over-HTTPS with a Keychain token. Never
  market encryption as shipped.
- **Known parity gaps — don't invite the comparison**: multi-column page
  layout, timeline view, PDF/doc embeds (image+audio only). Undo covers
  props + structural edits, not yet everything.

## Planned (roadmap material — clearly marked, never advertised as shipped)

Tracked in the issue tracker; headline shapes: extracted columns on
mounted files (audio/PDF/.als analysis feeding a mount's rows — the mount
itself has shipped), time-travel queries over
git history, iOS home-screen widgets, per-fact provenance
receipts, voice
capture with on-device transcript, cross-type joins.

## Maintenance

Add a line whenever a differentiator ships or a new one is conceived; prune
anything a competitor catches up on. The site's "only here" section is the
public rendering of this file — one honest sentence per claim, shipped-only,
tongue-in-cheek-but-serious. When this file and the site disagree, this file
is the register of record; fix the site.
