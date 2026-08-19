# Vault format — the agent-facing contract

The vault is a folder of plain markdown files plus a few hidden support directories.
The one deliberate exception is a note the user explicitly **seals** (§2a): it keeps
its `.md` path but stores age ciphertext until the user removes the seal.
Any agent can read and write it correctly using only this document — no app code
required. Every rule below is verified against the engine; when this doc and the
code disagree, the code wins and the doc gets fixed (see AGENTS.md: format changes
update this file in the same merge).

Sources of truth: `src-tauri/src/vault/` (engine — `Engine` façade in `mod.rs`,
plus the `schema`, `views`, `search`, `trash`, `assets`, `mounts`, `foldersync`, `watch`,
`doctor`, `seed`, `sealed` modules), `src-tauri/src/lib.rs` + `src-tauri/src/commands/` (IPC),
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
vault there could never load). A copy from before that move
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
├── Dashboards/                # optional — when present it IS the dashboards home (§5.2)
├── <any folders>/             # notes organize themselves; folders are just paths
│   └── .substrate-seal        # optional inherited folder seal marker (§2a)
├── .claude/skills/            # agent skills, seeded + user-written (§12)
├── .assets/                   # embedded binaries, flat (§9)
├── .trash/                    # deleted notes + folders, recoverable (§10)
├── .vault/                    # format.json + schema.json + views.json + folders.json + calendars.json + mounts.json + mounts/ + notifications.json + jobs-exit.json + sealed-key.age + templates/ + kinds/ + backup/ (§2a, §5b–§8)
├── .substrate-seal            # optional vault-wide inherited seal marker (§2a)
└── .git/                      # version history, owned by the app (§11)
```

**The hidden rule**: any path component starting with `.` is invisible — never
indexed, searched, or watched (`vault/mod.rs` `hidden_rel`, `walk_md_files`). That
covers `.assets/`, `.trash/`, `.vault/`, `.git/`, and any `.foo/` you add
yourself. The `.substrate-seal` policy marker is the sole dotfile watcher
exception: it is never a note, but creating, changing, or removing one triggers a
scope reconciliation. Only `.md` files are notes; binary files (containing NUL) are skipped,
invalid UTF-8 is read lossily. One explicit-path exception: `.vault/templates/`
(§7) stays unindexed but can be read and written directly.

**Loose files are visible without being indexed**: a folder view
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
  always this lenient; WRITES are not: a present block that fails to
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
  list of maps, §5.4).

### What the engine preserves vs normalizes

- **Body edits** (`vault_write_body`) preserve the frontmatter block **byte-verbatim**
  — order, quoting, comments — and replace only the body. A write to a **missing
  file fails** (`note no longer exists`) rather than resurrecting it body-only
; the `.vault/templates/` lane (§7) is the one create-through-write
  exception. The optional `expectedBody` argument is an optimistic-concurrency
  guard: when passed, the write is rejected with
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
  existing block is unparseable or has duplicate keys (§2) — a broken
  block is never silently normalized away.
  Never depend on key order, comments, or hand-tuned quoting in frontmatter.
- The app's prop editor only *authors* strings — the note menu's calendar opt-out
  is the one bool it writes. Numbers reach the write path on the read side only:
  `vault_set_prop` hands back the raw prior value, and undo writes that same
  scalar back, so the write domain has to accept everything the read
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
  write, move, or link rewrite (`vault/mod.rs` `validate_note_title`): a
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
| `calendar` | `false` hides the note from the calendar (§4/§12); absent or any other value shows it |
| `url` | source link on `type: reference` notes |
| `artwork` | gallery cover: bare asset name, absolute/`~/` path, or `![[...]]`/`[[...]]` wrapper |
| `dashboard` | dashboard renderer key on `type: dashboard` notes (§5.2) |
| `icon` | dashboard sidebar icon override (§5.2): a curated glyph id or an emoji |
| `cards` | card list for the metrics dashboard and the tax board (§5.4) |
| `claimed_usd` | yield dashboard: cumulative claimed total, set by the Claim button (§5.3) |
| `log`, `db`, `weight`, `floor`, `ceiling` | food dashboard config: log-sheet, food-DB and weight-sheet names, net-kcal band (§5.2) |
| `root` | coding dashboard: the folder of projects to scan, one level deep — `~/…` expands, an absolute path is taken as given, a bare name reads against your home folder (and can't climb out of it), and absent means `~/Coding`. Denied stores render the empty state (§5.2) |
| `items`, `curated` | feed dashboard config: items-sheet name, and the curator's own last-run stamp, rendered verbatim (§5.2) |
| `index`, `scanned` | music-work dashboard config: work-index sheet name, and the scanner's own last-run stamp, rendered verbatim (§5.2) |
| `sheet`, `missing`, `stale_hours` | tax dashboard config: aggregates-sheet and missing-evidence-snapshot names (by title/stem, defaulting to `Tax 2026` and `Tax Missing`), and the age past which the snapshot stops being trusted — a positive number of hours, default 240. Its cards come from `cards:` like any other board (§5.2) |
| `exported` | tax dashboard: the missing-evidence snapshot's own export stamp, written by whatever regenerates it — ISO 8601 with a timezone (§5.2) |
| `areas`, `stale_days` | tasks dashboard area allowlist and stale-age threshold (§5.2) |
| `view`, `sort` | tasks dashboard layout (`list`/`board`) and ordering (`urgency`/`priority`/`due`/`age`) (§5.2) |
| `now`, `snoozed_until` | tasks board: pinned to the focus section / parked until a wake day, both board-scoped (§5.2) |
| `stale` | tasks board: `never` exempts one task from age chips for good (§5.2) |
| `captured`, `duration`, `transcribed` | voice notes: recording start (full ISO datetime, text), length in seconds, and the datetime the transcript landed — absent means pending, `unavailable`/`failed` are the two non-datetime answers (§5.11) |
| `tags` | tag list, unioned with the body's inline `#tags` (§3b) |

Everything else is yours. Unknown props are preserved and shown as chips.

## 2a. Sealed notes — whole-file age ciphertext

A user may seal an ordinary note from its note menu. The path and `.md` suffix do
not change, so the filename (and therefore its folder and filename-derived title)
remain visible. Every byte that used to be inside the file — YAML frontmatter and
Markdown body together — is encrypted. The on-disk shape is binary:

```text
SUBSTRATE-SEALED-1\n
<age-encryption.org/v1 binary payload>
```

The payload uses an age X25519 recipient (`age`/`rage` compatible). One random
identity belongs to the vault. Its private string is never stored in the vault in
clear:

- `.vault/sealed-key.age` starts with `SUBSTRATE-SEALED-KEY-1\n`, followed by an
  age scrypt payload containing the identity. The password is chosen on first use,
  is not stored, and has no account/reset path. Losing the password and every
  authorized device copy makes the sealed bytes unrecoverable.
- The key file is deliberately committed to the vault's own Git history and rides
  vault sync like any other file — that is how the recovery copy reaches other
  devices. Consequence: whatever remote you sync to holds an offline-attackable
  scrypt blob, and the password is its entire defense there. Pick it accordingly.
- On macOS/iOS, Substrate may also store the identity in the non-synchronizing data-
  protection Keychain with a **user presence** access control. Reading that copy
  requires Touch ID, Face ID, or the OS device credential. Failure to enroll this
  convenience copy does not weaken or invalidate the password-protected vault copy.
- On macOS the data-protection keychain needs an entitlement that only a build
  with an embedded provisioning profile may claim, so builds without one use the
  legacy file keychain instead (SUB-1103). Honest cost: the legacy item has no
  per-item device-lock gating — it lives in the login keychain, readable while
  that keychain is unlocked, rather than only while the device is unlocked. The
  user-presence requirement still applies, so reading it still asks for Touch ID,
  Face ID, or the passcode. See the macOS release runbook.

Locked sealed notes index only `path`, filename stem/title, folder and mtime. Their
props and excerpt are empty; their body produces no FTS terms, links, backlinks,
relations, calendar entries, database membership, dashboard data or sheet data.
That is the feature: an agent or script walking the vault sees the filename and
ciphertext, never note content. The app also hides history/diff and plaintext export
actions while locked (history/diff stays unavailable for a sealed note).

Sealing also purges that note (including earlier names) from the app-owned local Git
history, expires reflogs, prunes the old blobs, and snapshots the ciphertext as its new
version 1. Without that rewrite, `.git` would remain a plaintext side door for agents.
A vault that is itself a user-owned Git repository is therefore refused rather than
rewritten behind the user's back. A sync remote or other clone that already received
the plaintext history is a separate copy and must be cleaned/replaced separately; the
local UI states this before sealing.

Unlocking decrypts only into app memory. The file stays ciphertext while it is viewed
and edited; body and property writes encrypt the complete replacement in memory
*before* the atomic temp-file write, so no plaintext sidecar or temp file lands on
disk. Leaving the note (or choosing **Lock now**) drops its in-memory identity.
**Remove seal** is the sole operation that deliberately writes the complete note
back as ordinary Markdown. It is refused while the note inherits a persistent
folder/vault seal.

### Persistent folder and vault seals

A directory may contain `.substrate-seal`; at the vault root it protects the
whole vault, and inside an ordinary folder it protects that subtree. The UTF-8
JSON marker is versioned and contains no private material:

```json
{
  "version": 1,
  "state": "active",
  "recipient": "age1…"
}
```

`recipient` is the public half of the same vault X25519 identity described
above. That is deliberate: the app, watcher, sync adoption and a cooperating
external writer can encrypt a newly arrived plaintext file without loading the
private identity or displaying a biometric/password prompt. Decryption still
requires the password-protected identity or an authorized device key. iOS uses
the same marker, recipient and private-key architecture; Face ID is only an
unlock convenience, never an encryption prerequisite.

A marker only takes effect on a device that has **confirmed** it (SUB-889).
Writing `.substrate-seal` is otherwise an unauthenticated instruction to
re-encrypt a whole subtree to the recipient in the file *and* to purge the
matching plaintext out of local history — so a sync pull, a shared folder, or
anything that can write one file could redirect a vault's encryption and
destroy its local history. The gate:

- `.vault/seal-trust.json` records the (scope path, recipient) pairs this
  device confirmed. It is listed in the history exclude set, so it is never
  committed and can never arrive by sync — a confirmation cannot be forged from
  outside the machine.
- An unconfirmed marker is inert: nothing inherits it, no file is converted, no
  history is purged, and a pending conversion journal that names it is refused
  at startup. It surfaces in the UI as **Confirm seal…** / **Reject seal** (in
  Settings for a root marker), and confirming requires the vault's Touch ID or
  password. Confirmation is refused outright when the marker's recipient is not
  this vault's own key.
- The confirmation travels with its folder through rename, move, trash and
  restore, and is dropped when the folder is permanently deleted or the marker
  is removed. It is keyed on the exact (scope, recipient) pair and is dropped
  again the next time the app lists seals and finds the marker gone, so a
  marker deleted outside the app cannot leave a confirmation lying around for a
  later re-planted one to inherit.
- The gate fails **open**, deliberately. An external writer that deletes a
  confirmed marker, or overwrites it with a different recipient, downgrades that
  scope to unconfirmed: the pair no longer matches, so enforcement stops and new
  plaintext in the folder stays plaintext until the user confirms again in-app.
  That is a denial of protection, not a disclosure of anything already
  encrypted — existing ciphertext stays encrypted and readable only with the
  original key — and it is inherent to an unauthenticated marker. Signing
  markers is what would close it.
- The cost is deliberate: an external writer can no longer *establish* a seal,
  only honour one. Signing markers with the vault key would restore that and
  remains open as a later hardening layer; it is not what this gate does.

Inheritance is conservative:

- Any `.substrate-seal` on the path from the vault root through the note's
  parent directory requires ciphertext. A sealed ancestor wins. Nested markers
  must carry the same vault recipient.
- Sibling subtrees may therefore be mixed: `Private/.substrate-seal` does not
  affect `Public/`. There is no plaintext exception inside `Private/`; **Remove
  seal** is refused there. To opt out, stop/remove the outer inheritance or move
  the note outside it first. Removing a marker never decrypts existing files.
- `Settings.md`, `AGENTS.md`, and `CLAUDE.md` are operational boot/orientation
  files rather than user notes and remain plaintext even under a root marker;
  the app and external agents need them before any private key is authorized.
- A root marker protects managed note files, not every byte below the vault
  directory. Hidden operational/recovery stores are outside the conversion
  walk: `.assets/` binaries, `.vault/templates/`, and parked `.trash/` content
  remain in their existing storage form. A plaintext trashed note is encrypted
  (and its prior note history purged) when it is restored into a sealed scope.
  Do not describe a root seal as encrypting assets, templates, or trash.

Creating a persistent seal is an attended multi-file conversion with a durable
interruption protocol:

1. The command refuses before mutation when the vault is a user-owned Git
   repository or app-owned history cannot be opened.
2. `.vault/seal-conversion.json` is atomically written with the scope, public
   recipient and every path whose plaintext history must be purged. The scope
   marker is then written with `state: "pending"`.
3. Each `.md` file is encrypted independently through the normal atomic
   temp → fsync → rename → directory-fsync write. The journal is extended
   *before* each conversion.
4. App-owned Git history purges all converted paths in one rewrite. Only after
   that succeeds does the marker atomically change to `"active"`; the journal
   is removed and ciphertext is snapshotted as the new baseline.

Power loss at any prefix is therefore resumable, not rollback-shaped. On the
next launch, before IPC, watcher, or auto-snapshot threads start, the public
recipient encrypts any remaining/new plaintext, the batch history purge is
retried, and the active marker commits. A repairable history failure leaves the
pending marker and journal in place and reports that the conversion is not yet
complete; it never advertises a completed privacy boundary. Already converted
files remain valid per-note ciphertext throughout.

Once a marker is confirmed and pending or active, app creates, note/folder moves, trash
restores, sync checkouts, full rescans and watcher-observed external writes all
run inherited enforcement before indexing the note. A genuinely external
writer necessarily creates plaintext first; the watcher replaces it with
ciphertext after the filesystem event/debounce. Failure to replace it (damaged
marker, permissions, disk error) omits the note from the app index and raises a
visible `vault:seal-degraded` warning — never a silent plaintext success.
Well-behaved writers should read the ancestor marker and encrypt to its public
recipient before their own atomic rename, eliminating even that watcher window.

History and sync retain the same honesty boundary as per-note sealing. The app
rewrites only its own local Git repository. A sync remote, another clone, backup,
or user-owned repository that already contains plaintext is a separate copy and
must be cleaned/replaced separately; a local marker cannot truthfully claim to
erase it.

External-writer contract:

- Detect the exact magic line before treating a `.md` file as text. Do not run a
  lossy decoder, frontmatter normalizer, formatter, link rewriter or merge driver
  over the remaining bytes.
- Copying, renaming, syncing and versioning the opaque file byte-for-byte is safe.
  Content-aware diffs and merges are intentionally unavailable while sealed.
- Do not modify `.vault/sealed-key.age`. It is the user's password recovery path,
  not disposable cache. Back it up with the vault as opaque bytes.
- Before creating or replacing a note, inspect `.substrate-seal` at the vault
  root and every ancestor directory. A pending marker enforces ciphertext just
  like an active one. Encrypt to its public `recipient`; never invent a second
  recipient inside the same vault. Writing a *new* marker is not a way to seal a
  vault: the app ignores one it has not confirmed locally (above), so the user
  has to accept it in-app before it means anything.
- Do not edit or delete `.vault/seal-conversion.json`. It is the resumable
  transaction record for an attended conversion, not disposable cache. It is
  device-local and excluded from app-owned Git history and sync; only the
  public `.substrate-seal` marker travels between devices.
- Do not write, copy or sync `.vault/seal-trust.json`. It is this device's
  record of which markers its user confirmed; a copied one would hand an
  external writer back the ability to seal and purge. Like the journal it is
  excluded from app-owned history and sync.

## 3. Links and embeds

### Wikilinks

`[[Target]]` in the body. The grammar is exactly `\[\[([^\[\]]+)\]\]` — no nested
brackets. The inner text is `target#anchor|alias`, all three parts optional
(SUB-1095):

- The **alias** is everything past the **first** `|` — the display text. It is
  prose, not a name: a later `|` or `#` inside it is just more prose.
- The **anchor** is a `#` tail on what's left — a heading inside the target note,
  or `#^id` for a block ref. `[[#Heading]]` (empty target) points inside the note
  that carries it and is **no link edge at all**.
- Every part is trimmed. One parser, two copies: `split_wikilink`
  (`vault/mod.rs`) and `parseWikiLink` (`src/lib/wikilinks.ts`) — **keep them in
  step**, or the app follows a link the engine never indexed.

- Resolution (`vault/mod.rs` `resolve_link`): the **target alone** — anchor and
  alias stripped first — trimmed and matched **case-insensitively** against each
  note's `title` **or** stem. Title-vs-stem is one test, not two phases; if two
  different notes could claim a target (one by title, one by stem) the winner is
  unspecified — keep titles and stems unique.
- What a link **shows** is the renderer's business, never the index's: the alias
  when the author wrote one, else `target#anchor` as one label. Editor, dashboard
  cards, table cells and print all go through `wikiLinkDisplay`.
- Following a link with an anchor scrolls to that heading (literal match,
  case-insensitive, fences skipped); an anchor no heading answers to leaves the
  note at the top rather than jumping somewhere arbitrary.
- **Rename moves the target only.** The anchor and the author's display text ride
  along untouched: `[[Old#Notes|the book]]` becomes `[[New#Notes|the book]]`.
- An unresolved target that matches a **database name** (case-insensitive)
  opens that database view instead — hub pages link to databases with plain
  wikilinks. This is app-side navigation only; the engine still reports the
  link unresolved.
- Following a link unresolved by both tests creates the note (that's how
  `Sketchpad` works, §12).
- Only body text is scanned — frontmatter never produces links. Backlinks use the
  same title/stem matching.
- **Literal code is not link syntax**: a link inside a fenced block
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

- The target may carry a **display modifier** past the first `|` —
  `![[cover.png|300]]`, `![[cover.png|300x200]]`, `![[cover.png|left]]` — the
  size/layout hint of the Obsidian dialect these vaults are written in. It is
  stripped before resolution, so the target is `cover.png` everywhere —
  rendering, the doctor, export bundles and the `.assets/` orphan sweep alike.
  One parser, two copies: `embed_target` (`vault/mod.rs`) and `embedTarget`
  (`src/lib/wikilinks.ts`). Unlike a wikilink, an embed does **not** split on
  `#`: filenames and paths may contain one, and an embed has no anchor. A file
  whose name genuinely contains `|` is therefore unreachable by an embed — the
  grammar spends that character on the modifier.

