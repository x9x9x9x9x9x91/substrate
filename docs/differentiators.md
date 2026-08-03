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

*Graduated 2026-08-02 from the internal register (SUB-823), which was
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
  place without copying (0.15); map any folder of notes as a database (0.18).
- **Full history, zero setup** — vendored libgit2: every vault gets complete
  git history, in-app diff/restore, restore-conflict warnings, and purge that
  is physically gone (history rewrite + `gc --prune=now` — accidents fully
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

- **Audio in databases** — waveform embeds, play buttons on database rows
  (0.18), deferred peak decode. Careful claim: Obsidian has waveform
  *plugins*; ours is native, zero-config, and lives inside database views.
- **Sheets** — plain-text formula tables: LOOKUP across sheets, SUMIF/COUNTIF
  with wildcards, SUMPRODUCT, date arithmetic, identifiers in any language.
- **Dashboards as a mini-app platform** — metrics/stat cards, charts, hub
  pages (prose + live embedded views), food/kcal tracking (quantity grammar —
  "200g oats" logs itself, weight-curve overlay), tasks (an urgency-led board:
  Overdue/Due today sections, quick-add, checkoff with a real undo, Now/Later,
  snooze round trip), news feed with agent curator, plus **workbook pages** —
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
  the relay (`scripts/handoff-relay/`) is a dumb self-hostable blob store;
  burn-after-open or 1/7/30-day expiry. No competitor has an E2E ephemeral
  share. Requires a configured relay — lead with the self-host story until a
  hosted relay exists.
- **Recurring dates in human-readable frontmatter** — `repeat: every 3
  weeks`, no RRULE anywhere; occurrences are virtual (one file, many
  instances); delete offers this-one / following / all.
- **Exports that respect the data** — note → PDF (full note, not the visible
  viewport), note → portable markdown bundle with its assets, database → CSV
  exactly as the view shows. An Ableton project-pool importer ships in
  `scripts/import-ableton.ts` (folder of .als → database, source tree
  read-only).
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
- **Hosted handoff relay**: the handoff feature is shipped; a public hosted
  relay is not. Until one exists, the self-host story leads.
- **Known parity gaps — don't invite the comparison**: multi-column page
  layout, timeline view, PDF/doc embeds (image+audio only). Undo covers
  props + structural edits, not yet everything.

## Planned (roadmap material — clearly marked, never advertised as shipped)

Tracked in the issue tracker; headline shapes: reality-mounted databases
(non-md files as database rows with extracted columns + sidecars),
materialized views on disk, vault time scrubber + time-travel queries over
git history, timestamped audio annotations, iOS
home-screen widgets, calendar subscribe (external ICS), per-fact provenance
receipts, live values in prose, deterministic file-event reflexes, voice
capture with on-device transcript, cross-type joins, units & inline math.

## Maintenance

Add a line whenever a differentiator ships or a new one is conceived; prune
anything a competitor catches up on. The site's "only here" section is the
public rendering of this file — one honest sentence per claim, shipped-only,
tongue-in-cheek-but-serious. When this file and the site disagree, this file
is the register of record; fix the site.
