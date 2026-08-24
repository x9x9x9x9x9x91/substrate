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
- **Agent-first by design — a governed contract, not a door** — everything the
  UI does is achievable by editing files; external edits are first-class (live
  FSEvents watcher). The proof artifact: `docs/vault-format.md` is a
  2,200+-line on-disk contract written for external writers/agents — layout,
  normalization, a concurrency contract, rules for well-behaved external
  writers — plus a `.vault/format.json` version sidecar (an older app can't
  corrupt a newer vault's config) and **vault doctor**, a read-only integrity
  report (broken links/relations/embeds, invalid typed values). "The second
  brain your AI can actually operate." Careful claim — *letting* an agent
  operate the store is table stakes in 2026: Bear ships an official CLI, a
  Claude connector and an MCP server; Obsidian ships an official CLI and an
  official agent-skills repo; Anytype has a local API and agent prototypes; and
  the newcomer wave (ZenNotes, note.md, Markd, VMark) is MCP-native markdown
  from day one. The depth is the differentiator: a written, *versioned*
  contract instead of an API surface, an integrity report the agent can run
  before and after itself, per-folder scoped grants, every agent write
  committed under its own author identity, and consent-gated vault kinds.
  Others open a door; this is a governed contract. What incumbents still can't
  say at all: Notion is cloud-walled, Logseq's DB version made the database
  canonical (the market is moving away from files-as-truth), Anytype/Affine
  store in their own formats and only export markdown.
- **Linear-grade speed** — instant search (SQLite FTS5), lazy paint
  (1400-row tables don't stall), keyboard-reachable everything, ⌘K palette.
- **Local reality** — link/index real files on disk; Shift-drag links in
  place without copying (0.15). **Reality mounts**: mount any folder as
  a database and every file in it is a row — no import, no copies, and no note
  written until you annotate one, at which point a single sidecar note appears
  beside it. Rows bind to files by content hash, so a rename or a move keeps
  its annotations, and a folder that isn't on this machine still renders its
  rows from the last-known index instead of disappearing.
  Mounted files are also read, not just listed: audio carries its duration,
  sample rate, channels and tags, a PDF its page count, and an Ableton
  project its tempo, track count and Live version, plus its key when the set
  states one — columns the board has because the files have them, sortable
  and filterable like any other, with no import step and nothing typed by
  hand. Read against a real pool of 94 projects spanning Live 9 to Live 12,
  every file parses, every one states a tempo and a track count, and 40
  of them name a key; the rest never chose one, and a blank cell says so. A mount can also be told
  which paths it doesn't want to see, so the dated copies Live drops beside
  every set stay off a board of sets. And the way back
  out: **export a saved view as a folder of links** other apps can see — a
  query like "unfinished / 128bpm" becomes a real folder for a sample browser
  or a file dialog, rebuilt on demand from the pin's menu. The folder is
  marked, holds only links, and is refused if it isn't ours, so it is always
  safe to delete and never holds your data. Obsidian sees only markdown;
  Notion and Anytype require importing a copy into their store.
- **Values with a shelf life** — a property can declare a review window in its
  database's schema (`review: 90d`, `yearly`), and Substrate reads the vault's
  own version history to say when each value was last set by a person: an
  `age(phone)` column beside the value in any view. It never notifies, never
  writes, and has no fix buttons — re-checking a phone number is work only a
  person can do. And it says what it cannot know: a value only ever touched by
  an import or a rule is counted as undatable rather than dated from the sweep
  that rewrote it. Notion and Obsidian can show when a PAGE was edited; neither
  can say how old one VALUE is, because neither keeps the history that would
  answer it.
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
- **Deep Recall — search everything you ever wrote, including what you
  deleted** — an opt-in second FTS index over every version of every note the
  vault's git history holds, so search reaches drafts rewritten years ago and
  notes deleted entirely. Results say where and when the text lived ("lived in
  `Masters/veilwork.md` March–June 2026, deleted in 77c0de1"), collapse the
  near-identical versions of one note into one row, and open the time scrubber
  at that moment — restore is one click further. Per vault, per device, with an
  honest first-index progress and index-size readout in Settings; sealed notes
  are never indexed, and it is text-only (assets live outside vault history by
  design). Nobody else has the substrate: Obsidian File Recovery is 7-day
  snapshots with no search, Notion's page history isn't searchable.
- **Local-first, no account, no cloud requirement** — sync (0.11) is
  automatic push/pull against your own server (push once edits settle, pull
  on open/focus/interval; conflicts always park for you), HTTPS + keychain
  token, self-hosted;
  the E2E-encrypted transport is built but unreleased (see In flight).
  **Open source, AGPL** (0.19) — the trust argument Notion structurally can't make.
- **Sealed notes and inherited private zones, unreadable even to local agents** —
  any individual note, folder subtree, or the user-note portion of a whole vault
  can become whole-file age ciphertext while neighbouring public folders stay
  plain Markdown. New, moved, restored, synced, and externally written notes
  inherit a persistent ancestor seal; the marker carries only the public age
  recipient, so enforcement never needs to cache the private key.
  Unlock is password-backed, with Touch ID/Face ID/device-presence convenience
  on Apple platforms; edits re-encrypt before touching disk. Sealed props/body
  deliberately vanish from search, databases, dashboards, sheets, links and
  diffs; sealing also rewrites the note out of local version history (a sync
  remote that already received plaintext history is a separate copy).
  Multi-file conversion resumes after interruption and purges affected
  app-owned Git history as one batch. No account and no reset means the
  recovery warning is literal.

### The distinctive surface set (each a screenshot candidate)

- **Audio as annotatable content** — waveform embeds, play buttons on database
  rows (0.18), deferred peak decode, and timestamped comments authored by
  clicking the waveform. Markers seek on click; their file binding, timestamps,
  and text remain grep-readable markdown. Careful claim: Obsidian has waveform
  *plugins*; ours is native, zero-config, and lives inside database views.
- **Every picture in the vault is searchable text** — screenshots, photos of
  receipts, whiteboard shots: their text is read on-device by Apple's Vision
  framework and kept as a plain sidecar text file beside the picture, indexed
  with everything else. Search "invoice 4711", get the screenshot, open it in
  place with the matched words marked in selectable text. Careful claims, all
  three load-bearing: zero configuration and zero cost (no API key, no model
  download, no permission prompt, nothing leaves the machine); the output is
  a text file you can read, grep and sync rather than a row in a proprietary
  index; and every sidecar's first line says **machine-read text, never
  ground truth**, so neither a person nor an agent can mistake a recognition
  for what the picture actually says. Notion's OCR is cloud-side and search
  only — you never get the text; Obsidian needs a plugin plus an external
  binary or an API key; Apple Notes reads its own attachments but only
  answers inside Apple Notes. macOS-only for now, and stated as such.
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
  The totals row is the sharp claim against Notion: a summary that describes
  one column renders in that column's cell, and Sum/Avg/Min/Max/Count are
  quick-picks over a real formula input — not the preset menu Notion's
  aggregation row limits you to. Selecting a range reports its sum, average
  and count without writing anything, and every summary edits in the grid
  while the file stays a plain markdown note.
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
- **Dashboards as a mini-app platform** — metrics/stat cards, charts,
  contribution-style **heatmaps** (a year of day squares over any date
  property of a database or sheet, `count` or `sum:`, keyboard-walkable and
  self-dating — the year is derived from the data, never declared),
  **timelines** (a database's notes laid on a horizontal date axis from their
  own start/end props — missing ends are milestones, values of a chosen prop
  become lanes, overlaps pack onto subtracks, and every bar opens its note),
  goal thermometers (a ` ```progress ` fence puts a sheet summary or a live
  database count against a target, with a pace line that only claims
  ahead/behind when the fence anchors where the line starts — no invented
  history), month grids (a ` ```calendar ` fence draws any database's date
  property as a month, recurrence expanded the way the Calendar pane expands
  it, with nothing materialized on disk), hub pages (one markdown body mixing
  prose, headings, callout card rows and live ` ```view ` / ` ```chart ` /
  ` ```progress ` / ` ```calendar ` / ` ```cards ` fences in any order — a
  dashboard composed by writing it, no code),
  food/kcal tracking (quantity grammar — "200g oats" logs itself,
  weight-curve overlay), tasks (an urgency-led board:
  Overdue/Due today sections, quick-add, checkoff with a real undo, Now/Later,
  snooze round trip, a kanban view by area with drag-to-recategorize, and a
  sort switch — urgency/priority/due/age), news feed with a pluggable agent
  curator (its ↻ runs whatever `feed-curator` command you plug in — trust-gated
  per machine, one-click setup card, agents can wire themselves in),
  repo health (every git repo under a folder you name, ranked by what needs
  doing — dirty files, stale unmerged lanes, ahead/behind — read-only and
  never networked),
  tax-year readiness (two sheets an external exporter owns become category
  totals, a checklist of the documents still owed, and a plain
  fit-to-hand-over verdict — read-only, and printable as the sheet you hand to
  whoever files),
  plus **workbook pages** —
  any dashboard grows spreadsheet-style bottom tabs (sheet grid / dashboard /
  database cut).
  Machine-specific dashboard kinds built for one vault are deliberately not
  product features — the platform is the claim, and the cookbook (`cookbook/`)
  is the evidence. The cookbook ships inside the app too: a Cookbook pane
  browses the recipes with their screenshots and installs one into the open
  vault in a click, copying plain markdown and never overwriting a note that
  is already there. No store, no account, no network — a ready-made board is
  as far away as a copy.
- **A control surface over the sync you already run** — the `sync` kind is a
  window onto an external file-sync system (a runner on a schedule, writing a
  JSON state file): per-remote freshness and free space, a run-history strip
  per leg, whether the schedule is still loaded, the log's recent errors, and
  Run / Pause / Resume. Every binding — state file, log, launchd label prefix,
  runner, per-remote staleness windows — is the note's own frontmatter, so the
  same kind fits any estate, and a missing runner disables the buttons with
  the reason instead of offering a verb that could only fail. Careful claim:
  the app copies nothing itself; the differentiator is that the *notes* are
  the configuration and the surface is one copyable file (`cookbook/sync/`).
- **A window onto the machine's scheduler** — the `jobs` kind renders every
  launchd agent under label prefixes the note names: schedule, live pid, last
  exit, a ring of recent run outcomes (launchd reports only the latest, so one
  lucky success would otherwise paint a failing week green), and per-job
  *freshness* probes that read a stamp out of another note's frontmatter — the
  check that catches a job which is green, loaded, and quietly producing
  nothing. Pause / Resume / Run now are opt-in per label and doubly gated (the
  note must list it AND the machine must hold its plist), and a machine with no
  launchd at all gets one calm line instead of buttons that could only fail.
  Careful claim: the app schedules nothing itself — launchd owns the clock, and
  the notes are the configuration (`cookbook/jobs/`).
- **Global capture** — ⌥Space from any app, menu-bar tray, zero-decision
  Inbox.
- **A palette that reaches the vault from anywhere** — the same ⌥Space that
  opens capture over any app pivots on ⌘K into a search of your notes, a jump
  to a destination in the main window, or a line filed to the Inbox, without
  switching to Substrate first. One gesture to remember, and whatever you had
  typed comes along.
- **Voice capture that stays a markdown note** — a global chord records from
  anywhere, and what lands in the Inbox is one ordinary note plus one audio
  file sharing its stem: the transcript is plain prose in the body, the
  timings are frontmatter, and the `title:` is the transcript's first line.
  Transcription runs on your machine — the speech model is an opt-in download
  in Settings, and nothing about a recording leaves the device. Absent means
  pending, so the queue is the vault itself and a crash mid-transcription
  costs nothing. The audio is device-local by design (`.assets/` is out of the
  sync leg), so a voice note syncs as searchable text everywhere and plays
  back where it was recorded. Careful claim: the differentiator is the
  *shape* — grep-readable transcript, no proprietary recording store, no
  cloud round trip — not the accuracy of the model, which is whisper's.
- **Real notifications** — date+time props fire real notifications with
  snooze, recurrence, lead-time reminders ("remind N days before"),
  DST-safe. Notes apps don't do this; task apps don't own your notes.
- **Notion importer** — pages land as notes, database rows land typed, date
  ranges survive (`start → end`). Rollups then compute over the imported
  data. The exit ramp is paved; select colors and Notion-side
  relations/rollups don't transfer yet.
- **Terminal HUD** (⌘⇧T) with PTY trust checks — a notes app that can host
  your shell.
- **Scoped MCP door** — cloud-backed desktop AI clients can operate the vault
  without receiving the whole filesystem: exact per-client, per-folder
  read/write grants in Settings, live revoke/revoke-all, hard-denied app
  config, and every AI write committed to history under its own author
  identity. Local agents still use the files directly.
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
- **The long tail**: pick-your-dialect numbers (`number-locale`, German by
  default) and dates and times (`date-locale`), date ranges + times, board drag,
  in-place cell edit, broken-frontmatter repair dialog, URL capture with
  credential stripping + background title enrichment, tray agenda popover,
  signed/notarized release pipeline.

## Competitor cheat-sheet (for honest copy)

- **Obsidian Bases** (core, 1.9→1.12): views over frontmatter —
  table/cards/list/map, formula props, grouping + summaries, per-view search,
  and, since 1.10, a plugin API for custom view types. The old "watch" item
  landed, so drop the roadmap hedge. Still no native relations/rollups — the
  documented workaround is `file()`/`asFile()` formula chains, which their own
  docs admit are slow and don't refresh — no board or calendar view, no typed
  select colors; data entry stays YAML-first. Everything else here (audio,
  sheets, dashboards, notifications, history depth) is plugin territory or
  absent. Compare on the relational half, not the view half: the database
  claim holds, the "no view API" one no longer does.
- **Anytype**: closest philosophically (local-first, E2E sync, free) — but an
  object store, not plain files; no agent/script story; thin ecosystem.
- **Logseq**: the split is now official. Logseq 2.0 beta shipped 2026-07-13
  with SQLite canonical, and the file-based version was formally spun off as
  "Logseq OG" in maintenance. The "plain files + real databases" seat is
  *vacated by announcement*, not merely by direction — safe to say outright.
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
- **iOS home-screen widgets**: WidgetKit dashboard tiles are code-complete —
  any metrics card as a glanceable, honestly-timestamped widget, values
  exported only for cards a placed widget references — but device-unverified
  and undistributed. Rides the iOS lane above; same "in development" line.
  (Obsidian mobile has no widget story; Notion's widgets are cloud-bound —
  this one reads the last-synced local vault.)
- **Dashboards you (or your agent) can write, without a plugin store** — a
  `dashboard:` value can name a folder of code living in the vault itself
  (`.vault/kinds/<id>/`: a manifest plus an ES module with one `mount(el, ctx)`
  entry point). It syncs with the vault like any other file, so a kind written
  on one machine is there on the next one, and an agent can author one by
  writing two files — the cookbook ships a worked one (`cookbook/week-numbers/`),
  bundle and board together, installable in a click. Consent is the whole
  design: nothing in the vault runs until you read a review of it — what it is,
  who wrote it, which files, what it can reach — and press enable, and that
  consent is pinned to those exact bytes, per vault and per device. Change a
  byte and it stops and asks again; a standing "trust updates to this kind"
  rider can only ever be granted after the first yes, never as part of it.
  Settings → Kinds lists everything this vault has been told to run and takes
  it back without deleting anything. Obsidian plugins are global to the app,
  installed from a store, and unsandboxed with no per-file consent; Notion and
  Anytype have no local code path at all. Rides the public release line:
  public-build users get it with the next release — until a
  release carries it, say "landing", never shipped.
- **E2E-encrypted sync**: implemented end to end — encrypted blob-store
  transport (XChaCha20-Poly1305 per object, Argon2id passphrase wrap), an
  open-source single-tenant server, and a `blob+https://` remote type in the
  Sync pane — but not yet in a shipped release or verified against a real
  vault. Until a release carries it, keep saying "self-hosted sync today,
  E2E encryption landing"; never market encryption as shipped before then.
- **Hosted handoff relay**: the handoff feature is shipped; a public hosted
  relay is not. Until one exists, the self-host story leads.
- **Same eyes — the evaluated view, headless**: `view-read` prints a saved
  table view exactly as the app paints it (same rows, same order, same
  computed cells) as JSON or markdown, from the app's own evaluator rather
  than a re-implementation, with a versioned contract chapter
  (`substrate.view/1`, vault-format.md §7b). This is the claim no
  CLI-shipping competitor can follow — Obsidian's CLIs and Bear return files
  and search hits, Bases evaluation is app-locked, Notion's API returns
  records and never the view as configured. **Not yet advertised**: it covers
  saved TABLE views only, and the MCP-door method (the half an agent reaches
  without a shell) is not built. Move this to "The core claims" once both are
  true; the honest sentence then is "you and your AI look at the same
  board."
- **Known parity gaps — don't invite the comparison**: multi-column page
  layout, PDF/doc embeds (image+audio only). Undo covers
  props + structural edits, not yet everything.

## Planned (roadmap material — clearly marked, never advertised as shipped)

Tracked in the issue tracker. Two of the shapes that used to sit here have
since shipped and moved up: per-fact provenance receipts (0.23) and
time-travel queries over git history — `AT()`, `PROP()` and the chart
`history:` source (0.23), with search over the past following in 0.25. What
remains planned here: cross-type joins.

## Maintenance

Add a line whenever a differentiator ships or a new one is conceived; prune
anything a competitor catches up on. The site's "only here" section is the
public rendering of this file — one honest sentence per claim, shipped-only,
tongue-in-cheek-but-serious. When this file and the site disagree, this file
is the register of record; fix the site.