- **Size modifiers are honoured; layout modifiers are not.** The modifier's
  grammar, parsed by `embed_size` (`vault/mod.rs`) / `embedSize`
  (`src/lib/wikilinks.ts`) — the same twin-parser arrangement:

  | modifier | meaning |
  | --- | --- |
  | `\|300` | max width 300 px, aspect ratio preserved |
  | `\|300x200` (or `300X200`) | fit inside a 300×200 box, aspect ratio preserved |
  | `\|left`, `\|right` | **parsed and ignored** — Substrate commits to no text-wrap layout |
  | anything else (`\|axb`, `\|300x`, `\|0`, `\|-3`, empty) | parsed and ignored |

  Sizes render as CSS **caps** (`max-width`/`max-height`), never fixed
  dimensions, so an image still shrinks to fit a narrow window or page and is
  never distorted; a `WxH` box contains rather than stretches. Values are
  clamped to `[1, 4096]` px — an absurd number degrades to a big image, never a
  broken one. A multi-part modifier is read segment by segment and the first
  size wins, so `![[cover.png|300|left]]` renders at 300 px. **No modifier is
  ever an error**: whatever it says, the embed still resolves and still renders.
  Nothing is stored — the size lives in the note text and nowhere else. Applies
  to image embeds on all three surfaces (editor, hub dashboards, print/PDF);
  audio players, file chips and the one-sheet hero image ignore it — the hero
  is a hoisted layout slot that owns its own dimensions.

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

#### Timestamped audio annotations

A standalone audio embed may be followed immediately (with at most one blank
line) by an `annotations` fence bound to that exact embed target:

````markdown
![[bounce.wav]]

```annotations
audio: bounce.wav
01:23 — bass too woody
02:10 — fixed the build
```
````

- `audio:` is required and must exactly equal the preceding embed target — the
  target after any display modifier is stripped, so `![[bounce.wav|left]]` still
  binds to `audio: bounce.wav`. This
  keeps comments pinned to the named file instead of drifting onto a nearby
  player; replacing that file with a new bounce does not retime old comments.
- Annotation lines are `mm:ss — text`; minutes may exceed 59. The reader also
  accepts `h:mm:ss`, an optional list dash, and an ASCII `-` separator, while
  app-authored lines use the canonical form above. Blank lines are ignored.
- A fully valid block renders as markers over the waveform plus a chronological
  list beneath it. Clicking either seeks; clicking an un-dragged waveform point
  opens a composer at that time. The composer appends one line and never
  rewrites earlier annotations. On disk, new lines therefore stay in creation
  order; the rendered list sorts them chronologically. “Edit source” reveals
  the ordinary markdown.
- A mismatched, malformed, or unclosed block stays visible as raw source. This
  fail-open rule prevents the UI from hiding data it cannot round-trip. While
  such a fence follows an audio embed, that player remains seekable but does not
  offer the composer; repair or remove the raw fence before adding annotations,
  so existing comments can never be stranded behind a newly inserted fence.

### Editor conveniences

Three affordances in the editor write **ordinary markdown**, not a Substrate
grammar. They are listed here because the toolbar and the selection menu offer
them, not because the format gained anything: a note carrying them opens
unchanged in any other markdown editor, and an external writer that produces
the same text gets the same rendering.

- **Strikethrough** — `~~text~~`. The toolbar's `S` toggles the delimiters
  around the selection, adding them or stripping them back off, exactly as the
  bold and italic buttons do with `**` and `*`. The editor draws the span
  struck through and printing emits `<s>`. Nothing else treats it specially:
  the text inside stays ordinary prose, so a wikilink or a `#tag` written
  inside struck text still indexes and still counts.
- **Inline links** — `[text](url)`, standard markdown, for destinations
  **outside** the vault. A link to another note is a wikilink (above), and
  only wikilinks are graph edges — a markdown link to a note is not a
  backlink, not a rename target, and not a `broken-link` finding. The
  toolbar's `link` wraps the selection and seeds the destination with a bare
  `https://`, left selected so the real URL is typed straight over it: what
  it inserts is a link the author has not finished, not a live one. Pressed
  again with a whole link selected, it unwraps back to the label. A rendered
  link follows a plain click and opens in the OS browser; on the line being
  edited, where the raw syntax shows, a plain click only places the cursor
  and ⌘-click follows.
- **Extract selection into new note** — the selection menu's action, whose
  output is a wikilink. The selected chunk becomes a NEW untyped note in the
  SAME folder as the note it came from, and the selection is replaced in
  place by a `[[link]]` to it. The proposed title is the selection's first
  non-blank line with block marks (hashes, bullets, quote chevrons, callout
  headers) and inline marks stripped, whitespace collapsed, sentence-final
  punctuation dropped, capped at 60 characters and cut back to a word
  boundary when one sits in the second half of that span; an empty or
  all-marks selection falls back to `Untitled`, and the engine's own
  create-time sanitize and dedupe (§2) may adjust it again — the link is
  always written from the created note's REAL title, never the proposed one.
  If the note is switched away or the text moves while the create is in
  flight, the new note still lands and a toast says so: the extraction is
  never silently lost, only left unlinked.

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
| ` ```…#demo…``` `, `` `#demo` `` | fenced blocks and inline code — literal code is not tag syntax, the same rule links follow (§3). An unclosed fence swallows the rest of the body |

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
the sidebar even with zero notes — that's what "New database" writes.

On disk the key stays `type:`; the UI presents it as “Database” (Option A).

Database management (all engine-side, all guarded against
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
starts: '2026-07-19 14:30'             # a date may carry a 24h time (§6)
trip: 2026-09-01/2026-09-21            # a date may be a range: start/end (§6)
contract: ~/Documents/deals/SMP-30.pdf # file-kind prop: link only, target never touched
rating: 4                              # number (UI shows JSON text)
in use: true                           # checkbox-kind prop (§6): YAML bool — checked
price: 1299.50                         # number-kind prop (§6): stays exactly this scalar — format is display-only
tags: [vinyl, promo]                   # list (JSON text in the UI — a schema'd multi-kind prop, §6, renders dotted values instead)
```

- Dates are `YYYY-MM-DD` strings, optionally suffixed with a space and
  `HH:MM` (24h — `2026-07-19 14:30`; a single-digit hour — `9:30` —
  is accepted on input and read as the padded form). Readers also
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
  (bool or the string `"false"`) is hidden from the calendar entirely.
- A date may also be a **range**: two of those values joined by `/`, the
  ISO-8601 interval form — `2026-09-01/2026-09-21`, or with times,
  `2026-09-01 09:00/2026-09-03 17:00`. There is no separate prop
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

Language matching follows what each parser reads. The live-dispatch languages
(` ```view `, ` ```chart `, ` ```cards `) match on the info string's FIRST WORD,
case-insensitively — ` ```View ` and ` ```CHART compact ` render as widgets like
their bare lowercase forms, and their contents stay out of the search index the
same way. The strict bare-form languages (` ```csv `, ` ```formulas `) match the
exact lowercase opener with no tail: ` ```CSV ` parses as nothing, renders as an
ordinary code box, and stays searchable prose.

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
- **Blank lines inside the formulas fence are meaningful**: they split
  it into blocks, and the app's summary bar shows the first block holding
  summaries while later ones collapse behind a toggle. Purely presentational —
  evaluation, classification and bindings ignore the grouping — but a writer
  reordering a fence should know the blank lines carry intent. The example
  above is the idiomatic shape: computed columns, blank line, totals.
- Cross-sheet references: `Holdings.total`, quoted when the name has spaces
  (`"Portfolio Tracker".total`); resolved by note title/stem, case-insensitive.
- The full formula language (aggregates, `IF`, `ROUND`, `FX`) is specified in
  `docs/sheets-spec.md` — don't duplicate it here.
- `FX("USD","EUR")` uses the frankfurter.dev rate, cached app-side
  and refreshed live — the app never writes fx props into notes.

**Per-column notifications — the `columns:` prop (SUB-876).** A sheet has no
schema (`type: sheet` is functional, §6), so a date column that should fire a
notification says so in the note's own frontmatter, under a `columns:` map keyed
by header name:

```yaml
---
type: sheet
title: Subscriptions
columns:
  Renewal: { notify: true, notifyBefore: 7 }
---
```

- The two words are §6's: `notify: true` fires on the day the cell's date lands,
  `notifyBefore: n` (1..365, clamped) fires `n` days ahead as well. An entry
  carrying neither is removed, and the map with it when it was the last one.
- Header names bind **case-insensitively** on both sides — a column headed
  `Renewal` answers to a `renewal:` key — and a write keeps whichever spelling
  is already on disk rather than restamping it.
- Only cells that parse as a date fire; everything else in the column is
  ignored, so one date column in a sheet of text is fine.
- The app writes this map through its own command (`sheet_set_column_notify`),
  not the scalar prop write — the value is nested, which `vault_set_prop`
  refuses. Hand-editing works the same; entries that don't parse are dropped
  without hiding the rest.
- What fires, and how a click gets back to the row, is the notification key
  grammar under `.vault/notifications.json` below.

### 5.2 Dashboards — `dashboard:` key

A dashboard is `type: dashboard` with a `dashboard` prop naming the renderer:

```yaml
---
type: dashboard
dashboard: yield-apr
created: 2026-07-17
---
```

Where the row lives: a dashboard note may sit in any
folder, and its PATH decides which sidebar surface shows it. The app picks a
"dashboards home" — a top-level `Dashboards/` folder is it whenever the vault has
one, no matter how many dashboards live elsewhere; a vault without that folder
falls back to inferring one, the folder whose subtree holds the most dashboards
(ties break to the shallowest path, then alphabetically) — and gives the
Dashboards section the ones inside it: directly in
home flat, one level of subfolders as collapsible groups (deeper nesting folds
into its first segment). A dashboard in any OTHER folder renders as a row inside
that folder's node in the Folders tree instead, beside its databases and pinned
notes; dragging it between folders (or onto the Dashboards header) moves the
file and hands it to the other surface. No dashboard renders on both
(`src/lib/sidebar.ts` `splitDashboards`). Notes at the vault root and inside the
hidden surfaces (`Journal/`, `Dashboards/`) have no tree row to nest under, so
those always stay section rows.

Sidebar icon: each dashboard row renders a curated per-kind glyph
(`src/lib/dbicons.ts` DASHBOARD_ICONS — `food`, `metrics`, `yield-apr`, `hub`,
`feed`, `music-work`, `tasks`, `sync`, `coding`, `jobs`, `tax`,
plus any machine-specific kinds this build carries); an `icon:` prop overrides
it (a curated glyph id, anything else treated as an emoji), and kinds without a
mark keep the generic chart glyph. The curated glyph ids (`src/lib/dbicons.ts`
`GLYPHS`): `music`, `mic`, `disc`, `sliders`, `wrench`, `check-square`,
`calendar`, `cart`,
`book`, `bookmark`, `heart`, `star`, `home`, `folder`, `archive`, `inbox`,
`pen`, `tag`, `image`, `user`, `users`, `globe`, `pin`, `coffee`, `leaf`,
`bulb`, `zap`, `clock`, `briefcase`, `gift`, `camera`, `code`, `dumbbell`,
`wallet`, `gamepad`, `plane`, `database`, `chart`, `grid`, `shirt`,
`utensils`, `flame`, `download`, `refresh`.

Dispatch (`src/components/DashboardPane.tsx` `DashboardBody`) — a fixed key set.
These public kinds are dispatched: `metrics` → the metrics cards renderer (§5.4);
`yield-apr` → the yield tracker (§5.3); `hub` → the hub renderer (below);
`food` → the food log tracker (below); `feed` → the curated newsfeed (below);
`music-work` → the work-index board (below); `tasks` → the task attention
board (below); `coding` → the repo-health table over the scan root its `root:`
prop names (default `~/Coding`); `tax` → the tax-year readiness board (below);
`charts` → the chart-fence dashboard (§5.5), whether or not the body actually
holds a fence; `sync` → the sync control surface (below); `jobs` → the launchd
jobs pane (below).
**A missing `dashboard` prop looks at the body** — one or more ` ```chart `
fences makes it a charts dashboard (§5.5), none falls back to the yield
tracker. So a charts dashboard needs no specific key, just the fences;
`dashboard: charts` says the same thing by name.
One or more ` ```calendar ` fences makes it a calendar dashboard (§5.5c) the
same way, and needs no specific key either.

**Any other value renders an error card** naming the value and listing the
kinds this build does dispatch — the quiet inline posture a ` ```view `
fence over an unknown database takes. A typo is never answered with a different
dashboard: falling through to the yield tracker meant `dashboard: yeild-apr`
silently rendered a financial tracker, snapshot form included, with no hint
that the key was wrong.

`tasks` is a task interface over
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
stale_days: 30         # positive whole number; default 30, and opts this
                       # board into age chips whatever Settings says
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
- **Sections**: the board's spine is **Overdue**, **Due today**,
  **Now**, then the area groups, and an empty section is omitted rather than
  rendered blank. `due` is a strict `YYYY-MM-DD`, optionally with a trailing
  ` HH:MM` that buckets by its day; it places a row in Overdue
  (before today) or Due today, wherever its area is. Urgency outranks the pin:
  a `now: true` task that is overdue or due today shows in that section, not
  in Now. Everything else — upcoming and undated alike — stays in its area
  group. A missing or malformed `due` is simply no due date: never a finding,
  never a reason to move or hide the row.
- **Ranking (sort switch)**: the default order within every
  section is due bucket (overdue → today → upcoming → none), then priority,
  then age, then title, then path — so input order never changes the board
  (`src/lib/tasksDashboard.ts`). Trimmed, case-insensitive `high` / `medium` /
  `low` weigh 3 / 2 / 1; missing or unknown priority weighs 1. Age is the
  tiebreaker only; the `age × priority` rot score that ordered v2 is gone.
  `priority` renders as a pill in the schema's own option color, falling back
  to red / yellow / gray when the vault never schema'd the prop.
- **Sort switch**: the header's sort control re-ranks rows within
  list sections and board columns alike. `urgency` is the default above;
  `priority`, `due` (soonest first, undated rows last), and `age` (oldest
  first) each lead with their dimension and keep the others as tiebreakers,
  ending on the same title/path tail so every ordering stays deterministic.
  The choice persists as a `sort` frontmatter prop on the dashboard note; the
  default clears the prop, and an unknown value falls back to `urgency`
  rather than blanking the board.
- **Kanban view**: the header's List | Board control flips the pane
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
- **Age chips are optional**: three levels, innermost wins.
  (1) A task with `stale: never` — or `stale: false`, boolean or string, after
  trim/case folding — is exempt for good, at any age, on any board: the row
  sorts and counts as usual and simply carries no age finding, exactly like a
  pin. Any other value, `true` and typos included, is ignored and the task ages
  normally, so a mistyped key can never be what hides rot.
  (2) A board that sets a usable `stale_days` has asked for age chips and keeps
  them even when the global toggle is off; an unreadable threshold reads as
  unset, so it neither opts in nor changes the 30-day fallback.
  (3) Otherwise the `task-stale-chips` setting decides (§12), on by default.
  Suppression covers the whole age family — `stale` and `undated` both, and the
  `stale` flag on the row model with them — since opting out of age wants
  neither.
- **Now**: a task with `now: true` (YAML boolean, or the string
  `"true"` after trim/case folding) pins to a cross-area "Now" section, the
  hand-picked focus list, while nothing is due on it. Pinned rows never carry
  `stale`/`undated` findings: Now is chosen work, not rot. Unpinning removes
  the key. There is deliberately no cap.
- **Snooze (round trip)**: a task whose `snoozed_until` is a
  strict future `YYYY-MM-DD` (local calendar) leaves the board for a collapsed
  **Snoozed** section listing each row with its wake day, soonest first;
  snoozed ≠ stale. Wake clears the prop and the row rejoins the board. Today,
  past dates, and malformed values never hide a task — a bad date silently
  vanishing a row is the worst failure shape for a trust surface. The prop is
  board-scoped: database views, Today, and the calendar ignore it. The section
  is filled after the area allowlist, so off-board areas don't inflate it.
- **Inline editing**: a row's due chip and priority pill are the
  edit affordances for those props, writing `due` and `priority` through the
  same undoable path the verbs use. An unset value keeps a placeholder in the
  same cell, so the grid never shifts. Priority offers the schema's own
  options where the vault defines them, high/medium/low otherwise; the board
  never edits the schema itself.
- **Quick-add**: the composer creates a `task` note in the type's
  home folder and seeds the schema's first non-completion `status` (else
  `todo`), today's `created`, when the board runs an allowlist its first
  `area`, and the optional `due` picked on the composer's own chip. The
  created row is scrolled to and briefly highlighted, since under urgency
  ranking an undated new task sorts to the bottom of its area group. The area
  seed is load-bearing: an area-less
  task lands in `Unassigned`, which an allowlist filters straight off the
  board, so a row created here would appear to vanish.

`hub` is the column-first home-page renderer. The body stays
ordinary markdown — no on-disk column syntax — and the renderer lays it out
as a hub:

- a `## ` heading becomes a section label;
- a maximal run of consecutive callout blocks (`> [!note|warn|idea] Title`
  plus its `> ` continuation lines — the editor's ordinary callout syntax,
  kind case-insensitive) renders as cards side by side in a responsive grid —
  the columns, with a muted kind accent (note/warn/idea);
- a ` ```heatmap ` fence renders live rather than as a code box, full-width
  where it sits, drawing its year of days exactly as §5.5a defines it. A
  quoted one — inside a callout body or a plain blockquote — stays a code box;
- a ` ```timeline ` fence renders live rather than as a code box, full-width
  where it sits, laying database notes with start/end date properties onto the
  horizontal time view of §5.5d;
- a callout may name one accent after its kind — `> [!note|teal] Title` — from
  the same roster §5.4's `accent:` card key takes (SUB-969); the name recolours
  the card's rule (and the same line in the editor) while the kind glyph keeps
  its own hue. An off-roster name is simply not honoured: the line stays a note
  callout rather than degrading to a plain blockquote;
- these fences render live rather than as code boxes, full-width where they
  sit: ` ```view ` embeds a database table exactly as §5.6 defines it,
  ` ```chart ` plots exactly as §5.5 defines it, and ` ```cards ` renders the
  metrics card row from a YAML list of the same card
  items §5.4's `cards:` frontmatter takes — `label` and `bind` required,
  `format`/`digits`/`emph`/`accent` optional, binds resolving the same
  `{{Sheet.summary}}` way:

  ````markdown
  ```cards
  - label: Total value
    bind: "{{Holdings.total}}"
    format: eur
    emph: true
  - label: Positions
    bind: "{{Holdings.positions}}"
    format: number
  ```
  ````

  The `emph` cap is **page-wide**, not per fence: a hub's cards fences are read
  as one list, so the page spends at most two sharp values however many fences
  it carries. A fence that doesn't parse (unknown key, duplicate key, bad
  `format`/`digits`/`emph`, a card missing `label` or `bind`, an empty list)
  renders its error sentence in place and leaves every sibling block alone —
  same idiom as a malformed `view`/`chart` fence. A ` ```cards ` fence inside a
  callout body or a plain quote is not a card row; it stays a code box, and it
  takes no slot in the page-wide list (the same is true of a quoted
  ` ```chart `, ` ```progress ` or ` ```calendar `).
- a ` ```progress ` fence draws a goal thermometer exactly as §5.5b defines it,
  over the same binds the cards take, and a ` ```calendar ` fence draws the
  month grid exactly as §5.5c defines it;
- everything else (paragraphs, lists, checkboxes, tables, `![[image]]`
  embeds, fences, plain quotes) renders full-width in linear flow between
  card rows. Checkboxes are display-only; audio/file embeds render their
  `embedded file · <name>` placeholder.

Blocks render in document order — prose, headings, callout rows and the live
fences interleave freely, so one hub body composes a whole dashboard
declaratively.

The hub is read-only — "Open source note" drops into the editor, and the file
stays plain markdown any editor can read (`src/lib/hub.ts`,
`src/components/HubDashboard.tsx`).

`food` is a daily net-kcal tracker. Unlike the yield tracker it
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
(creating fence + header when missing), dated its selected day (day
navigation — today by default), and deletes single rows by position;
external writers may append the same way. Formulas in the log note stay
untouched (`src/lib/food.ts`, `src/components/FoodDashboard.tsx`).

The DB note is a second ordinary sheet whose csv fence carries
`name,kcal,per,protein` — same name-based, order-free matching. `per` is the
basis the row's numbers are quoted at: `100g`, `100ml`, or `x` (per
unit/piece; `unit` is accepted on read, written as `x`). `kcal` and the
optional `protein` are per ONE basis; rows with an empty name, non-numeric
kcal, or an unknown basis word are skipped. The optional `g` column
(`g_per_unit` accepted on read, written as `g`) is grams per one
unit on `x` rows — the piece↔gram bridge that lets autocomplete price
gram-typed quantities against piece-based foods; it is ignored on
`100g`/`100ml` rows and never inferred from the log. The pane upserts by
name (case-insensitive replace in place, never a dupe) and deletes by
position. Autocomplete prices the DB's basis over the log's replayed memory
and surfaces never-logged foods; a missing DB note only dims the pane's
Database section — logging keeps working (`src/lib/fooddb.ts`,
`src/lib/foodsuggest.ts`).

The weight note (`weight` prop, default "Weight Log") is a third
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

`feed` is a curated newsfeed. Like `food` it does NOT own its data:
the dashboard note holds only config props, and the items live in a separate
sheet an external curator agent writes.

```yaml
---
type: dashboard
dashboard: feed
items: News Items      # title/stem of the items sheet (default "News Items")
curated: 2026-07-26 09:10   # optional; rendered verbatim; also parsed (leniently) for the
                            # head's ~36h staleness dot — a parse failure stays neutral
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

The pane's refresh button runs the `feed-curator` command from `Settings.md`
(§12) — configured, it is the one place the app itself starts a curation run
instead of waiting for an external writer; unconfigured, the head offers a
setup card instead of the button. The command string is trust-gated per
machine before it ever runs (§12; `docs/dashboards.md` §feed has the full
contract).

`music-work` is a read-only board over a production-tree index. Like
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

`jobs` (SUB-705) is a read + control surface over the machine's launchd agents.
launchd owns the clock — the app has no auto-start, so an in-app scheduler would
die silently; this pane only reports and (opt-in) nudges. The note holds config
props only; the rows come from `~/Library/LaunchAgents` plus `launchctl list`.

```yaml
---
type: dashboard
dashboard: jobs
prefixes: com.example., com.substrate.   # label allowlist
control:                                 # labels that get buttons
  - com.example.digest
  - com.example.verify
freshness:                               # label | note | prop | max-age
  - com.example.digest | Dashboards/News.md | curated | 26h
---
```

`prefixes` is comma-separated or a YAML list; entries of 4 characters or fewer
(a stray stub, or a bare `com.` that would match every agent on the machine)
are dropped, and an empty or junk-only value falls back to the built-in default
(`com.substrate.`) rather than blanking the pane. A
label matches its **longest** listed prefix, which becomes the row's group key;
what remains is the short name the row shows.

`control` opts individual labels into Pause (`launchctl bootout`), Resume
(`bootstrap` from the plist) and Run now (`kickstart -k`). Everything else is
read-only. The gate is doubled by design: a label is only actionable when it is
listed in `control` **and** the machine has a plist for it — so a job listed by
`launchctl` but not registered here can be read and never poked, and a machine
with none of these agents renders a calm empty state with no verbs. Verbs are
idempotent: pausing an already-paused job or resuming a loaded one reports the
existing state rather than failing.

Each `freshness` entry is four `|`-separated fields — the label, a vault-relative
note path (absolute, `~` and `..` paths are refused), a frontmatter prop on that
note, and a max-age (`26h`, `90m`, `3d`, `45s`; a bare number reads as hours).
The stamp is parsed leniently (RFC 3339, `YYYY-MM-DD HH:MM[:SS]`, or a bare
`YYYY-MM-DD` = local midnight); missing, unreadable or older-than-max-age all
warn on the row and on the header state dot, never error. A future stamp is
clamped to age zero rather than flagged. Malformed entries drop that one probe.

The surface is macOS-only and checks before it speaks (SUB-1045): the pane asks
the backend whether a `launchctl` is actually present, and where there is none
it renders one line saying so and no control verbs at all, rather than buttons
whose only possible outcome is an error.

**The app never writes the note** — this dashboard is config-in, status-out
(`src-tauri/src/jobs.rs`, `src/components/JobsDashboard.tsx`).


`tax` (SUB-736) is a read-only readiness board for one tax year: what is
deductible so far, what evidence is still owed, and whether the year is fit to
hand over. It reads two sheets and writes to neither — the books off in
their own tool stay canonical, and this pane is a window onto a derived copy of
it.

```yaml
---
type: dashboard
dashboard: tax
sheet: Tax 2026      # aggregates sheet by title (default "Tax 2026")
missing: Tax Missing # missing-evidence snapshot (default "Tax Missing")
stale_hours: 240     # positive number; default 240 (tax data moves slowly)
cards:               # the board's totals — the ordinary card bindings (§5.4)
  - label: Income YTD
    bind: "{{Tax 2026.income_ytd}}"
    format: eur
    emph: true
---
```

Both sheet props name a sheet by title/stem, not a path. A named note that does not
exist, or exists but is not `type: sheet`, is reported on the board rather than
parsed.

**The aggregates sheet** is an ordinary sheet (§5.1). Its csv fence carries the
columns `category,sheet,rows,amount_eur,basis` — matched by header name,
case-insensitive and order free. `category` is the row's label and the only
required cell (a nameless row is skipped); `sheet` names the source sheet the
figures came from; `rows` is the document count behind the total (a non-whole
or negative value reads as 0); `amount_eur` is a plain signed decimal (anything
else — blank, grouped text, exponent notation — renders as "—" rather than as a
guessed number, because a wrong euro figure on a tax board is worse than none);
`basis` is free text shown as the row's tooltip. A zero-row zero-amount
category is kept: nothing booked yet in a category is information.

**The cards** are the note's own `cards:` bindings (§5.4) — no summary name is
special to this kind, so the board carries whatever totals the sheet defines
and calls them whatever the note says. A binding that names a summary the sheet
doesn't define, or one that evaluates to an error, renders as a card naming
what it looked for; a half-configured year still shows everything it does have.
A `stale_hours:` long enough to outlive the snapshot is the one thing a shipped
sample needs — a fixed `exported:` stamp in a file that ships goes stale on its
own.

**The missing-evidence snapshot** is a sheet with an ISO 8601 `exported:`
frontmatter stamp carrying a timezone, and the csv headers
`sheet,name,date,missing` (order free, case-insensitive):

````markdown
---
type: sheet
exported: 2026-08-03T06:00:00Z
---

```csv
sheet,name,date,missing
Expenses,Studio rent — March,2026-03-01,Receipt no.
Expenses,Interface repair,2026-05-14,Document Filed; Receipt
```
````

`sheet` is the source sheet the row lives in and becomes the checklist's
grouping key (blank groups under "Unfiled"); `name` is the row's name and must
be non-empty; `date` is `YYYY-MM-DD` or empty; `missing` is the semicolon-joined
list of evidence fields still outstanding and must name at least one. A row with
no name or no missing fields is **skipped, never raised** — the same policy the
food log takes with its hand-editable csv, for the same reason: the app doesn't
write this sheet, so a malformed row is the exporter's to fix and must not blank
the pane. An unparseable date degrades to empty (the row still shows, sorted
last) rather than dropping the row, since that would hide a genuinely missing
document.

Checklist order is fully determined — sheet name A–Z (case-folded), then date
ascending with undated rows last, then name, then the missing-field list — so a
regenerated snapshot renders identically even when the exporter's row order
changes.

The header's readiness dot is green ("ready — nothing missing") when
the checklist is empty and the snapshot is fresh, amber ("N documents missing")
when rows are outstanding, and red when the snapshot itself can't be trusted:
unreadable, not a sheet, or an `exported` stamp that is missing, invalid, in the
future, or older than `stale_hours` (exactly at the boundary stays fresh). The
aggregates sheet failing never reddens the dot — its cards go missing on their
own.

Who writes what: the aggregates sheet is refreshed by whatever repricing pass
maintains the year's numbers, and the missing-evidence snapshot by an external
exporter reading the books. **The app writes neither**
(`src/lib/taxReadiness.ts`, `src/components/TaxDashboard.tsx`).

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
- Claims: a `claimed_usd` prop on the note holds the cumulative
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
  syntax takes (§5.6b). In frontmatter a card asking for more is clamped to 8
  rather than refused, and anything that isn't a whole number reads as absent;
  the hand-written forms (the ` ```cards ` fence, a ` ```tile ` card line) name
  the bound as an error instead (SUB-1060, and see the strictness note below).
- `emph`: optional, `true` only (anything else reads as absent). Marks the
  card as one of the board's sharp anchors — at most two, first two in card
  order if more are flagged; with none flagged the first card is sharp.
  Unflagged cards render in the quiet voice (design principle 11).
- `accent`: optional, one **name** from the shared option palette — `gray`,
  `blue`, `indigo`, `violet`, `pink`, `red`, `orange`, `yellow`, `green`,
  `teal` (the palette select options and status pills already draw from). It
  tints the card's label and the hairline it is ruled under: mood, not state. Never a hex, a
  px value, a font or arbitrary CSS — a name off the roster reads as absent,
  exactly like an unrecognised `emph` value, and never errors the card. Accent
  and `emph` are independent: hue says what a card is about, `emph` says which
  one matters, so accenting every card cannot spend the board's two sharp
  values.

A bind whose name is a **mount** (§8) reads that mount's live index instead of
a sheet — `bind: "{{Album pool.count}}"` — with no change to the grammar: the
first half is the sheet or mount name, the second an aggregate on it. A mount
carries `count`, `present`, `missing` (rows the index remembers but the folder
no longer has), `bytes` (total size of the present files, shown in the size
column's own units — `11,8 MB`, not a raw byte count, unless the card asks for
a `format:`), and `newest` / `oldest` (the extreme `modified` stamp). An
unknown aggregate names itself on the card and lists what a mount does carry,
the way a missing summary does.

**A mount wins over a note of the same name.** Mount names and note titles live
in different registries and nothing prevents a collision, so `{{Album pool.…}}`
reads the mount whenever one is named `Album pool`, and any note of that title
is shadowed for binding purposes — creating a mount can therefore repoint an
existing card. Mount-wins is deliberate: falling back to the note on an
unrecognised aggregate would make a typo silently read a different surface. The
shadowing is never silent — a card whose aggregate the mount doesn't have says
in its tooltip that a same-named note is shadowed by this mount, so a card that
stopped reading its sheet says why. To bind the note instead, rename one of the
two.

Mount bindings are per machine (§8): on a machine where the mount isn't bound,
or its folder is away, the card still shows the last-known number and says
"not on this machine" / "folder not found" underneath — never a blank board.

The same card items also appear as a ` ```cards ` body fence on a hub page
(§5.2) — one schema, one binding path, one formatter
(`src/lib/metriccards.ts`, `src/components/MetricCards.tsx`). The two paths
differ deliberately in how strictly they read a malformed card: the **fence**
validates strictly and names the mistake in place (an unknown key, `format` or
out-of-range `digits` is an error where the fence sits), because it is
hand-written body text a person edits and expects feedback on, while this
**frontmatter** path stays lenient (an incomplete card is dropped, an unknown
`format` renders the raw value, out-of-range `digits` clamps), because
frontmatter is machine-written as often as hand-written and a whole dashboard
should not blank out over one bad key.

The split is by SURFACE, not by key: every hand-authored card surface reads a
value the same strict way, through one reader for `digits`
(`parseCardDigits`), so they refuse the same values with the same words — and
the two lenient paths, frontmatter parsing and the formatter's own last-resort
guard, clamp with the same `clampCardDigits`. A card object built by any other
path still cannot reach `toLocaleString` out of range.

Behavior change to know about when reading an older vault: a hand-authored
` ```cards ` fence carrying `digits: 9` (or any value past 8) used to render,
silently clamped to 8; it is now a named parse error, and because the
fence stops at the first bad card the whole strip renders that message in place
of its cards until the value is corrected. The bound itself is unchanged — 0–8
has always been what the docs promised — so only a fence that was already
outside it is affected. Frontmatter `cards:` still clamps, so a dashboard's
own card list is untouched.

### 5.5 Chart blocks — ` ```chart ` fences

A ` ```chart ` fence inside a dashboard note declares one chart. Config
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
  not rows — to plot those, use `series` below). Because **a mount IS a schema
  type** (§8), naming a mount here charts its folder's live index — one row per
  file, columns `name`, `extension`, `size`, `created`, `modified` plus whatever
  its sidecars annotate — so `source: Album pool` / `x: modified:month` /
  `y: count` plots files touched per month with no importer. A mount wins over
  a database of the same name, the same way it does for cards (§5.4) — and
  charts it exactly as it would that database, schema'd option colours and
  order included. Mount bindings are per machine: an unbound or away folder
  still charts from the last-known index and says so in a quiet line under the
  chart title, rather than plotting empty.
- `x` — the bucket axis: `<prop>` for a categorical axis (scalar values, or a
  string list joined with `, `), or `<date prop>:<bucket>` with bucket `day` |
  `week` | `month` for a date axis. Date axes accept scalar dates only; lists
  are skipped rather than choosing one item. Bucketing: day = the ISO day
  itself, week = the Monday of the containing week (Monday-first), month =
  `yyyy-mm`. A time suffix is ignored (`2026-07-17 10:28` buckets as
  `2026-07-17`).
- `y` — the reduction: `count` (rows per bucket), `sum:<prop>`, or `avg:<prop>`.
  The prop must hold numbers (numeric strings coerce).
- `series` — the summary binding: a comma-separated list of a sheet's
  named summaries (`series: etf, crypto, cash`), each plotted as one point in
  fence order. Sheet sources only, and exclusive with `x`/`y` — a fence carrying
  both, or `series` on a database source, is a parse error. Names match
  case-insensitively; the sheet's own casing labels the point. A name that is
  not a numeric summary on that sheet (a row column, a typo, an errored or
  non-numeric summary) errors the whole chart naming it, rather than dropping
  the point — a hand-named point set must not silently lose one.
- `by` — optional series split: a prop or column whose distinct values
  each become one series — stacked slices on a bar, one line each on a line
  chart, named by a legend above the plot. Row binding only, and exclusive with
  `series` (both name the series axis, so a fence carrying both is a parse
  error). Values fold case to group and keep their first-seen casing; series
  order is first-seen. A row whose `by` field is blank or unreadable is skipped
  like a missing x, never gathered into an invented series; a `by` field absent
  from the whole source is named in the chart's binding error alongside x and y.
  The current neutral token ramp distinguishes two series. Three or more render
  an in-place message pending the categorical-palette call.
  A stacked bar accepts non-negative `sum`/`count` measures; use `kind: line`
  for averages or negative split values. A split's series encoding replaces
  schema hue on a categorical x-axis.
- `kind` — `bar` (default) | `line`.
- `size` — optional bounded style token (SUB-969): `tall`, or absent for the
  default plot. A NAME from a closed roster, never a height — a fence cannot
  name pixels, and the app owns what `tall` measures. Unlike every binding key
  above, an unknown value is not a parse error: the chart draws at its default
  size, because a preference we can't honour must not fail a fence whose data
  is fine.
- `title` — optional; derived when absent (`Release per month`,
  `Sum of value_eur by asset`, `Holdings summaries`); a `by` split appends
  `, split by <field>`.

Semantics: prop lookup is case-insensitive; rows with a missing/unparseable x or
a non-numeric y are skipped (reported as a skip count); date axes sort ascending,
categorical axes keep first-appearance order. A dashboard renders every ` ```chart `
fence in body order; a malformed fence renders its parse error in place — it never
breaks the others, and fixing the text fixes the chart.
Hub bodies host the same fence with the same parser and renderer (§5.2).

Every series of a `by` split shares the chart's x axis: a bar series carries the
whole (zero-filled) axis so stacks line up, and a line series omits keys it has
no rows for rather than drawing a fabricated zero. The chart's own point count
and skip count stay whole-chart figures.

Hover or focus any bar or point for a tooltip with the exact value, the x label,
and — on a split chart — every series at that x. Each chart is a single tab stop
with arrow/Home/End navigation along the axis; tooltips never print.

### 5.5a Heatmap blocks — ` ```heatmap ` fences

A ` ```heatmap ` fence declares one year of day squares — the
contribution-graph read of a database or a sheet. Same hand-editable
`key: value` text, same `#` comments, same in-place error idiom as §5.5:

````markdown
```heatmap
source: session
date: logged
value: count
query: status:done
```

```heatmap
source: {{Studio Log}}
date: day
value: sum:minutes
```
````

Keys (`src/lib/heatmap.ts`; `source`, `date` and `value` all required):

- `source` — a database type, or `{{Sheet Name}}` for a sheet. Reads exactly
  what §5.5's `source` reads (data rows plus computed columns on a sheet).
- `date` — the date property/column each row is stamped with. The leading ISO
  day of the cell counts, so `2026-07-17 10:28` lands on `2026-07-17`; a row
  with no readable date is skipped and reported.
- `value` — `count` (rows that day) or `sum:<prop>` over a numeric property.
  No `avg`: an average per day answers a different question than an intensity
  grid asks.
- `query` — optional, **database sources only**: the §7 filter-bar query
  language (`filterByQuery`), the same parse and matching the filter bar and
  the ` ```view ` fence use, resolved against the type's schema. A `query` on a
  sheet source is a named error rather than a silent no-op.

There is no `kind`, no `title` and no axis to configure — a heatmap is one
question. The **year is derived, never declared**: the fence shows the latest
year carrying a matching date (this year when the source is empty), so it keeps
saying something true as the vault moves past it, and a source spanning several
years offers a year switch. Intensity quarters the shown year's heaviest day
into four levels; a day summing to zero reads empty even when rows landed on
it, and the square still reports them. Every day of the year gets a square, so
hover, tooltips and the keyboard reach the whole grid.

A note carrying heatmap fences opens as a heatmap dashboard; a note carrying
both chart and heatmap fences renders its charts first and its heatmaps under
them. Hub bodies host the fence too (§5.2). A malformed fence renders its parse
error in place and leaves its siblings alone.

### 5.5b Progress fences — ` ```progress `

A ` ```progress ` fence declares one goal: a number, the number it should reach,
and optionally the day it is due. Config is hand-editable `key: value` text, one
per line; `#` comments allowed, values may be quoted:

````markdown
---
type: dashboard
dashboard: hub
---

```progress
label: Portfolio target
value: {{Holdings.total}}
target: 500000
format: eur
deadline: 2026-12-31
start: 2026-01-01
```

```progress
label: Signups
value: count
source: signup
query: status:confirmed
target: 100
```
````

Keys (`src/lib/progress.ts`; `value` and `target` required):

| key        | meaning                                                                  |
| ---------- | ------------------------------------------------------------------------ |
| `label`    | optional goal name; otherwise derived from `value`                       |
| `value`    | `{{Sheet.summary}}` — the same bind §5.4 defines — or the literal `count` |
| `source`   | with `value: count`: the database to count (a `type` name)               |
| `query`    | with `value: count`: optional filter, the ` ```view ` query grammar (§5.6) |
| `target`   | a positive number, or a `{{Sheet.summary}}` bind                          |
| `deadline` | `YYYY-MM-DD` — turns on the pace line                                    |
| `start`    | `YYYY-MM-DD` the value stood at **zero** — the ahead/behind anchor        |
| `format`   | as §5.4: `eur`, `usd`, `number`, `pct`                                   |
| `digits`   | as §5.4                                                                   |
| `accent`   | as §5.4: one **name** off the option roster; off-roster reads as absent   |

`accent` is the one key that degrades silently rather than erroring the fence
(the Style tokens section of `docs/dashboards.md` states the rule): a wrong
bind is a lie about the data and still fails loudly, a wrong colour is only a
preference nobody can honour. It tints the goal's **label** — never the bar,
which stays neutral so the fill keeps saying how far along the goal is and the
hue only says what the goal is about.

`value: count` reports the **total** the query matches, not a page of it — the
same number the equivalent ` ```view ` fence's table counts, resolved through the
same path. Binds resolve through the metric card's own loader, so a summary
reads identically on a card and on a thermometer. The bar clamps at 100 %; the
percent text does not, so 120 % of a target says so.

**Pace is deliberately narrow.** Nothing on disk records what a summary or a row
count was yesterday, so "ahead of schedule" is only honest when the fence says
where the line starts:

- with `start:` — a straight line runs from 0 on the start day to `target` on
  the deadline, and the fence reports the distance from it ("behind by 13.000 €
  · 44 days left"). Before the start day and after the deadline the line does not
  extrapolate: it ends where it ends.
- without `start:` — **no ahead/behind claim at all**. The fence reports the days
  left and the per-day rate still required, both of which follow from today's
  value alone.

`start` without `deadline` is an error, as is a `start` on or after the deadline.
Date math is calendar-pure (`src/lib/dates.ts` `daysBetween`), so a reading can't
drift across a DST boundary.

A fence that doesn't parse — unknown or duplicate key, `value` that is neither
`count` nor a bind, `count` without a `source`, `source`/`query` on a bound
value, a non-positive `target`, a malformed date, an unknown `format` — renders
its error sentence in place and leaves every sibling block alone, same idiom as a
malformed `view`/`chart`/`cards` fence. So does an unreadable bind or an unknown
database at render time.

Surface: a hub body (§5.2) hosts progress fences; a hub whose body is one fence
is the standalone form. A ` ```progress ` fence inside a plain quote or a callout
body is quoted text and stays a code box — the same rule the ` ```chart ` and
` ```cards ` fences follow. Like them it is a machine fence: its config
lines stay out of the search index, tail and all.

### 5.5c Calendar blocks — ` ```calendar ` fences

A ` ```calendar ` fence inside a dashboard note declares one month grid over a
date property. Config is the same hand-editable `key: value` text the
chart fence takes, one per line, `#` comments allowed:

````markdown
---
type: dashboard
---

```calendar
source: release
date: released
query: status:mastering
```
````

Keys (`src/lib/calendarfence.ts`; `source` and `date` required):

- `source` — a database type (`release`), or `{{Sheet Name}}` for a sheet, read
  exactly as §5.5's `source` is.
- `date` — the date property (database) or column (sheet) the grid places
  entries on. Matched case-insensitively. A name no note of the type carries
  and the schema does not declare as a date errors the fence naming it, with
  the date props it does have — an empty month is never a stand-in for a typo.
- `label` — optional: the property/column each chip reads instead of the note
  title (a sheet without one reads its first column). A label absent from the
  whole source errors the same way; a note whose label value is empty falls
  back to its title rather than erroring.
- `query` — optional, database sources only: the same operator language as the
  database filter bar (`src/lib/query.ts`, §5.6's `query`), narrowing which
  notes reach the grid. On a `{{Sheet}}`
  source it is a parse error, not a silent no-op. Binding checks run against
  the whole type, never the query result, so an over-narrow filter reads as an
  empty month and a misspelled property still reads as an error.

Semantics: entries sit on their day, ordered all-day-first then by time then by
title — the Calendar pane's own order. A chip opens its note (a `{{Sheet}}`
chip opens the sheet: a row is not a note). **Recurrence is honoured**: a
database source expands `repeat` / `repeat_until` / `repeat_skip` (§5.7)
through the same `calendarEntries` the Calendar pane uses, bounded by the drawn
month's window, so occurrences stay virtual and nothing is materialized. A
sheet source has no notes and therefore no recurrence — one row, one day.

A dashboard renders every ` ```calendar ` fence in body order, each with its own
month cursor (paging one leaves the others where they are); a malformed fence
renders its parse error in place and never breaks the others. Hub bodies host
the same fence with the same parser and renderer (§5.2). A tailed opener
(` ```calendar month `) is not a fence: the parser reads the bare form only, so
it renders as a code box and stays in the search index like any prose.

### 5.5d Timeline blocks — ` ```timeline ` fences

A ` ```timeline ` fence in a hub body lays notes from one database onto a
horizontal date axis. Config is strict `key: value` text, one per
line; blank lines and `#` comments are ignored:

````markdown
```timeline
source: release
start: recording_start
end: release_date
label: title
group: stage
query: status:active
```
````

- `source` — required database type, matched case-insensitively. Timeline v1
  reads note databases only; a `{{Sheet}}` binding is an error rather than a
  sheet drawing bars that cannot open a source note.
- `start` — required date property. A valid leading ISO day is used from a
  day or date-time value.
- `end` — optional date property. A missing value makes that note a milestone
  dot; a valid value makes an inclusive bar. Written invalid dates and ranges
  whose end precedes their start are skipped and counted.
- `label` — required property naming the item. `title` addresses the note
  title directly; an empty value falls back to the title.
- `group` — optional property whose values become lanes. Missing values land
  in `Other`; overlapping items within a lane pack onto quiet subtracks.
- `query` — optional, with the database filter bar's existing query semantics.

Clicking a bar or milestone opens its note. The axis chooses weekly, monthly,
or quarterly tick density from the data span and shows a today line only when
today falls inside the visible extent. Unknown keys, missing required keys,
unknown databases, and property names absent from the source render an error
where that fence sits without disturbing sibling blocks. The body remains
ordinary markdown (`src/lib/timeline.ts`, `src/components/TimelineFence.tsx`).

### 5.6 View embeds — ` ```view ` fences

A ` ```view ` fence renders a live, editable inline database table inside the
note editor — the hub-page primitive: prose plus a live cut of a database,
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
  (`status:live`, comma-OR `status:live,"in review"`, `due < 7d`,
  bare words match titles — `src/lib/query.ts`).
- `view` — accepted, but only `table` renders in v1; any other value falls
  back to table.
- `saved` — one-key alternative: a pinned view's id (or name), resolved
  case-insensitively; the pin's database, query and saved sort order drive the
  table. When present it wins over `type`/`query`; an explicit fence `sort:`
  overrides the saved order.
- `sort` — optional; `sort: <prop>` ascending, `sort: <prop>:desc`
  descending (`asc`/`desc`, either case). The property is matched
  case-insensitively against the database's own columns, plus `title`. The
  ordering IS the database table's: a select column follows its declared
  option order, a number sorts numerically, a date chronologically, and
  missing values sort last in both directions.
- `limit` — optional; a positive whole number of rows, applied
  AFTER the query and AFTER the sort — so `sort: released:desc` + `limit: 5`
  means "the five newest". The table then says "5 of 23 rows — this view's
  limit" rather than implying five is all there is.
- `columns` — optional; a comma-separated pick and order
  (`columns: status, artist`), matched case-insensitively against the
  database's columns and still bounded by the surface's column cap. Wins over
  a `saved:` pin's own curated list.
- A dotted `relation.property` name in `columns:` or `sort:` is a **join**
  (SUB-829) — a lookup column showing a stored property of the row this row's
  relation names: "the date of the release this master points at".

  ````markdown
  ```view
  type: master
  columns: stage, release.date, release.catalog
  sort: release.date:desc
  ```
  ````

  Grammar: exactly one dot — `relation.property`. The left side must be a
  `relation`-kind property of the fence's own database; the right side a
  column of that relation's target database. Both sides are matched
  case-insensitively, like every other name in the fence, and the column
  renders under the canonical spellings (`Release.CATALOG` → `release.catalog`).

  **A stored column wins over a join.** Nothing forbids a dot in a vault
  property name — `v1.2` is a perfectly good frontmatter key — so a dotted
  name is read as a join only when this database has no column of that name.
  If it does, the name is that column, and the row's own stored value renders,
  editable as ever. (The `.`-excluding character class in the query grammar
  governs filter TOKENS, not stored keys.) The rule holds identically in
  `sort:`: `sort: release.date` orders by a stored `release.date` prop if the
  database has one, and only otherwise looks the value up through `release`.

  **One hop only.** `release.artist.name` is an error, not a second lookup —
  a join follows one relation and stops.

  Matching is the rollup's, exactly (§ relations/rollups): the target database
  is matched case-insensitively by `type:`, its rows by title OR stem,
  case-insensitively and trimmed, and two rows sharing a title are
  indistinguishable — the first wins. Joins read **stored** values only, so a
  dotted name pointing at a rollup column reads nothing. `relation.title`
  resolves — to the target row's display name, the way the database table can
  already sort by `title` without it being a column. `relation.type` does not:
  the type is the row's database membership, not a property of it.

  **Blank, never an error, for every data condition**: the relation is empty,
  the value names no row (trashed or renamed away), the target row simply has
  no such value — and also when the target database itself can't yet say
  whether the property exists. A database whose type declares no properties
  in `schema.json` (including one with no rows at all) has no vocabulary to
  contradict, so any dotted name against it blanks and starts filling as rows
  gain the value. The unknown-property error is reserved for the case where
  the target's schema DOES declare properties and the name is in neither the
  schema nor any row — a typo, not a data condition.

  Errors are reserved for authoring mistakes and render as the same quiet card
  every other fence error does — "“stage” isn't a relation property on
  “master”", "Unknown property “nope” on “release”",
  "“release.artist.name” goes more than one hop — a join follows one
  relation".

  Rows never multiply: a join only adds a column. A relation holding several
  values renders its looked-up values comma-joined in stored order — no
  implicit "first one". Joined cells are **read-only**, like rollup cells:
  the value lives on another row and is edited there.

  `sort:` accepts a dotted name too, ordered under the TARGET property's own
  kind (a date chronologically, a select by its declared option order) and
  computed for every matched row BEFORE the row cut — so
  `sort: release.date:desc` + `limit: 5` means "the five whose release is
  newest". Rows with nothing to look up sort last in both directions.
  Sorting by a lookup does not add it as a column: `sort: release.date` with
  no `columns:` orders the table without widening it.

  A lookup that produced several values sorts by whichever one ranks best in
  the chosen direction — the newest under `:desc`, the oldest under `:asc` —
  so a master pointing at both an old and a brand-new release sorts as the new
  one under `release.date:desc`. Only a row with no usable value at all sorts
  last. The DISPLAY is unaffected: still every value, comma-joined in stored
  order.

  Not in v1: `query:` filtering on a dotted key. The filter language's keys
  cannot contain a dot, so such a term is not a filter at all — it falls
  through to the existing bare-word behavior (a case-insensitive substring
  match against note titles). Show-but-can't-filter is the accepted v1 cost.
- Every ` ```view ` fence in the body renders its own table (unlike the
  single-match csv/formulas fences above).

Semantics: a fence with no usable keys, an unknown key, a malformed value, an
unknown database, an unknown column or sort property, or an unknown saved id
renders a quiet inline error card ("Unknown database “x”", "Unknown key
“sortt” — try type, query, saved, …") — never a crash, never a broken sibling
fence, and fixing the text fixes the card. Empty `sort:`, `limit:` and
`columns:` values are malformed; while editing, the caret keeps the raw fence
visible rather than flashing its error card.
Unknown keys were silently ignored in earlier versions; a typo now says so.

The table shows the title column plus the database's first four columns
(`dbColumns`) — or exactly the `columns:` list — and at most 50 rows in the
editor (200 on a workbook page). When rows are cut, the count line names WHICH
cut fired: an author's `limit:` reads "this view's limit", the surface's
safety cap reads "open the database for the rest". `total` is always the full
match count, so the shown/total pair is honest either way. The header
(database name + count) opens the full database; the title cell of a row opens
its note.

Editable. Every non-title cell edits in place with the database
pane's own semantics: a checkbox toggles on click, select/multi/date/relation
open their pickers, and text/number/url get an inline input that commits on
blur or Enter and cancels on Escape. Writes go through the same undoable prop
path the pane uses, so one undo reverts an inline edit either way. A "+ New"
row below the table creates a note of the fence's database — schema defaults,
template applied, plus the fence query's plain `key: value` equality filters
seeded so the new row belongs to the table it was added from (negations,
comparisons and OR-lists seed nothing). Rollup columns and joined
`relation.property` columns (SUB-829) stay read-only, and no
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

### 5.6a Workbook pages — `pages:`

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
prop — Notion-Calendar-style, no raw RRULE anywhere:

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

**Recurrence ignores ranges**. If a repeating note's date prop
carries a range, the series expands from the span's **start** day and every
occurrence is a single day — the end is not carried onto them, and the
anchor's own multi-day bar is replaced by that first occurrence. A repeating
multi-day span is a second scheduling concept (overlapping occurrences, spans
longer than their own cadence) and is deliberately out of scope; the value
stays legal on disk and every non-calendar surface still reads it as a range.

### 5.8 Custom kind bundles — `.vault/kinds/<id>/`

> **Live.** The loader, the dispatch branch and the enable flow all ship. A
> `dashboard:` value naming a bundle **never falls through to
> charts-or-yield**: a kind that can't be resolved — broken manifest, unknown
> id, api out of range, not enabled, bytes changed since — renders a card
> naming the kind and the reason. That fallback is for typos; using it here
> would answer "show me `gear-log`" with a yield tracker.

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
- `style`, when named, is fetched and injected as a `<style>` element inside
  the kind's pane — **document-global CSS scope, not a shadow root** — so
  prefix every selector with something yours (`gear-`) and avoid bare element
  selectors; an unprefixed rule styles the rest of the app for as long as the
  pane is open. The element is removed on unmount, and a style that fails to
  load is not fatal: the kind mounts unstyled rather than not at all.
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

The record itself, keyed by kind id inside `kinds.json`:

```json
{
  "hash": "sha256:1f0c…",
  "api": 1,
  "enabledAt": "2026-08-04T11:02:00Z",
  "trustUpdates": false
}
```

`api` is the contract version consented to, so a bundle that later rewrites
its manifest to a different api is a new decision. `trustUpdates` is absent
or `false` unless the user turned it on by hand — see below.

**The review pane** (SUB-961). A kind that isn't enabled renders, in the
dashboard frame rather than a modal, what it is: title, description, author,
api, the entry file, and the files the hash covers with their sizes. Three
sentences say what enabling means — full vault access, this vault on this
device only, pinned to these exact bytes. Nothing is pre-checked, and
*Open the code* **reveals** the folder rather than opening the entry file, so
looking at a kind never runs it.

When the bytes drift the same pane returns worded for the second decision,
and one click re-consents. The per-kind **trust-updates rider** — off by
default, settable only on a kind already enabled once — makes that automatic
for a kind the user is editing themselves, which is the agent-iteration loop.
It re-enables at the new hash; it is not a standing exemption from hashing,
and it never covers a first enable.

Consent is also reviewable after the fact, in **Settings → Kinds**: what this
vault has, each one's state, the rider, and a disable verb. **Disabling never
deletes** — the record goes, the folder stays.

Because the record lives outside the vault, no vault change reports a consent
change; the app invalidates its bundle list explicitly on every consent write,
which is what makes enabling mount the kind in place instead of on the next
reload.

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
and redraws itself. `el` itself is stable across those redraws — only its
children are replaced when a kind redraws with `innerHTML` — so the pattern
for interactive kinds is one delegated listener bound on `el` in `mount`
(with `data-` attributes carrying the target), not per-child listeners that
die with every redraw.

The **host renders the head**. A kind draws its body only; the title bar, the
source-note button and the state dot are the app's, so every dashboard —
built-in or vault-resident — has one header.

**If `mount` throws, or the module fails to import, the pane renders an error
card naming the kind and the file.** Never a blank pane, and never the
charts-or-yield fallback.

That covers what the host is on the stack for: the import, the module shape,
and the synchronous body of `mount`. A throw from code the kind scheduled and
the host never awaited — a timer callback, a rejected promise nobody handles,
a listener firing later — reaches no card; it lands in the console like any
other page error, and whatever the kind already drew stays on screen. Catching
those would take a global error handler, which would blame every page-wide
error on whichever kind happened to be mounted. A kind that does async work
should therefore handle its own rejections and say so through `ctx.setState`
or `ctx.toast`.

`ctx` members, api 1:

| Member | Shape | What it is |
| --- | --- | --- |
| `ctx.api` | `number` | The contract version actually handed over — what the kind got, not what it asked for. |
| `ctx.el` | `Element` | The same element passed as the first argument, for convenience. |
| `ctx.note` | `{ path, title, props, body }` | The dashboard note the kind is mounted in: its vault path, title, frontmatter props and raw body. |
| `ctx.css` | `Record<string, string>` | Sanctioned class names, the full api-1 roster: `dash-metrics`, `dash-metric`, `dash-metric-sub`, `dash-label`, `dash-value`, `dash-sub`, `dash-hero`, `dash-table`, `dash-card`, `dash-cards`, `dash-section-label`, `dash-link`, `dash-foot`. Rendering through these is how a kind speaks in the app's voice and follows its theme; a kind may also ship its own `style.css`. A key not in the map reads as `undefined` — interpolated straight into a template string that becomes `class="undefined"` — so look keys up defensively (`ctx.css["dash-hero"] ?? ""`) and put anything the roster doesn't cover on your own prefixed classes. |
| `ctx.accents` | `readonly string[]` | The accent roster — `gray`, `blue`, `indigo`, `violet`, `pink`, `red`, `orange`, `yellow`, `green`, `teal`. Put one on `data-accent` on a `dash-card` and the app resolves the hue — that is the one sanctioned class wired for it; an off-roster name paints nothing. Named mood, not CSS: a kind that names `teal` follows the theme when the theme moves. Added inside api 1, so **feature-check it** (`ctx.accents ?? []`) — a build older than SUB-969 mounts the same kind with the member absent. |
| `ctx.notes(filter?)` | `⇒ Promise<NoteMeta[]>` | The note index — path, stem, title, folder, props, `updated_ms`, excerpt, `tags` (inline `#hashtags` unioned with the `tags:` prop, deduplicated; optional, so absent on older projections) and `sealed`. **A kind that renders note bodies must read `sealed`**: it says the note is whole-file encrypted on disk, and vault code that ignores it is one more surface emitting plaintext the user sealed. The optional filter is a plain predicate, `(n) => boolean`, applied per note: `ctx.notes((n) => n.props.type === "gear")`. |
| `ctx.read(path)` | `⇒ Promise<{ body, props }>` | One note's raw body and its frontmatter props. |
| `ctx.sheet(title)` | `⇒ Promise<…>` | A sheet fence, parsed and evaluated — headers, typed rows, computed columns, named summaries — so a kind doesn't reimplement the sheet grammar (§5.1). |
| `ctx.setProp(path, key, value, expected)` | `⇒ Promise<{ meta, prior }>` | Write one frontmatter property; resolves the note's updated meta plus the value that was there before. |
| `ctx.writeBody(path, body, expectedBody)` | `⇒ Promise<NoteMeta>` | Replace a note's body; resolves the note's updated meta. |
| `ctx.create(title, folder?, type?, props?, body?)` | `⇒ Promise<NoteMeta>` | Create a note. Positional, and everything after the title is optional. `props` is a list of **pairs**, not an object — `[["area", "Studio"], ["priority", "high"]]` — the shape `vault_create` itself takes (§14). |
| `ctx.onChange(cb)` | `⇒ unsub` | Subscribe to vault changes; call the returned function to unsubscribe. This is the redraw signal. The callback gets no arguments — it says "something changed", not what — and changes may arrive in bursts, so an async redraw should drop stale responses (a generation counter) rather than assume one event per draw. |
| `ctx.openNote(path)` | `⇒ void` | Open a note in the app, the way a row click does. |
| `ctx.toast(msg, action?)` | `⇒ void` | The app's single toast slot; the optional action is a `{ label, run }` button. |
| `ctx.setState(s \| null)` | `⇒ void` | Feed the head's state dot — `{ color, label }` shows it, `null` keeps it quiet. `color` is any CSS color, painted as the dot's background; omit it for a label with no dot. |

**`expected` and `expectedBody` are required on writes.** Both are
compare-and-swap guards: the write is refused with a conflict rather than
applied when the value on disk has changed since the kind read it
(`expected: { value }`, `{ value: null }` = "expected absent"; `expectedBody`
is the body the kind believes is there). **A refusal is a rejected promise** —
`try/catch` the call, tell the user (`ctx.toast`), and redraw from a fresh
read; a resolved promise means the write landed. A successful write also fires
the kind's own `ctx.onChange` like any other vault change, so make redraws
idempotent rather than special-casing your own writes. The app itself may write
unconditionally in places where it knows it holds the only copy; a kind never
does — an unconditional write from vault-resident code is a clobber of
whatever the user or another surface did in between. Reads and writes ride the
app's own IPC wrappers (`vault_write_body`'s `expected_body` CAS, §13.1;
`vaultSetProp`'s `expected`, `src/lib/ipc.ts`), so a kind inherits the
existing conflict guards and undo semantics for free rather than growing a
second, weaker set.

**A conflict is not the only rejection.** `ctx.sheet(title)` rejects when no
sheet by that title exists, and re-throws the sheet's own parse error when it
has one, rather than resolving to an empty table a kind would render as zeroes.
`setProp` and `writeBody` reject on a missing or malformed guard — `expected`
that isn't a `{ value }` object, an `expectedBody` that isn't a string — and
they reject *before* any IPC: the check lives in ctx, so a kind that forgot the
guard never reaches disk to find out. All of it arrives the same way a conflict
does, as a rejected promise, so one `catch` per call covers the family; only
what you tell the user differs.

**ctx grows additively inside an api version**, so kinds **feature-check**
rather than bump:

```js
if (ctx.sheet) { /* use it */ } else { /* parse the fence yourself */ }
```

A member added in a later build appears on `ctx` without changing `api`; a
kind that checks before calling keeps running on both. `ctx.accents` is the
first member to arrive this way. `api` only moves when something existing
changes shape or leaves.

`ctx` is **ergonomics, not a boundary.** It exists so the common things are
one call instead of twenty lines, not to constrain what a kind can reach — a
kind runs with the app's own access either way, and the enable decision is the
only boundary there is.

External writers: `.vault/kinds/` is app-owned. Write a bundle there only
deliberately, and never touch the consent record — it is not in the vault by
design.

### 5.9 Calc lines — `= expression`

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
- Results format per the `number-locale` setting (§12) — the same dial every
  other number in the app reads: `de-DE` `1.234,56` (default), `en-US` /
  `en-GB` `1,234.56`, `de-CH` `1'234.56`, `fr-FR` `1 234,56`.

Agent note: calc lines are *read-time* sugar — an external writer never needs
to compute or update anything. Write the expression, the app renders the
answer.

### 5.10 Live values in prose — `` `= expression` ``

An **inline code span holding `=`, exactly one space, then an expression**
computes, and the answer renders in the span's place, mid-sentence:

```markdown
The label has `= Masters.count` releases, worth `= Holdings.total`.
```

The syntax is deliberately nothing new — it is an ordinary markdown code span,
so any other reader shows `= Masters.count` as code and the sentence still
reads. There is no fence grammar and no new delimiter to learn.

- **The form is exact, and narrow on purpose.** Backtick, `=`, one space,
  expression. `` `=1+1` ``, `` `=  1+1` `` and `` ` = 1+1` `` are ordinary code
  spans. The single space is what separates running a formula from writing
  about one: `` `=SUM(A1:A2)` `` in a sentence about Excel is prose, and a
  renderer that swallowed it would have destroyed the author's text.
- **Non-expressions render literally.** A span in the documented form whose
  text doesn't parse as a formula (`` `= SUM(A1:A2)` ``) is not a live value at
  all — it keeps rendering as the code span it already is. The dim `–` is
  reserved for expressions that **parse and then fail to evaluate**. No input,
  pathological ones included, can turn visible text into a dash.
- **Engine**: the same one sheets use (`src/lib/formula.ts`). An expression is
  a sheet formula, and cross-sheet names resolve the way a sheet's own
  `formulas` fence resolves them — `Sheet.name` reaches a summary first, then a
  computed column, then a data column. Numbers format exactly as they do in the
  grid, units included (§5.9 vocabulary, `src/lib/units.ts`). Unit *conversion*
  (`25 USD in EUR`) is calc-line grammar (§5.9), not formula grammar: such a
  span doesn't parse, so it renders literally. Conversions belong in the sheet.
- **Read-only**: an expression never writes anything. It cannot add rows,
  set properties, or change the sheet it reads.
- **Volatile**: the computed value is **never** written to the file. The `.md`
  holds the expression text and nothing else — same contract as a calc line.
  Recomputation happens when the note renders and when the underlying sheets
  change; nothing is cached in the vault.
- **Whole columns don't render**: `` `= Holdings.value_eur` `` is a column, not
  an answer — wrap it in `SUM`, `COUNT` or `AVG`.
- **Errors are quiet**: an expression that can't compute shows a dim `–` with
  the reason on hover. A missing sheet, a typo'd name, or a sheet that failed
  to parse never puts an error wall inside a sentence.
- **Escape hatch**: a **double-backtick** span (``` ``= Masters.count`` ```)
  never computes — the grammar is single-backtick only, so doubling is how a
  note writes the syntax while explaining it.
- **Scope**: spans inside ``` / ~~~ fences and inside four-space- or
  tab-indented code blocks never compute — code someone is *showing* stays
  shown. Frontmatter is not body text and is never scanned. HTML comments are,
  so a span inside one computes (invisibly) — harmless, since the result is
  never written back. Spans inside a **rendered markdown table** do not
  compute: the table widget replaces the region before the span decoration is
  reached. An empty `` `= ` `` is someone mid-keystroke, not an expression.

Agent note: read-time sugar, like calc lines. Writing the expression is the
whole job; never write a computed number back next to it.

### 5.11 Voice captures — `type: voice`

A voice note is **one markdown note plus one audio asset sharing a stem** —
nothing bespoke, no new file type:

```
Inbox/Voice 2026-08-04 14.32.md
.assets/Voice 2026-08-04 14.32.wav
```

```markdown
---
created: 2026-08-04
type: voice
captured: 2026-08-04T14:32:07
duration: 47
transcribed: 2026-08-04T14:32:19
title: mix down the pad before Friday
---
![[Voice 2026-08-04 14.32.wav]]

mix down the pad before Friday, it's fighting the vocal in the second drop
```

- **Filename** `Voice YYYY-MM-DD HH.mm`, minute-resolution, deduped by the
  ordinary create-collision rule (`Voice … 2.md`). The note is **never renamed
  by the transcript** — a stable stem is what keeps the note and its asset
  paired, so `title:` carries the readable name instead (§2 `title:` and the
  filename).
- **`captured`** — full ISO datetime of the recording's start. It is a *text*
  prop, not a `date` one: `date` is day-resolution (§4), and the time is the
  point.
- **`duration`** — seconds, a `number` prop.
- **`transcribed`** — ISO datetime the transcript landed. **Absent means
  pending**: that, plus the presence of an audio embed, is the entire
  pending-queue state — there is no queue file, so a crash mid-transcription
  costs nothing and the next launch re-enqueues by scanning for it. A re-run
  after such a crash **heals the note rather than doubling it**: a body that
  already ends with the transcript is left as it is.

  Two values are words rather than datetimes, because a queue whose only exit
  is success is a queue that never empties:

  - **`unavailable`** — the audio isn't on this machine. Voice audio is
    device-local, so this is the *normal* state on every machine except the
    one that recorded the note; without it, each of them would re-queue every
    voice note at every launch forever.
  - **`failed`** — the audio is here and the model could not read it. Retrying
    it at each launch would only push the notes that can still succeed further
    down the queue.

  Both are ordinary frontmatter you can see and delete, and deleting one asks
  for the note to be tried again — the same gesture as clearing a datetime.
- **`title`** — the transcript's first line, trimmed to 60 characters, written
  by the engine once the transcript arrives. Before then the note wears no
  `title:` and shows as its filename.
- **Body** — the embed first, then the transcript as **plain prose, never
  inside a code fence**: machine fences are blanked out of the search index
  (§12), and a transcript that can't be searched defeats the feature. `*no
  speech detected*` is written when the recorder heard nothing, and
  `transcribed:` is still set — silence is an answer, not a pending job.
- **Audio is device-local.** `.assets/` is excluded from history and from the
  sync leg (§9, §11), so a voice note syncs as text — frontmatter, transcript,
  and a `![[…]]` that resolves only on the machine that recorded it. This is
  the designed shape, so `vault_doctor` reports such an embed as a **warn**,
  not an error (§15).
- Voice notes are a real database and stay in the Notes stream while unfiled.
  `voice` is a plain schema type that appears the way every type does — from
  notes carrying it; nothing seeds it, and its home folder (§6) is yours to set
  like any other database's. The double membership is deliberate: the capture
  stream is complete only if what you captured is in it. Moving one out of
  `Inbox/` promotes it out of Notes like any other note.

- **A discarded recording is not deleted immediately.** Escape in the capture
  window throws the recording away, but the WAV moves to
  `<app config>/recordings/discarded/` and is swept a week later, so a
  mis-hit Escape on a long thought is recoverable from the app dir. Past ten
  seconds Escape asks first: the recording keeps running and a second Escape
  discards it. Nothing under `discarded/` is ever filed as a note.

An external writer needs no special support: delete the note and the asset
orphans normally; delete the asset and you keep a transcript. Removing
`transcribed:` from a voice note that still has its audio is how you ask the
app to transcribe it again.


## 5b. `.vault/format.json` — config format versions (covers §6–§8e)

One sidecar records which format version each hidden config file is in
(`src-tauri/src/vaultfmt.rs`). It exists because two app versions can share a
vault — phone⇄Mac sync, a laptop that hasn't updated, a restored backup — and
an older app rewriting a newer file used to silently drop what it didn't
understand.

```json
{ "schema": 1, "views": 1, "folders": 1, "notifications": 1, "calendars": 1, "kinds": 1, "tagfolders": 1, "mounts": 1, "reflexes": 1, "statementmappings": 1, "statementrules": 1 }
```

- Keys are `schema`, `views`, `folders`, `notifications`, `calendars`,
  `kinds`, `tagfolders`, `mounts`, `reflexes`, `statementmappings`,
  `statementrules` (§5c, §6, §7, the notification sub-section, §8, §5.8, §8b,
  §8c, §8d, §8e). Current version for all eleven: **1**.
- `kinds` versions the **bundle format** of §5.8, not any one file: it says
  which shape of `kind.json` and which bundle layout the vault's
  `.vault/kinds/` folders are written in. **RESERVED** — the key is defined
  by the format unit that documents §5.8, and nothing reads or enforces it
  yet. §5.8's loader and enable flow ship without it: an out-of-range `api`
  in a manifest is already refused per bundle, on a card. Refuse-newer for
  the sidecar key — a version above what the app knows means this build does
  not understand the vault's bundles well enough to enable any of them — and
  the surface that says so are still to come.
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

**`.vault/backup/` also holds one non-format artifact**. The
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
├── views.json            # sidebar pins/keys, retargeted when sidecars move
├── format.json           # the version stamps the writes above bump
└── notes/<rel>.md        # every note of every mapped type, at its vault path
```

- The copy set is the migration's **write set**, file for file: everything it
  rewrites is in there, so a hand-restore puts the vault back where it started.
  `views.json` is in the set because moving a sidecar into `Mounts/<name>/`
  retargets that note's sidebar pin and its assigned key (§7).
- It is a **plain file copy**, restorable by hand — no app command reads it
  back. History-enabled vaults get the snapshot and no duplicate backup.
- It is staged under a dot-prefixed sibling, fsynced, and renamed into place
  last, so a directory under the real name is always a complete backup. The
  copies are durable before the rename, so the artifact survives a power loss
  as well as a process crash; the rename itself is best-effort durable (the
  parent dir is fsynced after it, failure there is not data loss).
- If the backup cannot be written, the migration **defers** exactly as it did
  before and the vault is left untouched — no rewrite without a recovery point.
- One backup **per migrating launch**. A launch with nothing migratable — no
  mappings left, or only mappings the migration cannot convert (a mapping with
  no `type` is left in place) — writes nothing, so a vault does not accumulate
  a backup dir per launch. A vault that reaches the terminal state in one run
  therefore ends with exactly one; an interrupted run retried on the next
  launch leaves one per attempt. An existing backup is never overwritten: a
  same-millisecond collision bumps the stamp instead.
- Nothing prunes these; they are safe to delete once the mounts look right.

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
  settings cannot appear to work. The doctor also reports it as
  `corrupt-config` (§15) — with this loud-refusal consequence, not the
  read-as-empty clause the other config files get.

## 6. `.vault/schema.json` — database schema

Per-type property schemas. Notes keep plain YAML values; this file only drives
pickers, option order, dot colors, and database icons in the UI — deleting it
loses no data. Missing or corrupt JSON reads as empty; the next write recreates
it (pretty-printed, 2-space indent; key order unspecified — it's a hash map).
A corrupt file is additionally reported by `vault_doctor` as `corrupt-config`
(§15) — the fallback is silent to the reader, not to the user.

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

- `icon` — reserved key holding the database's icon, omitted when the
  type has none (the UI then shows the auto-glyph: first letter in a rounded
  square). A user prop literally named `icon` is shadowed by it — the key is
  reserved. A type entry holding only an icon (no props) is valid and keeps the
  icon alive when every prop demotes out.
- `home` — reserved key holding the database's home folder: a
  vault-relative slash path, validated like any folder path on write
  (`vault/schema.rs` `set_schema_home`); blank or absent means no home. When set, the
  database nests into the sidebar Folders tree at that folder — the folder's
  row keeps its on-disk name and gains a DB chip, clicking it opens
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
  `"text"` = explicit free text: a schema-registered text column that
  survives the demote rule, so the column shows for every entry even with no
  values; `"date"` = ISO-day value (optionally carrying ` HH:MM`)
  with a calendar picker (`notify` = macOS alert on the day; `notifyBefore` = an ADDITIONAL lead-time alert that many days earlier — date-kind only, independent of `notify` so either may stand alone, 0/absent = off and anything longer than 365 clamps); `"file"` = path link (§4); `"relation"` = a typed link to
  entries of the database named by the entry's `"type"` key (stored as the
  target's title/stem or a YAML list, rewritten on rename); `"multi"`
  = a select with several values per note — options/colors exactly like
  select, but the note's value is a YAML string list (`format:\n  - Vinyl\n
  - Digital`), one value per option, each rendering its own dot. A scalar is
  legal for one value (`format: Vinyl`); an emptied list removes the prop,
  same as relation values. The picker toggles membership instead of
  replacing, and `key:value` filters match each list entry per value (§7's
  OR syntax pairs naturally). `"url"` = an external link: the value
  is the plain URL string (no migration, no wrapper), rendered as a clickable
  link — display text is the stripped title (no scheme, no `www.`, no
  trailing slash; `urlDisplayTitle` in `src/lib/url.ts`), clicking opens the
  system browser, editing shows and edits the raw URL. `"email"` / `"phone"`
  = contact links: the value is the plain string exactly as typed
  (no stripping — unlike url), rendered as a clickable link that opens
  `mailto:<value>` / `tel:<value>` with the OS handler; for `tel:`, spaces
  and dashes strip from the dialed number only, never from the displayed
  value (`contactHref` in `src/lib/url.ts`). `"checkbox"` = a
  boolean: checked stores the YAML scalar `true`; **absent/empty means
  unchecked — unchecking removes the prop rather than writing `false`**
  (keeps frontmatter clean; a stored `false` still reads as unchecked).
  Cells and note chips render a small check square that toggles on one
  click — no editor popup — and display surfaces read "✓" / blank.
  `"number"` = a numeric column: the value stays exactly what's
  stored today (a plain YAML scalar — string or number, no migration), the
  optional `format` field below shapes only the display; table cells
  right-align, editing shows the raw stored string, and a non-numeric
  value renders exactly as typed — never destroyed, never hidden.
  `"rollup"` = a DERIVED column, wired by the
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
  models `type`. `"euro"` renders the amount in the `number-locale` dialect
  (§12) with a trailing ` €` — `1.234,56 €` under the de-DE default, 2
  decimals only when the value has decimals; `"percent"` renders
  through the same path with a ` %` suffix — `8,5 %`, `1.250,25 %` under
  de-DE (the stored number IS the percent —
  no ×100 math); `"plain"` is the default and stores
  as absent (the key is omitted). The same field also names the
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

  The same field may equally name a **unit**: any code from the
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
- `relation` — rollup-kind only: the NAME of the relation prop on
  the same database to follow (not a database name — the relation prop's own
  `type` names the related database). Required on write; it must already
  exist as a relation-kind prop of the same database (matched
  case-insensitively). Renaming that relation prop retargets the reference
  (same-database sweep); a `relation` arriving on any other kind drops.
- `prop` — rollup-kind only: the prop on the RELATED database to
  read. Required on write (any non-empty name — the related database's
  schema is not consulted). Renaming that target prop DOES retarget the
  reference: every rollup that reads it through a relation pointing
  at the renamed prop's database has its `prop` rewritten, case-folded — see
  the rollup sweeps below.
- `agg` — rollup-kind only: the aggregation over the linked rows'
  values — `sum` | `avg` | `min` | `max` | `count`, the table footer's
  Calculate vocabulary (`src/lib/aggregate.ts`). Refused on write
  outside the vocabulary; an `agg` arriving on any other kind drops.
- `description` — any kind, kindless select props included: a
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

### Rollup properties — derived columns, stored nowhere

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
  renders in the app's number dialect (§12 `number-locale`), and behaves like a numeric
  column everywhere else: it can be footer-aggregated, numerically sorted,
  filtered, and exported. It never groups a board or table (a board drag
  writes the group prop).
- Rollups read STORED values only: a rollup naming another rollup as its
  target prop reads nothing, because derived values never land in props.
- Sweeps: renaming the followed relation retargets `relation` (same
  database); renaming the rollup itself moves its schema entry like any
  prop; renaming the TARGET prop on the related database retargets `prop`
  on every rollup that reads it through a relation pointing at that database
  — including a rollup on the same database through a
  self-relation. Both directions match case-insensitively, the way the
  evaluator resolves schema keys and `type:` values; a rollup whose relation
  targets a different database keeps its `prop` even when the renamed name
  collides. Deleting the followed relation degrades the rollup to empty —
  never to an error.

### `.vault/notifications.json` — due-notification state

Fired/snoozed state for §6's `notify: true` / `notifyBefore` date props (`src-tauri/src/notify.rs`),
persisted so a due date never refires across restarts. App-owned — external
writers should leave it alone (a missing or corrupt file just reads as empty
state, so deleting it means today's already-fired dues fire again; a corrupt
one also shows up as `corrupt-config` in the doctor, §15).

```json
{
  "fired":   { "Inbox/Call Gero.md|due|2026-07-17": 1752742800 },
  "snoozed": { "Releases/SMP-031.md|deadline|2026-07-21": 1752861600 }
}
```

- Keys are `<note path>|<prop>|<YYYY-MM-DD>` (the due date — the occurrence
  day for a recurring note); values are unix seconds — for `fired`, when it
  fired; for `snoozed`, quiet-until.
- A **lead-time** alert (`notifyBefore: n`) keys as
  `<note path>|<prop>|<YYYY-MM-DD>|lead` — the date stays the DUE date, not
  the day the alert fires, so the lead and the day-of alert of one occurrence
  carry distinct keys and fire independently. The trailing `lead` marker only
  counts as a marker when it is the final segment AND the segment before it
  parses as a date, so a prop literally named `lead` still keys and parses
  normally. Lead alerts fire at the value's own `HH:MM`, else 09:00, on
  `due − n` days; they snooze exactly like day-of alerts.
- A **sheet cell** alert (SUB-876, §5.1's `columns:` map) keys as
  `<note path>|<column>#<row>|<YYYY-MM-DD>[|lead]` — the same shape with the
  prop segment split by `#` into the column header and the row. **The row is
  identified by its first-column label cell, never by index**, so a sheet that
  is sorted or has rows inserted keeps firing the same keys, and a renamed row
  reads as a new one. A row whose label cell is empty has no identity and stays
  quiet. Column and row are matched case-insensitively, and both are
  percent-escaped in the key (`%` `|` `#` CR LF → `%25 %7C %23 %0D %0A`) so
  arbitrary header and cell text can't split the key in the wrong place. A
  database property is resolved first, so a property whose name literally
  contains `#` still reads as itself. Sheets carry no `repeat:` — a cell is due
  on its own date and no other.
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
  asleep through the heads-up still gets told on the day. Snoozing moves the key from
  `fired` to `snoozed` (later today / tomorrow at the prop's fire time).
- **A snooze that outlives its occurrence day still fires**:
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
  that means the key's day is no longer an occurrence. For a sheet key
  (SUB-876) the same test reads on the grid: the column left the `columns:`
  map or the header row, the labelled row was renamed or deleted, or the
  cell's date changed. (The entry itself
  stays in the map until the 14-day prune — if the vault changes back
  within that window, the snooze fires then.)
- Entries whose due date is >14 days past are pruned on scan, keeping the
  file small. The file is device-local and **excluded from vault history**
  (§11, `.git/info/exclude`) — the scheduler writes it off the engine lock,
  so tracking it let it dirty the tree mid-resolve.
- Unknown top-level keys are preserved across app writes. The
  file's format version lives in `.vault/format.json` (§5b); a version newer
  than the app knows makes the file read-only — the scheduler still honours
  what's on disk, it just stops persisting changes.

### `.vault/jobs-exit.json` — launchd exit-status rings

Recent run outcomes for the jobs dashboard (`src-tauri/src/jobs.rs`):
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
  lock. Unknown top-level keys are preserved across app writes.
- Deliberately NOT versioned in `.vault/format.json` (§5b): the state is
  disposable and self-healing, so there is nothing to migrate and nothing a
  newer app could destroy that observation won't rebuild.

## 7. `.vault/views.json` — layout preferences, sidebar order, saved views

Per-database layout choice, same file discipline as schema.json:

```json
{
  "release": { "view": "board", "group_by": "status", "sorts": [{ "key": "released", "dir": -1 }], "hidden": ["notion_id"] },
  "gear": { "view": "table", "table_group_by": "category", "aggregations": { "price": "sum", "manual": "count" }, "col_order": ["category", "price"] },
  "$sidebar": { "dashboards": ["Dashboards/Portfolio.md"], "collapsed": ["folders", "dashgroup:Dashboards/Money"], "folders": ["Projects", "Inbox"], "dashgroups": ["Dashboards/Money"], "pins": ["Inbox/Studio setup.md"], "keys": { "ctrl+1": "today", "mod+2": "dash:Dashboards/Portfolio.md", "mod+3": "db:gear" } },
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
- `table_group_by`: optional; the prop a table groups its section
  rows by. A separate key from `group_by` — a table never inherits the
  board's grouping and vice versa. Sections follow the schema's option order
  (unschema'd values after, alphabetically), the "No <prop>" section trails,
  empty sections don't render. Omitted when unset. `vault_rename_prop` /
  `vault_clear_prop` (§4) keep this key in sync like `group_by`.
- `aggregations`: optional; the table layout's per-column footer
  calculations — column name → one of `sum`, `avg`, `min`, `max`, `count`
  (`count` = non-empty cells; the rest parse cells as numbers and skip
  non-numeric ones). An absent column key means no calculation. Computed over
  the rows visible in the table (view filter applied). Omitted when empty.
  `vault_rename_prop` / `vault_clear_prop` (§4) keep these keys in sync —
  moved or dropped in place, so a footer never keys on a stale prop.
- `sorts`: optional; the database's remembered sort — the same
  ordered `{ "key", "dir": 1 | -1 }` list a saved view's `sorts` carries
  (validation matches: `dir` other than ±1 is rejected; an empty list stores
  as absent). Header clicks write it, so a sort survives navigating away.
  A saved view's own sort still overrides inside that pin.
- `col_order`: optional; the TABLE's column order — the ordered prop
  keys a header label drag left behind (a board's own column order is the
  group prop's option order, not this key). The Name column is frozen first
  and never appears here. On read the list is a preference, not the column
  set: entries naming no current column are ignored, duplicates collapse, and
  every column the list doesn't mention keeps its default position after the
  listed ones — so a prop added after the drag appends instead of jumping.
  A drop writes the full rendered order, including columns the drag didn't
  touch. Entries trim on write, empties drop, an emptied order stores as
  absent, and names are canonicalized to the column's actual casing. Ordering
  rides both channels: a database persists it here, while a saved-view pin
  reorders session-locally and captures the order into its own `columns`
  shown-list on re-save. `vault_rename_prop` / `vault_clear_prop` (§4) keep
  these entries in sync like `sorts`/`hidden` — renamed in place, dropped with
  the prop (an emptied list leaves the file).
- `hidden`: optional; prop names hidden from the database's
  table/list columns (the header right-click checklist / a column caret's
  "Hide property"). Absent or empty = everything shows. Names are stored
  verbatim; entries naming no current column are inert but kept. The inverse
  of a pin's curated `columns` shown-list — a prop added later shows by
  default here, stays hidden in a curated pin. This flat list
  is only the SEED a layout without its own `hidden_per_layout` set falls
  back to on read — older files carry just it, feeding both layouts
  (backward compatible), and the first per-layout write replaces it.
  `vault_rename_prop` / `vault_clear_prop` (§4) keep `sorts` keys and
  `hidden` entries in sync like `group_by` — renamed in place, dropped with
  the prop (emptied lists leave the file).
- `hidden_per_layout`: optional; `{ "table": [...], "list": [...] }`
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
- `widths`: optional; table column widths in px, prop name →
  integer width (the header drag handles). The reserved `title` key sizes
  the Name column — real prop names never collide with it (it's not a
  column key). Zero-width entries are dropped on write; an emptied map
  stores as absent. Clamps (60–800px) are the UI's business — the engine
  stores what it's given.
- `wrap`: optional; prop names whose table cells wrap instead of
  clipping to one line (a column caret's "Wrap text"; `title` names the
  Name column here too). Absent or empty = everything clips. Entries trim
  on write, empties drop.
  `vault_rename_prop` / `vault_clear_prop` (§4) carry `widths` keys and
  `wrap` entries along like `sorts`/`hidden` — renamed in place (an entry
  already at the new name wins), dropped with the prop.
- `card_order` (SUB-948): optional; the board's hand-arranged card order —
  vault-relative note PATHS, one flat list covering every column (a column
  reads its own members out of it in sequence, so only relative order within
  a column matters). Written only by a within-column drag on an UNSORTED
  board; a board with `sorts` keeps the list on disk and unread, because
  there the sort owns the order. Entries naming no live note are inert but
  kept, and a note the list doesn't name appends after the ones it does — so
  a note created, renamed, or deleted outside the app costs at most its own
  entry, never the arrangement. Renaming or moving a note (or a folder full of
  them) INSIDE the app retargets the entries instead, so the card keeps the
  slot it was dragged to; trashing leaves the entry alone — it is inert while
  the note is gone and picks its slot back up if the note is restored to the
  same path. When that path was taken over meanwhile, the restore comes back
  under a numbered name and retargets the entry to it (SUB-1139), so the slot
  follows the note rather than the path. Entries keep their exact spelling, blanks aside: a path's leading
  or trailing spaces are part of the filename. Deliberately NOT a note prop:
  an arrangement is a view's opinion, so it never touches the note files.
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
rewritten. Current reserved keys:

- `$sidebar` — sidebar section ordering and collapse state: `dashboards`
  is a drag-ordered array of note paths; entries not in the list append after,
  stale entries are dropped by the UI. `databases` (type names) is the same
  shape but **legacy — preserved, no longer written**: it ordered a flat
  Databases section the sidebar does not have any more, each database now
  reaching its rows through its home folder. The engine still carries the
  field, round-trips it whole, and still retargets its entries when a database
  is renamed or deleted, so an older file keeps its order intact — but no UI
  writes it, and a vault started today never grows one. Read it as history,
  never as a description of the sidebar in front of you.
  `dashboards` is ONE flat list shared by several surfaces, the
  same shape `folders` and `pins` use below: the Dashboards section's own rows
  are one group, and each content folder whose tree row hosts dashboards is
  another, so only relative order within a group matters. A dashboard note
  living OUTSIDE the dashboards home folder renders under its folder's row in
  the Folders tree instead of in the Dashboards section (never both), so moving
  a dashboard between folders can change which surface owns it — the entry
  follows the path either way.
  `dashgroups` is the Dashboards section's second lane: a
  drag-ordered array of vault-relative FOLDER paths, one per subfolder GROUP
  HEADER shown in that section. It is separate from `dashboards`
  because a group header orders against its sibling headers, never against
  the dashboard note rows — an array of strings like `folders`, with the same
  append-unlisted / drop-stale handling. Renaming or moving a group folder
  retargets its entry and its whole subtree, and carries the `dashboards`
  rows inside the folder along with it; trashing the folder drops them.
  Omitted (and read as empty) when nothing is ordered — a views.json written
  before this field existed loads unchanged.
  `folders` is the same shape for the
  Folders tree: ONE flat list of vault-relative folder paths at any depth —
  each sibling group (the roots, or one folder's children) reads its own
  members out of the list in order, so only relative order within a group
  matters and unlisted folders append alphabetically; a folder rename
  retargets its entries (subtree included), trashing a folder drops them
  (parked in the trash sidecar, restored with the folder — §10). `pins`
  lists pinned note paths, in row order — any note, database-typed
  or not. A pinned note's row renders under its home folder's row in the
  Folders tree; pins with no tree row (vault root, Journal,
  Dashboards) render in the flat Pinned section. The list is again one flat
  order, each surface reading its own members in sequence. Renaming or moving
  a pinned note retargets its entry (a folder rename
  carries the pins inside along), trashing the note or its folder drops it,
  and a path with no live note simply doesn't render. `keys` maps a
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
  `collapsed`
  lists the chevron-collapsed sidebar rows, in two shapes. Three are section
  ids — `"dashboards"`, `"pinned"`, `"folders"`; the fourth entry shape is
  `"dashgroup:<folder>"`, one per folded subfolder GROUP HEADER in the
  Dashboards section (the `dashgroups` rows above), the folder path spelled
  the same way. A group id follows its folder on rename, subtree included,
  and is dropped when the folder is trashed. It is also dropped on the next
  collapse write once its group retires — the last dashboard leaving a
  subfolder retires the header, and a surviving id would silently re-fold
  that folder if a dashboard ever moved back in. Folder rows in the Folders
  TREE collapse too, but that state is session-local by design and is not
  written here: only the top-level sections and the dashboard groups persist.
  Omitted when nothing is collapsed.
  Three ids are **historical** — read (and preserved) but never written, so
  they appear only in files an older build touched: `"databases"`, the
  retired flat Databases section; `"dbpins:<type>"`, one per database whose
  saved-view pins were folded, from before pinned views moved to a section of
  their own; and `"savedviews"`, from when that section itself carried a
  chevron. All three ride along untouched on write, the way any unrecognized
  entry does — with two wrinkles worth knowing: renaming a database does NOT
  retarget a `"dbpins:"` id (only `databases` and `keys` are remapped), and
  pinning a saved view actively strips `"savedviews"` from the list, so a
  freshly pinned view can never land inside a folded section.
- `$folders` — per-folder metadata, keyed by vault-relative folder
  path (slash-joined, as in the sidebar tree). Currently one field: `icon`,
  a database icon (`emoji` or curated `glyph` id,
  optional muted `tint` name — same normalization: emoji wins over glyph,
  tint only with a mark, no mark removes the entry). A folder rename
  retargets its keys, subtree included; trashing a folder drops them (parked
  in the trash sidecar, restored with the folder — §10). An
  emptied `$folders` map drops the key from the file.
- `$views` — saved views: an **ordered array** (pin order in the
  sidebar) of named queries over one database. Fields: `id` (stable slug,
  unique), `name`, `db` (type string), optional `query` (the operator
  syntax, stored verbatim — bare words match the note title; a comma-separated
  value is an OR over one prop, e.g. `status:live,"in review"` —
  quote any segment containing a space or comma; date props also
  take comparisons: `due < 7d` / `released >= 2026-01-01`, with `Nd`/
  `Nw` durations measured from today), optional
  `sort` (`{ "key": <prop or "title">, "dir": 1 | -1 }`), optional `sorts`
  (the full ordered key list of a multi-key sort — sorting is
  lexicographic over it, secondary keys are shift-clicked in the table
  header, the list caps at 3. Written only when 2+ keys are active; `sort`
  always mirrors the first key so older readers keep working, and readers
  treat a view as `sorts ?? (sort ? [sort] : [])`), optional `view` /
  `group_by` / `table_group_by` (layout and grouping overrides; absent falls
  back to the database's own pref), optional `columns` (the ordered
  property keys this view renders in table/list layouts, the title column
  always leading; absent = the database's default column union, keys naming
  no known column are ignored).
  Upserts match by `id` and keep position; validation rejects empty
  id/name/db, unknown layouts, and `dir` values other than ±1 (in `sort` or
  any `sorts` entry).

### Exported link folders — `.substrate-view`

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
- **The destination must be outside the vault**. A link folder in
  the vault is derived data in the one tree that syncs: the vault's git
  history would carry symlinks whose targets are absolute paths true on
  exactly one machine, so every other device restores them broken. The export
  is refused — before anything is created — when the destination canonicalizes
  to a path under the vault root, including reaching it through a symlink from
  outside. A folder merely *named* like the vault's sibling (`…/vault-exports`
  next to `…/vault`) is not inside it and is allowed.
- Sync/backup pipelines should skip these folders — they are derived, and
  following the links would duplicate vault content. The marker file is the
  reliable thing to exclude on. A sync tool with an *exclude-if-present*
  rule (`--exclude-if-present .substrate-view` and equivalents) drops the
  whole directory wherever the marker appears, without the pipeline having to
  know any export path — which is the point of keying on the marker rather
  than on a path, since the destination is the user's choice and device-local.
  Two things soften the risk in the meantime: most sync tools skip symlinks
  unless explicitly told to follow them (so a leg that never asked for
  `--copy-links`/`--links` copies only the empty shell today), and backup
  software that stores symlinks verbatim rather than following them
  duplicates nothing either. Both are incidental, not guarantees — the
  marker exclude is what makes the protection declared. Where a backup tool
  can only exclude by path, excluding the folder is optional: it is
  regenerable, and nothing in it is user data.

### `.vault/templates/<type>.md` — per-type entry templates

One optional markdown file per database type: its frontmatter becomes
create-time prop defaults, its body the starting body with `{{title}}` /
`{{date}}` substituted (`src/lib/templates.ts`; `{{date}}` is the creation day,
except calendar-created entries where it is the picked day). Hidden like
the rest of `.vault/` — never indexed, searched, or watched, so a template never
pollutes its own database. **The one hidden-path exception:** the note
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

Missing or corrupt reads as no mounts, same file discipline as schema.json —
including the `corrupt-config` doctor finding (§15) when the file is unparseable.
Mounts are added in-app — "Mount a folder…" from the sidebar Folders "+" menu
or the All-databases manager's row menu, which also runs the first scan — or
edited by hand (JSON array):

```json
[
  { "id": "9f1c…-uuid", "name": "Album pool", "globs": ["*.als"],
    "ignore": ["Backup", "*.asd"], "watch": true }
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
- `ignore` — optional; paths the mount deliberately doesn't see. Hand-written
  only: nothing in the app asks for one, and an absent list is written back
  absent, so a file from before this key existed round-trips byte for byte.
  A pattern **without** a slash matches an entry's own name at any depth
  (`Backup`, `*.asd`); a pattern **with** one matches the path relative to the
  mount root (`Old Sets/*`). A trailing slash is trimmed before that split, so
  `Backup/` names the same folder `Backup` does rather than silently matching
  nothing. Wildcard rules are `globs`' — case-insensitive,
  `*` only, spanning separators. A matching **directory is pruned whole** and
  never walked, which is the motivating case: Ableton writes a `Backup` folder
  of dated copies beside every set, and a database of a hundred projects
  showing nine hundred backups of them is not a database of projects. Adding
  the list later does not delete rows — the pruned files read as `missing` on
  the next scan and keep their sidecars, same as files moved away. The live
  watcher honours the same list: a save under an ignored folder is not a
  change to the mount, so it never wakes a rescan of it. A **drive**'s catalog
  walk honours it too, and prunes before its file ceiling applies — an ignored
  subtree is invisible to the catalog, so it does not spend the drive's
  budget or push real files into the over-cap count.
- `watch` — optional, default `false`. Opts the mount into the live watcher
  (below), and only takes effect on a machine where it is bound.
- Any other key is preserved verbatim across app writes. The file's
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
      "identity": "b1e0…", "missing": false,
      "extract_tried": true,
      "extracted": { "duration": 214, "sample_rate": 44100, "channels": 2,
                     "artist": "aya", "media_title": "Emley Lights Us Moor" } }
  ]
}
```

- `rel` — path relative to the mount root, `/`-separated, the row's key.
- `size`/`modified`/`created` — the intrinsic columns (`%Y-%m-%d %H:%M` and
  `%Y-%m-%d`, local). Row `name` and `extension` are derived from `rel`.
- `identity` — the file's **content identity** (below); what sidecars bind to.
- `missing` — the index remembers the file and the last scan didn't find it.
  Such a row is kept and greyed, never dropped, and keeps its sidecar.
- `extracted` / `extract_error` / `extract_tried` — what was read out of the
  file itself (below). All of them default and are omitted when empty, so an
  index written before extraction existed reads back unchanged. A document's
  own body **text is not here** — see the machine-local store below.

**Extracted columns** (`vault/extract.rs`, `vault/extractq.rs`): opening files
is slow, so a scan never does it. The scan writes the index and returns;
un-read files are handed to a bounded background queue, and each finished file
is merged back into the index, which is how the board fills in behind a scan.

- `extracted` — a flat object of column name → value, merged into the row's
  props **last**, so they behave as ordinary sortable/filterable columns.
  Audio (`lofty`): `duration` (seconds), `sample_rate`, `channels`, plus
  `artist` / `album` / `media_title` where the file carries tags. PDF
  (`lopdf`): `pages`, plus `media_title` / `artist` from the Info dictionary.
  Ableton projects (`flate2` + `quick-xml` — an `.als` is one gzipped XML
  document): `als_tempo`, `als_key` (root note plus scale name, which only Live
  12 and later record), `als_tracks`, `als_version` (what the writing app
  called itself). Every field is independently optional, because attribute
  names and positions move between Live versions: a set that doesn't carry
  one leaves that cell empty rather than failing the row. The `als_` prefix is
  deliberate — a folder holding both stems and the session that made them
  would otherwise show one `tempo` column filled by two unrelated readers.
  A project's **track and device names** are its text (below), which is what
  makes a set findable by what it is built out of rather than by its filename.
  Text values are clamped; a file that carries none of them contributes no
  keys at all. The file's own title is `media_title`, never `title` — `title`
  is the row's heading throughout the note pipeline and is dropped as a column
  name, so extracting into it would store a value nothing ever shows.
- **Document text is machine-local and never in this file.** A PDF's own body
  text is read on the same open that reads its page count, and it is stored
  in the OS app-config dir — `mount-text/<id>.json`, beside `config.json` and
  beside the mount's path binding — never in the vault. The reason is the
  privacy line mounts are built on: this index syncs and is committed to
  version history, while the text belongs to a file **outside** the vault, so
  an excerpt kept here would put a copy of someone's contract or tax return on
  the sync remote and keep it there forever. **The sync contract is
  unchanged:** a machine without the mount bound gets rows, counts, titles and
  extracted columns exactly as before, and no external file's text ever
  reaches the sync remote or vault history.
- `extract_error` — why that one file couldn't be read. The row survives with
  the value simply absent; a malformed file never fails the scan.
- **Size caps.** The parsers size buffers from numbers the file declares, and
  an allocation that large aborts the process rather than raising an error, so
  a file is refused *unopened* past a per-kind cap (`extract::size_limit` — 64
  MiB for PDF, 1 GiB for audio, 32 MiB for `.als`) and a single PDF stream may
  not inflate past 16 MiB. How far a compressed file expands is the file's
  choice rather than the reader's, so the `.als` path is capped twice over: a
  set that inflates past 256 MiB stops being read there. A file over the cap is
  skipped at scan time: it keeps its row and its intrinsic columns, contributes
  no extracted values, and is skipped again on every later scan rather than
  being marked tried.
- `extract_tried` — set once the file has been through the queue, however it
  went. It is what stops a file being re-opened on every scan, and it is
  **the cache**: a rescan carries all of them forward whenever the content
  identity still matches, so an unchanged file is never read twice, across
  launches included. Content changing gives the row a new identity, which
  drops the carry-forward and re-offers the file. These columns are read-only
  the same way the intrinsics are — annotating one is refused.

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

### `mount-text/<id>.json` — document text, machine-local, never synced

One file per mount in the OS app-config dir (`vault/mounttext.rs`), holding
what a document *said*. It is deliberately not vault data: the files it quotes
live outside the vault, so their text stays on the one machine that can open
them, next to the path binding that says where they are.

```json
{ "version": 1,
  "files": {
    "papers/spectral morphology.pdf":
      { "identity": "b1e0…", "text": "Granular resynthesis of…", "truncated": true }
  } }
```

- Keyed by the same `rel` the index uses, plus the `identity` the text was
  read from — text whose identity no longer matches the indexed file describes
  bytes that are gone, and reads as a miss rather than as stale text.
- `truncated` — a cap ended the excerpt rather than the document ending it.
  The text is capped twice on the way in — at 10 pages read and 4 KiB emitted,
  whichever binds first. Word boundaries are kept where they exist; an
  unbroken run of glyphs is cut on a character boundary. PDFs and Ableton
  projects carry text — a project's is its track and device names, deduplicated
  and capped at 4 KiB; audio files contribute none.
- `capped` — the file was read and its text dropped because the store was
  full. The store is parsed and rewritten whole on every extraction batch, so
  its size is work and not only disk: it holds **2 MiB** of text per mount,
  roughly 500 documents at the 4 KiB cap. Recording the file even when its
  text is dropped is what stops a full store re-offering the same files on
  every scan forever.
- **It is a cache.** Deleting the file, or losing the whole config dir, loses
  nothing a rescan cannot rebuild; a machine that has never bound the mount
  simply never has it.
- **When it goes.** Unmounting drops it, and so does unbinding — the mount and
  its index stay, but this machine can no longer open the files the text came
  out of, and a later re-bind reads them again. Beyond that, the app sweeps
  this dir on vault load and drops every `<id>.json` no mount of the loaded
  vault can name (`mounttext::collect`). That sweep is what covers the case
  neither of the others sees: the dir belongs to the **app**, not to the
  vault, so pointing the app at a different vault would otherwise strand the
  previous one's mount ids here forever, at up to 2 MiB each, with nothing
  left that enumerates them. Only files this format could have written are
  candidates — a name no valid mount id could produce is left alone.
- **Migration.** The store starts empty — on a new machine, and on this one
  after an upgrade from a version that had no text at all. Rows indexed before
  it existed already carry `extract_tried`, and that flag keeps its old
  meaning (the *columns* are cached). So a file that is `extract_tried` with
  no store entry is offered to the queue **once more**, for its text only, and
  the entry that reading leaves ends it — including when the document had no
  text to give and when the reader failed outright, both of which record an
  empty entry. The re-offer is narrowed to formats that carry text
  (`extract::carries_text`), so upgrading with a 40,000-file sample library
  mounted re-reads nothing.

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
- **Sealed sidecars block annotation** — accepted cost. A locked sealed note
  indexes with no props at all, so the engine cannot tell whether it is the
  sidecar for the row being annotated; writing a new one would silently
  duplicate it. Refusing is deliberate: the alternative is two divergent sets
  of props for one file.

  Nothing outside the ciphertext records the binding, so the block is a
  suspicion drawn from the two things a sealed note still shows — where it
  sits and what it is called (`mounts.rs::sealed_note_shadowing_row`):

  - a sealed note *anywhere* under `Mounts/<name>/` makes annotating **every**
    row of that mount refuse — that folder is where sidecars are filed;
  - a sealed note *anywhere in the vault* whose filename could be the one this
    row's sidecar was given makes **that row** refuse. This is the sidecar
    moved out of the shadow folder by hand and then sealed: the move keeps the
    name, and the name is all that survives sealing. The whole collision
    family counts — a sidecar filed when a sibling already held the plain name
    is uniquified (`track` → `track 2`), and the suffixed one has to be seen
    too.

  The refusal names the sealed note standing in the way. Unsealing it, or
  renaming it out of the way, clears the block. Note that unlocking a sealed
  note for the session does **not** clear it: the index entry stays propless
  either way.

  Residual gap: a sealed sidecar whose **filename no longer matches the row** —
  the user renamed it, or anything else did — shows nothing to match
  on and is still invisible — a second sidecar can be filed beside it. Closing
  that needs the `mount` binding recorded outside the ciphertext, in an
  authenticated carrier that does not itself leak which notes are sidecars of
  which mount. No such carrier exists in the format today.

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
history snapshot — or, where history is unavailable, the file backup of §5b:
a mount is created carrying the mapping's type name, globs
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
§6–§8: missing or corrupt reads as no folders — and a corrupt one is reported
by `vault_doctor` as `corrupt-config` (§15), so the folders vanishing is never
silent even though nothing errors.

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
- Any other key is preserved verbatim across app writes, and the
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

## 8c. `.vault/reflexes.json` — file-event rules

A JSON object of rules that say "when this happens to a path that looks like
this, and these props hold, do this" (SUB-826). **Data, not code**: no
expressions, no scripting, no agent in the loop — a closed set of five verbs
over a closed set of events, so the file syncs, diffs and hand-edits like any
other config, and the worst a malformed rule can do is not run. Missing file =
no rules, which is the normal case.

```json
{
  "version": 1,
  "paused": false,
  "rules": [
    {
      "id": "file-new-masters",
      "description": "drop new masters into the pool",
      "on": { "event": "note.created", "path": "Inbox/*.md" },
      "if": [
        { "prop": "type", "equals": "master" },
        { "prop": "status", "missing": true }
      ],
      "do": [
        { "move": { "to": "Masters" } },
        { "set_prop": { "prop": "status", "value": "new" } },
        { "tag": { "tags": ["master", "{{prop.label}}"] } },
        { "notify": { "message": "New master: {{filename}}" } }
      ],
      "enabled": true,
      "dry_run": false
    }
  ]
}
```

- **Nothing runs until the vault is enabled on this device.** A `reflexes.json`
  can arrive by sync, shared folder or restored backup, so the first one a
  device sees shows as paused behind one switch in Settings → Reflexes. The
  consent lives outside the vault, in app config, per vault per device; one
  enable covers the feature forever (the verb set is closed, so no later rule
  edit reaches something the enable did not already cover). `"paused": true` at
  the top level is a second, in-file kill switch the author controls.
- `id` — `[a-z0-9][a-z0-9-]{0,39}`, unique in the file. Names the rule in
  receipts, settings and doctor findings.
- `on.event` — one of `note.created`, `note.changed`, `note.removed`,
  `mount.file_added`. The namespace is dotted because `schedule.*` and friends
  are future work; an unknown event invalidates its rule rather than being
  guessed at. `mount.file_added` fires from the mount folder watcher for each
  file a mount scan sees for the first time — its `on.path` glob and `{{file}}`
  match the *mount-relative* path, with the mount's name in `{{mount}}`. A
  mount's very first scan deliberately fires nothing: that scan meets the whole
  folder at once, and replaying it as arrivals would be the catch-up sweep
  reflexes are explicitly not.
- `on.path` — optional glob against the vault-relative path, the same matcher
  the rest of the vault uses. Absent = every path the event fires for.
- `if` — an AND-list. Each clause is `{ "prop": …, "equals" | "contains" |
  "exists" | "missing": … }`, exactly one test per clause. Comparisons are
  case-insensitive; a present-but-empty prop counts as absent.
- `do` — the ordered verb list. `move` (engine rename, so wikilinks follow;
  destination folder created; collisions dedupe-rename), `set_prop`
  (only-if-empty unless `"overwrite": true`), `tag` (additive, deduped),
  `create` (skip-if-exists, optional `template` naming a
  `.vault/templates/<type>.md`), `notify` (the only noisy verb, capped at 3 per
  burst then one collapsed line). **There is no delete verb and there never
  will be one.** `move`, `set_prop` and `tag` need a note on disk, so a rule
  using them on `note.removed` or `mount.file_added` is invalid at load time.
- `enabled` (default `true`) and `dry_run` (default `false`) are per rule. A
  dry run evaluates fully and records what it *would* do, writing nothing.
- **Placeholders**, no expressions: `{{path}}`, `{{title}}`, `{{filename}}`,
  `{{prop.X}}`, plus `{{file}}` and `{{mount}}` on mount events. An unknown
  name — or one not available on that event — invalidates the rule.
- **Validation is per rule, and a rule is all-or-nothing.** An invalid rule is
  reported (Settings → Reflexes, `vault_doctor` §15) and skipped; it never runs
  partially and never takes the rest of the file down. The file itself only
  fails to load when it isn't the shape of a reflexes file at all — and then
  nothing runs, rather than degrading to "no rules".
- **Rails.** Actions are idempotent; a reflex-written path is remembered for
  10 s so cascades stop at depth 3 with a `cascade-stopped` receipt; each
  rule×subject pair has a 60 s cooldown; five consecutive failures auto-pause a
  rule (runtime only — the file's `enabled` is untouched, and any edit to the
  file re-arms it). Failing rules are never an OS notification.
- Rules never read or write outside the vault root, never under `.git/`,
  `.assets/`, `.trash/` or `.vault/` (including this file), never over the
  network and never exec anything. `..`, absolute paths and dot-components are
  refused before any path is joined.
- Format version lives in `.vault/format.json` (§5b) under `reflexes`, and in
  the file's own `version` key; a version newer than the app knows means no
  rule runs.
- **`.vault/reflexes-log.json`** is the receipts ring — app-owned, the last 500
  entries, deliberately **not** watched, so writing it can never trigger the
  rules it records. Each entry carries the time, rule id, event, subject, the
  actions taken (or, on a dry run, the ones that would have been), and an
  outcome: `ok`, `noop`, `error: …`, `cascade-stopped: …` or
  `cooldown-suppressed`. External writers should treat it as read-only.

## 8d. Statements — bank exports as transactions

A bank or broker CSV becomes ordinary notes in one database, `type:
transaction`, so money sits in the same queryable substrate as everything
else: filterable, joinable to a project or a client note, and readable by any
tool that reads markdown.

**System of record, never the fetcher.** Nothing in this feature opens a
socket. There is no bank API, no credential, no scraping and no background
fetch — the input is a file the account holder downloaded. That absence is
deliberate and permanent: there is nothing to revoke because there is nothing
to grant.

### The transaction schema

Created (or extended) on first import through the same `vault_create_type`
path as any other database:

| prop | kind | notes |
| --- | --- | --- |
| `date` | date | ISO, resolved from the export's declared order |
| `amount` | number | **unit column**: the value carries its currency (`-1234.56 EUR`) |
| `counterparty` | text | payee/payer as the bank wrote it |
| `account` | text | which account the row came from |
| `reference` | text | the bank's reference/purpose text |
| `category` | text | filled by a rule (§8e) when one matches, else empty |
| `signature` | text | the dedupe key, written so the next import can use it |

`amount` is a number prop whose `format` is a currency code (§6), so rows keep
their own currency: a dollar row in a euro-formatted column renders converted
and marked rather than being silently added up as euros. Amounts are written
canonically — integers bare (`2500 EUR`), everything else with exactly two
decimals — so a value is never re-read as a grouped number under a different
number dial.

### `.vault/statement-mappings.json` — saved column mappings

Which column is which, answered once per bank and then never again. Written by
the app, hand-editable, diffable, syncable. Missing file = no mappings yet,
which is the normal state of a vault that has not imported a statement.

```json
{
  "version": 1,
  "mappings": [
    {
      "id": "sparkasse-giro",
      "bank": "Sparkasse Giro",
      "delimiter": ";",
      "headers": true,
      "dateOrder": "dmy",
      "numberLocale": "de-DE",
      "currency": null,
      "account": "Giro EUR",
      "columns": {
        "date": "Buchungstag",
        "counterparty": "Beguenstigter",
        "reference": "Verwendungszweck",
        "amount": "Betrag",
        "currency": "Waehrung"
      },
      "headerSet": [
        "Buchungstag",
        "Beguenstigter",
        "Verwendungszweck",
        "Betrag",
        "Waehrung"
      ]
    }
  ]
}
```

- `id` — a slug derived from `bank`; replace-or-append by id, so saving twice
  under one bank leaves one entry.
- `delimiter` — `,`, `;` or a tab. Non-English exports are routinely
  semicolon-separated, and reading one of those with a comma yields a single
  column of intact-looking garbage.
- `dateOrder` — `iso`, `dmy` or `mdy`. Declared, never guessed per row:
  `03.04.2026` is genuinely ambiguous and a per-row guess is how importers
  silently move money between months. An impossible date (`31.02.2026`) is
  reported as an unreadable row, not rolled forward. A booking time on the
  cell (`04.03.2026 12:00`) is read in the declared order and the time
  discarded; a cell in any other shape — `March 4 2026` — is an unreadable
  row rather than a date parsed by guesswork under some other calendar
  convention.
- `numberLocale` — one of the number locales in §6, and it is the **bank's**
  dialect, not the reader's: changing the app's number display does not change
  how an export parses.
- `currency` — a fixed code for exports that don't carry one per row; `null`
  when the file has a currency column. `account` likewise fixes the account
  name for files that don't name it.
- `columns` — statement field → column name. Either a signed `amount` column,
  or a `debit`/`credit` pair which is folded to a signed amount (money out
  negative). A row with both non-empty is reported, not guessed.
- `headerSet` — optional, the export's whole header row as this mapping last
  saw it. It is what tells one bank's export from another's: `Date`, `Amount`
  and `Currency` are named the same at half the banks in the world, so a
  mapping is only applied unasked when the header sets agree exactly. A
  mapping written before this field existed (or hand-written without it) falls
  back to the older, looser test — every mapped column name present. For an
  export with `headers: false` there is no header row to compare: the columns
  are named `Column 1`…`Column n`, so the exact-agreement test is a check that
  the two files are the same width, and two headerless exports of equal width
  are not told apart.
- Unmapped fields are simply absent. A column the assistant cannot recognise
  is left for the human to map rather than being attached to a plausible
  field.

### Dedupe — overlapping export windows

Bank exports have no Message-ID, and downloading January and Q1 means the same
row arrives twice. The heuristic is deliberately narrow and its failures are
visible:

- **Signature** (the strong key, stored on the note): `date | canonical amount
  with currency | folded account | folded reference`. Folding lowercases and
  drops everything that is not alphanumeric, so a bank that re-punctuates its
  own reference text still matches.
- **Weak key**: the same minus the reference.
- Counterparty is in **neither** key. Banks rewrite payee strings between
  exports; a name change is not a different payment. It is shown in the review
  step instead, where a human can read it.
- Matching is **multiset** counting, not set membership: an export carrying a
  row more often than the vault holds it does not collapse the surplus away —
  but nor does it write it. The surplus copy goes to the review step below as
  `surplus-identical`, where a human says whether the day really carried two
  identical charges. A repeated export window and a genuinely doubled charge
  look the same on paper, and only the account holder knows which it was.

Every incoming row lands in exactly one of three buckets, and the third is the
point:

1. **already here** — signature matches an unconsumed existing row. Collapsed.
2. **new** — no match. Imported.
3. **to decide** — surfaced in a review step, unticked, never resolved
   silently:
   - `reference-differs` — same date, amount and account, different reference
     text.
   - `surplus-identical` — the export carries this exact row more often than
     the vault holds it.

Nothing in bucket 3 is imported unless the human ticks it — the default for a
row nobody read is therefore **not written**. The design cost is a review step
and the risk of a real second charge going unticked; the design refusal is a
silent merge or a silent double.

### CAMT.053 and friends

CSV only, today. ISO 20022 (CAMT.053) is the named next step and is not in
this format yet.

## 8e. `.vault/statement-rules.json` — transaction category rules

Plain-file rules that name what a transaction is, following the reflexes
pattern (§8c): **data, not code**, a closed field set, no expressions.
**Never written by the app** — rules are authored in the file, which is what
keeps the file the one place that says what a transaction is. Missing file =
nothing is categorized, which is a normal vault.

```json
{
  "version": 1,
  "rules": [
    {
      "id": "energy",
      "when": [{ "field": "counterparty", "contains": "stadtwerke" }],
      "category": "Utilities"
    },
    {
      "id": "big-fees",
      "when": [
        { "field": "reference", "contains": "fee" },
        { "field": "currency", "equals": "USD" }
      ],
      "max": -50,
      "category": "Fees (large)"
    }
  ]
}
```

- `id` — unique in the file; a duplicate invalidates the later rule.
- `when` — one or more clauses, ANDed. Each clause names a `field`
  (`counterparty`, `reference`, `account`, `currency`) and **exactly one**
  test: `contains`, `equals`, `exists: true` or `missing: true`. Two tests in
  one clause, or an unknown field, invalidates the rule.
- Text tests fold the same way the dedupe key does — case and punctuation do
  not matter, so a legal-entity suffix does not break a match.
- `min` / `max` — optional signed, inclusive bounds on the amount. Signed
  means `max: -50` reads as "at least 50 out". `min` above `max` invalidates
  the rule.
- `category` — required; written to the row's `category` prop.
- **File order is the priority**: the first matching rule wins, so put the
  specific rule above the general one.
- **Per-rule all-or-nothing**: an invalid rule is reported and skipped, never
  half-applied and never silently dropped; the valid rules still run.
- Format version lives here and in `.vault/format.json` (§5b) under
  `statementrules` (`statementmappings` for §8d). A file from a newer app is
  refused whole — no rule runs, and no mapping is read — rather than
  degrading to "no rules", because a half-read money file is worse than a
  loud one.

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
.trash/1752768000100/Projects.folder.json ← its parked view-config
.trash/1752768000000/Inbox/Capture anything.md.note.json
                                          ← a trashed note's parked sidebar
                                            config
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
- **A trashed folder parks its view-config** in a sibling
  `<id>.folder.json` sidecar, next to the marker for the same reason. Deleting
  a folder clears config that lives outside it — its `$folders` icon (subtree
  included), any schema `home` pointing into it, its `$sidebar.folders` row,
  the `$sidebar.pins` of notes inside, and every `$sidebar.keys` binding
  targeting the folder or its subtree — and the sidecar is what
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
- **A trashed note parks its sidebar config** the same way, in a
  sibling `<id>.note.json` sidecar. Deleting a note clears its `$sidebar.pins`
  row and every `$sidebar.keys` binding pointing at it — `note:` and
  `dash:` alike — so the sidecar is what restore reads to put both
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
- **Templates trash into a `.templates/` mirror** the same way:
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

**Second ownership marker.** The sentinel is one file inside
`.git`, and losing it used to be terminal. A vault that lost both its
sentinel and its `.git/config` (partial restore, a copy tool that skipped
them) commits its next snapshot under git's *implicit* machine identity —
and that single non-Substrate commit then fails the all-authors heuristic on
every later boot, so version history stayed off forever on a repo Substrate
itself created. So an unstamped repo is also adopted (and re-stamped) when
`.git/info/exclude` holds nothing but lines Substrate has ever written
(`EXCLUDE_LINES_EVER_OURS` in `src-tauri/src/history.rs`), anchored on
`.assets/` + `.trash/`. A user's own repo would have to carry exactly that
vocabulary and nothing else — no pattern of their own, not even git's
default comment header — to be mistaken for ours. Deliberately NOT part of
the marker: the local `user.name`/`user.email`, which anyone can set to
Substrate's own. The mobile half (`gitsync::history_prepare`) applies the
same rule.

- **Snapshots** land as commits: one baseline at app launch, then after activity
  (the vault quiet for 120s, or a 600s continuous editing stretch, checked every
  15s), and a final one at quit. A clean tree never commits. Labels: `snapshot`,
  `snapshot (quit)`, `restore <path>`, `snapshot (history trimmed)`, and
  `bulk: <run summary>` for a schema sweep, which commits its own work so the
  notes it rewrote carry a receipt naming the run
  (`src-tauri/src/commands/schema.rs`).
- **Excluded** (via `.git/info/exclude`, written at init —
  `src-tauri/src/history.rs` `EXCLUDE_CONTENT`): `.assets/`, `.trash/`,
  `.DS_Store`, and the device-local state files written off the engine lock —
  `.vault/notifications.json`, `.vault/jobs-exit.json`,
  `.vault/seal-conversion.json` (the local interruption journal), and
  `.vault/seal-trust.json`, which is device-local by security requirement
  rather than convenience: it records which seal markers this device
  confirmed, so syncing it would hand a remote writer the very
  seal-confirmation approval the gate exists to withhold
  (`src-tauri/src/history.rs`).
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
  device"* rather than as broken links (`src/lib/embedstate.ts`). Getting binaries onto another
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
  `.git/config` (idempotent; `src-tauri/src/history.rs` `History::new`). Reason: `git commit` spawns a **detached** `git maintenance run
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
  writes (both engines' `finish_rewrite`) and the next successful
  push deletes. While it stands, a rejected push is reported as "the remote
  still holds the old history" with the manual recovery steps
  (`scripts/vault-sync-server/README.md`, "After a client-side history
  rewrite") instead of raw git wording.
- External writers: **never touch `.git/`** — no commits, no config, no excludes.
  Your file writes are picked up and snapshotted by the app itself.
- **`Substrate-Tool: <name>` — the one thing a writer that does commit should
  say.** A tool that owns the repository itself (a user's own git workflow, an
  importer, a script) is outside the rule above and gets no attribution from
  the author line alone, which git may set to the user's own name — or to
  Substrate's, if it copied the repo config. Adding the trailer to the commit
  **body** (not the subject) names the writer, and receipts show that name
  instead of guessing from the author. Read-only: Substrate never writes this
  trailer, never requires it, and a commit without it still gets a receipt —
  just a vaguer one. The key is matched case-insensitively and the last
  occurrence wins, as git reads a repeated trailer.

  ```
  import from Things

  Substrate-Tool: Things Importer
  ```

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
  `terminal-dock` (`bottom` or `right`, default `bottom`; anything else
  reads as `bottom`), `terminal-height` (window fraction `0.2`–`0.9`, default
  `0.45`, used when docked bottom) and `terminal-width` (window fraction
  `0.2`–`0.7`, default `0.38`, used when docked right) — both sizes are also
  written by dragging the panel's inner edge, and each side keeps the
  size last chosen for it, so flipping the dock restores it; an out-of-range
  value typed into the note falls back to the default rather than clamping,
  `terminal-font` (font family for the HUD terminal — one name or a
  comma-separated chain; names are normalized (quotes optional, spaced names
  quoted for you) and restricted to letters/digits/space/`_``.``-`, anything
  else is dropped; the app's mono stack is always appended, so a typo'd or
  rejected value degrades to mono; empty = that mono stack alone; a nerd font
  goes here to get powerline glyphs),
  `terminal-actions` (a list of `Label: command` quick actions offered in the
  command palette, each typed into the HUD's shell; a fresh vault is seeded
  with one entry for the `/setup` skill below),
  `feed-curator` (the command the feed dashboard's refresh button runs to
  re-curate its items sheet — login shell, vault root as cwd, one run at a
  time with a 20-minute cap; empty or unset = no refresh button, the pane
  offers its setup card instead. Like `terminal-command`, the exact string is
  approved per machine before it first runs — approvals live on the machine,
  never in the vault; `docs/dashboards.md` §feed has the contract), and
  `drop-hint` (default `true`; `false` hides the drag-over copy-vs-⇧-link
  hint), `mod-hud` (default `true`; `false` stops the hold-⌘ panel from
  unfolding the shortcuts that would fire right now — same rule as
  `drop-hint`, only an explicit `false` hides it, so an unset key or a
  typo'd value keeps the affordance discoverable. Desktop only), `db-grid`
  (default `true`; `false` turns off the
  vertical grid lines in database tables globally — a database's own
  views.json `grid` override, §7, wins either way),
  `task-stale-chips` (default `true`; `false` hides the tasks
  board's `stale`/`undated` age chips — same explicit-`false` rule as
  `drop-hint`. It is the global DEFAULT: a board with its own `stale_days`
  (§5.2) keeps its chips, and a task with `stale: never` never wears one),
  `auto-sync` (default `true`; `false` parks the vault-sync timer lane —
  push when edits settle, pull on open/focus and every few minutes — while
  the Sync pane's Push/Pull buttons keep working either way. Inert until a
  remote is configured, and a parked conflict pauses it regardless),
  `window-opacity`
  (macOS desktop only, default `90`; how solid the window is over the
  desktop in percent, `80`–`100` — the wallpaper shows through, blurred by
  macOS's own material rather than by a CSS filter over the notes, and `100`
  removes the material for exactly the old fully-solid window. Only the window
  ground and the note column take the alpha; panels, popovers and menus stay
  opaque so the depth hierarchy survives. An out-of-range or unparseable value
  falls back to `90` rather than clamping, and on every other platform the key
  is inert and the ⌘, sheet hides the slider), `show-agent-files`
  (default `false`; only an explicit `true` lists the root
  `AGENTS.md`/`CLAUDE.md` — and `Settings.md` itself — in the
  app's note surfaces; the key keeps its original name for existing vaults,
  the ⌘, sheet labels it "Show app files" — see the concealment entry below),
  and the "Send as link" pair: `share-relay-url` (http(s) URL of the
  handoff relay the encrypted copy uploads to; fresh settings notes seed
  `https://drop.substrate.zone`, and an existing note with no key uses that
  runtime default without being rewritten. `disabled` (what the Settings form
  writes when cleared) or an explicit empty value disables hosted sharing;
  legacy `off` remains accepted on read for existing settings notes;
  the hosted default and the self-hostable relay speak the same protocol — see
  `scripts/handoff-relay/README.md`) and
  `share-relay-token` (optional bearer token, only for relays that gate
  uploads), and the appearance dials: `glow` (0–100, default `0`,
  the bloom around dashboard chart strokes, dots and emphasised values —
  bars join above 70; `0` is the shipped look and switches the effect off
  entirely rather than drawing a zero-width one), `accent-tone` (`sky` —
  the default and the shipped family — `teal`, `indigo` or
  `violet`; picks the hue the dashboard accent family wears, on
  screen and in print, while the state colours red/amber/green and a `by:`
  split's own categorical band ramp all stay put) and `accent-tone-nudge` (−12..12 degrees of
  hue offset around the chosen tone; out-of-range values clamp, and the
  bound is what keeps every ramp colour clear of 3:1 on both grounds).
  All three degrade to their default on any value the reader can't make
  sense of. Alongside them:

  `number-locale` (a BCP-47 tag from a short list — `de-DE`, the
  default, writes `1.234,56`; `en-US` and `en-GB` write `1,234.56`; `de-CH`
  writes `1’234.56` with a typographic apostrophe, which is what ICU
  emits; `fr-FR` writes `1 234,56` with a narrow no-break space), which is
  the *only* dial for the number dialect. It moves both directions:

  - *Writing.* Database cells, calc line results, aggregate totals, sheet
    formulas, dashboard figures, chart labels and file sizes all render
    through one shared formatter, so the picker and the app can't disagree.
    Embedded view fences, heatmap squares and the on-disk sizes in the coding
    and share surfaces are included — they read the dial at render time, and
    changing the picker repaints them without a reload.
    Three things stay pinned on purpose and are not dialect. API prices in the
    token-cost view are always written the American way, because they are
    dollars. Compact magnitudes and durations — the `1.2k` / `3.4M` counters,
    `4.2/min` rates and `3.2h` spans on the proxy, sync and feed surfaces —
    keep a dot decimal in every dialect: they are suffix shorthand rather than
    a number a reader would type back, and one character of precision is the
    whole figure. And dates are not numbers: they do not follow this dial at
    all — they read `date-locale` below.
  - *Reading.* A number typed into a number-kind cell is read in the same
    dialect it was rendered in, so retyping what is on screen round-trips:
    under `en-US` `1,234.56` reads as 1234.56, under `de-CH` `1'234` reads as
    1234, under `fr-FR` `1 234,56` reads as 1234.56. The reader accepts the
    keyboard forms of the group separators as well as the typographic ones
    ICU renders (`'` for `’`, a plain or non-breaking space for ` `),
    because that is what a keyboard and a paste actually produce. Text it
    cannot read confidently in the current dialect is stored verbatim rather
    than guessed at, and canonical dot-decimal storage text (`1234.56`) is
    never rewritten under any dialect. Everything on disk stays canonical
    dot-decimal — the dialect is a display and input convention only.

  Unset or unrecognized reads as `de-DE`, so a vault that
  never sets it renders exactly as before. It replaces `number-format`
  (`de`/`intl`), which reached only calc lines and unit cells; that
  key is still honored as a fallback when `number-locale` is absent, so vaults
  that set `intl` keep their en-style numbers, but nothing writes it any more.

  `date-locale` (SUB-1107, a BCP-47 tag from the same short list the number
  dial offers — `de-DE`, the default, writes `31.01.2026, 14:05`; `de-CH` the
  same; `en-GB` and `fr-FR` write `31/01/2026`; `en-US` writes `01/31/2026`
  and is the one 12-hour clock), which is the only dial for the date dialect:
  every rendered date and clock time reads it — trash and asset rows, note
  history stamps, list date chips, time-travel points, dashboard poll lines
  and the printed export header — through one shared binding. Unset or
  unrecognized reads as `de-DE`. Unlike `number-locale` this is not a
  no-op for existing vaults: the surfaces that formerly passed no locale
  followed the operating system's, and two followed `en-GB`, so they move to
  the vault's setting on first launch. It decides presentation only — nothing
  on disk changes, journal note titles keep their own English format, and
  date *values* in frontmatter stay ISO (§4).

  Alongside them, the outbound-request switches, one per request the app can make, all
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
  app writes it on launch whenever it is absent, so vaults predating
  the setting get one, and deleting it brings back the defaults. No write
  happens if `.vault/format.json` says a
  newer app owns the vault (§5b). Desktop-only, and skipped on a vault that has
  a sync remote — both for the same reasons as the `AGENTS.md` backfill below.
  An existing note is split in two: **the frontmatter is never
  touched** — those are the user's values, and a key they removed simply means
  "default" — while the **body**, which is the app's own per-key documentation
  and rots as settings are added, is refreshed under the known-revisions rule
  below whenever it still byte-matches a body the app shipped. The body is
  hashed on its own; a note with no frontmatter at all is treated as the
  user's entirely.
- `AGENTS.md` (vault root) + `CLAUDE.md` + `.claude/skills/setup/SKILL.md` —
  the orientation the agent CLI in the ⌘⇧T terminal HUD reads about the vault
  it is running inside: `AGENTS.md` is this format in one page,
  `CLAUDE.md` is a one-paragraph pointer at it for agents that auto-load only
  that filename, and `/setup` is a
  skill that interviews the user and writes further skills fitted to their
  actual schema. Deliberately no other prebuilt skills — one that doesn't know
  the user's real types and folders proposes against an imagined schema.
  Both are written when **absent**, on every launch, not only on first run
  (`vault/seed.rs` `seed_agent_files`), so deleting one brings the shipped version
  back. **Known revisions**: `seed.rs` also embeds the full text of
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
  mobile these files arrive with everything else through git sync (§11), whose
  exclude list — `.assets/`, `.trash/`, `.DS_Store` and the four device-local
  `.vault` JSONs — holds nothing of theirs, so a skill written on
  one device shows up on the others. `.claude/` is hidden (§1) and therefore
  never a note; `AGENTS.md` is an ordinary, frontmatter-less note in the index.
  **In-app concealment (added `Settings.md`)**: the engine
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
  false` hides a note from the calendar (the note's ⋯ menu writes/removes it).
- `type: reference` — a link captured from the clipboard: filed in `Inbox/` with
  `url:` prop; the title starts as the bare URL (scheme/`www.` stripped) until a
  fetched page title renames it.
- `type: ableton-project` — the Ableton album pool: one row per project
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
7. **Never write inside `.git/`** (app-owned) — a tool that owns the repo itself
   is the exception, and should name itself with a `Substrate-Tool: <name>`
   commit trailer (§11) so receipts can credit it. Treat `.trash/` as read-only.
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

**Non-UTF-8 notes are readable but not writable.** The engine reads
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
- Databases: `vault_create_type` `vault_rename_type`
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
  `vault_folder_files` (the loose files of ONE folder; see §1)
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
| `corrupt-config` | a `.vault/*.json` file whose bytes are not JSON (including bytes that aren't UTF-8 text at all). Reader fallbacks are unchanged — most read as empty, so a mangled file can never lock anyone out (§5b, §6–§8b), while `calendars.json` surfaces a config error instead (§5c) — but the loss is no longer silent: one finding per unreadable file, naming the file and the consequence the file's own reader actually has. An absent or empty file is the normal state of a fresh vault and is never reported | error |
| `stale-config` | `.vault/*.json` pointing at something gone: a schema type with zero notes, a `home`/folder-mapping path that no longer exists, a views or saved-view entry for an unknown type. A mount that is unbound on this machine, or whose bound folder is gone, is a **warn** and never an error: its board still renders from the last-known index and "Locate folder…" fixes it (§8) | warn / error |
| `invalid-prop` | a `date` or `number` prop whose value does not parse under the schema's kind — the value is reported, never rewritten | error |
| `broken-reflex` | a rule in `.vault/reflexes.json` (§8c) that does not run: the file failed to load (one finding for the whole file), a rule failed validation, or the circuit breaker paused a rule after repeated failures. Runtime state, so it is appended by the command rather than found by the scan — a breaker pause exists only in the running app | error |

One documented exception to `broken-embed`'s error severity: a `type: voice`
note (§5.11) whose `.assets/` audio is absent is a **warn**, because audio
never syncs — on every device but the recorder the file is legitimately not
there, and an error per synced voice note would train people to ignore the
doctor. It is still reported, so an actually-deleted recording is not silent.

`paths` holds every note involved: one entry for most findings, one per
colliding note for `ambiguous-target`, and the config file for `stale-config`
(`.vault/schema.json`, `.vault/views.json`, `.vault/mounts.json`,
`.vault/folders.json`) and `corrupt-config` (any versioned config file: those
four plus `.vault/notifications.json`, `.vault/calendars.json`,
`.vault/tagfolders.json`).

