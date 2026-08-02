# Undo — app-wide design (SUB-443)

Substrate's credo says **"Nothing is ever lost. Trash, history, restore — fearless
by default; only explicit actions are permanent"** (`docs/vision.md:98`). Undo is
where that credo is cashed out at the scale of a single mistake. Today it is
cashed out four different ways on four surfaces and not at all everywhere else.

This document is the design for one undo model. It is a spec, not a work list —
`AGENTS.md` §"docs are specs/reference". Slice 1 (§6) is written so a lane can
implement it from this file alone.

Every claim about current behaviour below is cited to code. Where the code and
this doc disagree, the code wins and this doc gets fixed in the same merge.

Sources of truth: `src-tauri/src/lib.rs` + `src-tauri/src/commands/` (IPC),
`src-tauri/src/vault/` (engine — `Engine` façade in `mod.rs`, plus the `schema`,
`views`, `search`, `trash`, `assets`, `foldersync`, `watch` modules), `src-tauri/src/history.rs` (vault git), `src/App.tsx` (toast + key
dispatch), `src/components/NotePane.tsx` (save/adopt), `src/components/Editor.tsx`
(CodeMirror), `src/lib/shortcuts.ts` (key registry).

---

## 1. Inventory — every mutating action, verified

The full command surface is registered in `generate_handler!`
(`src-tauri/src/lib.rs:730-865`; 130 entries as of 2026-08, including the
`smoke::*` and `term::*` lanes). Most are pure reads; every command that
mutates persistent state is classified below — the classification, not the
count, is the contract.

**Legend for "Invertible"**: ✅ = a small captured payload fully inverts it;
🟡 = invertible but lossy or racy; ❌ = not invertible with a bounded payload.

### 1.1 Content edits

| Command | lib.rs | Engine | What changes on disk | Invertible — what to capture | Covered today |
|---|---|---|---|---|---|
| `vault_write_body` | `:136` | `write_body` `vault/mod.rs:1152` | Whole body replaced; frontmatter preserved byte-verbatim | ✅ prior body. **The only guarded writer** — `expected: Option<&str>` body compare at `vault/mod.rs:1191-1195` | CodeMirror history (`Editor.tsx:1093`), food stack (`FoodDashboard.tsx:225`) |
| `vault_fm_write` | `:125` | `fm_write` `vault/mod.rs:1111` | Whole **frontmatter block** replaced; body preserved | ✅ prior raw FM string + a no-FM-at-all sentinel | ❌ none |
| `vault_set_prop` | `:152` | `set_prop_value` `vault/mod.rs:1273` | One FM key set/removed; whole prop map re-serialized (BTreeMap order, YAML reflowed) | ✅ `Option<Value>` prior — `None` *is* the absence sentinel and is directly the inverse argument | Calendar drag + board drag only (§1.8) |
| `url_capture` | `:200` | `create_reference` `vault/mod.rs:1456` | Creates `Inbox/<slug>.md`, then **asynchronously** may rename + write body (`spawn_url_enrichment`, `commands/notes.rs:122`) | 🟡 sync part inverts by trashing; the async tail lands after the undo record is taken | ❌ none |
| `history_restore` | `:1310` | `write_raw` `vault/mod.rs:1207` | Whole file (FM included) overwritten from git, then snapshotted | ✅ the pre-restore commit id — the inverse is another restore. **No guard**: `write_raw` has no `expected` | n/a (additive by design) |
| `folder_dbs_rescan` | `:594` | `sync_folders` `vault/foldersync.rs:155` | Creates stub notes, rewrites `modified`/`size`/`missing` across N notes, may seed schema | ❌ count-only return, multi-note | ❌ none |

### 1.2 Property edits

`vault_set_prop` is the single property writer. Nine call sites, two of which
have undo:

| Call site | file:line | Undo today |
|---|---|---|
| Calendar drag / peek date move | `CalendarPane.tsx:279` | ✅ toast (`:285`) |
| Board column drag | `DatabasePane.tsx:1405` via `writeCell` `:1204` | ✅ toast (`:1403`) |
| Table cell commit | `DatabasePane.tsx:1220` | ❌ |
| List/relation/multi toggle | `DatabasePane.tsx:1233`, `:1381` | ❌ |
| **Bulk bar, N notes at once** | `DatabasePane.tsx:1328`, `:1349` | ❌ |
| PropForm (note pane) | `NotePane.tsx:619` | ❌ |
| Palette quick-set | `Palette.tsx:252` | ❌ |
| Today "schedule for" | `TodayPane.tsx:205` | ❌ |
| Settings | `SettingsPane.tsx:134`, `:147` | ❌ |
| Calendar status/repeat/skip/until | `CalendarPane.tsx:318`, `:346`, `:358`, `:367-369`, `:374`, `:1018` | ❌ |

`bulkWriteLive` (`DatabasePane.tsx:1328`) fans one `vaultSetProp` per selected
path with no batching and no undo. It is the single most destructive everyday
action in the app.

### 1.3 Structural — notes and folders

| Command | lib.rs | Engine | What changes | Invertible | Covered |
|---|---|---|---|---|---|
| `vault_create` | `:164` | `create_full` `vault/mod.rs:1376` | New `.md`, auto-numbered on collision | ✅ returned path → trash it | ❌ (scratch-abandon hard-deletes silently, `App.tsx:1309-1331`) |
| `vault_move` | `:532` | `move_note` `vault/mod.rs:1839` | `fs::rename` into another folder; filename and links untouched | ✅ prior folder. **The cleanest invertible structural op** | ❌ |
| `vault_rename` | `:255` | `rename` `vault/mod.rs:1515` | Renames file **and rewrites `[[wikilinks]]` in every source note + relation props across notes** | 🟡 reverse sweep catches unrelated notes that already said `[[old]]`; can return `Err` *after* the rename landed (SUB-225, `vault/mod.rs:1568`; SUB-285, `:1676`) | ❌ |
| `vault_create_folder` | `:511` | `create_folder` `vault/mod.rs:1826` | `create_dir_all` | ✅ but capture which levels were new | ❌ |
| `vault_rename_folder` | `:521` | `rename_folder` `vault/mod.rs:1875` | Dir rename + retargets `$folders` icons, schema `home`s, `$sidebar` | ✅ capture the *returned* rel (sanitizer may rewrite the requested name) | ❌ |
| `vault_delete` (trash) | `commands/trash.rs:11` | `trash` `vault/trash.rs:184` | Note → `.trash/<ms>/<rel>` | ✅ the command **returns the trash id** (`Result<String,String>`), so the inverse is `vault_trash_restore(id)` | ✅ toast (`App.tsx:1517`) |
| `vault_delete_folder` | `commands/trash.rs:85` | `trash_folder` `vault/trash.rs:253` | Subtree → trash + `.folder` marker; **clears** icon, schema home, sidebar entry | 🟡 restore does not bring the three config bits back | ❌ (TrashPane only) |
| `vault_trash_restore` / `_folder` | `:279` / `:313` | `vault/trash.rs:683` / `:822` | Moves back, **numbering on collision** (`Note 2.md`) | 🟡 round-trip loses the original delete stamp | n/a |
| `vault_save_asset` / `vault_import_asset` | `commands/assets.rs:8` / `:47` | `vault/assets.rs:71` / `:92` | New file in `.assets/` | ✅ the inverse (`assets_delete`) moves the file to `.trash/<ms>/.assets/` rather than unlinking it | ❌ |

### 1.4 Schema

All four bulk commands carry a doc-comment telling the caller to take a
`history_snapshot` first (`commands/schema.rs:145`, `:159`, `:172`, `:186`) — the codebase
already concedes these are not row-invertible.

| Command | lib.rs | What changes | Invertible |
|---|---|---|---|
| `vault_schema_set` | `:608` | One prop's schema in `.vault/schema.json` | ✅ prior `PropSchema` + type-entry-existed flag. **Caveat**: `notify` is `unwrap_or(keep)` (`vault/schema.rs:352`) — the inverse must pass `Some(old_notify)` explicitly |
| `vault_schema_set_icon` | `:630` | Type icon | ✅ prior `DbIcon`; build from the *stored* value (emoji beats glyph, orphan tint drops) |
| `vault_schema_home_set` | `:650` | Type home folder | ✅ prior `Option<String>`; the uniqueness check can make the inverse *fail* |
| `vault_create_type` | `:664` | New type entry | ✅ remove the entry |
| `vault_rename_type` | `:678` | Rewrites `type:` on every note of the type + relation targets + views key + `$sidebar` + template file + `folders.json` | ❌ count-only return (`BulkSweep`) |
| `vault_delete_type` | `:692` | Strips `type:` from N notes **or trashes them all**; deletes the template file | ❌ N unreturned trash ids, template bytes gone |
| `vault_rename_prop` | `:705` | Renames a FM key across every note of the type; `skipped` notes already had the new key | ❌ `BulkSweep{notes,skipped}` only |
| `vault_clear_prop` | `:720` | **Strips a FM key's value from every note of the type** + wipes it from the view pref | ❌ count only. The most data-lossy non-trash command |

All four return the same `BulkSweep{notes, skipped, failed?}` (SUB-501). They
stop at the first note that fails to rewrite, and `failed` carries that error
back **alongside** the partial count rather than rejecting the call — so a
sweep that rewrote 40 of 60 notes says so instead of reporting only the error.
A failed sweep returns before its schema/views/template bookkeeping, so the
database or property keeps its old name; the notes already rewritten do not
revert. Recovery is still the pre-sweep snapshot, not a reverse sweep.

### 1.5 View-config

Every one is a whole-object replace and therefore trivially invertible.

| Command | lib.rs | Capture | Covered |
|---|---|---|---|
| `vault_views_set` | `:456` | prior `ViewPref`. **Replaces every field** — a partial call already silently wipes sorts/widths/wrap | ❌ |
| `vault_set_sidebar_order` | `:548` | prior `SidebarOrder` | ❌ |
| `vault_saved_view_set` | `:564` | prior `SavedView` or absent-sentinel | ❌ |
| `vault_saved_view_delete` | `:575` | the removed `SavedView` **and its index** (re-`set` appends to the end) | ❌ |
| `vault_folder_icon_set` | `:488` | prior `DbIcon` | ❌ |

### 1.6 Destructive — permanent

| Command | lib.rs | Why it can't participate |
|---|---|---|
| `vault_trash_delete` / `_folder` | `:289` / `:323` | `remove_file` / `remove_dir_all` |
| `vault_trash_empty` | `:294` | `remove_dir_all` on all of `.trash/` |
| `vault_assets_delete` | `commands/assets.rs:99` | Not permanent any more: assets move to `.trash/<ms>/.assets/<name>` (`vault/assets.rs:259-289`) and come back via `vault_assets_restore` (`commands/assets.rs:112`). Still outside the undo stack — recovery is the Trash pane, not ⌘Z |
| `history_purge_note` / `_notes` | `:1326` / `:1336` | Rewrites git history |
| `history_trim` | `:1346` | Drops all snapshots before a cutoff |

### 1.7 Sync and external-process

Never undoable: `vault_sync_push` (`:1414`, publishes), `vault_sync_pull`
(`:1426`, git-level), `vault_sync_set_remote` (`:1395`, stores a token that
**cannot be read back** for capture),
`term::*` (`term.rs:91`+), `export_text` (`:365`
— a bare `fs::write` to a user-picked path, no read-back), `export_note_bundle`
(`:370`), `file_open` (`:740`).

`history_snapshot` (`:1354`) is additive — it needs no inverse; it *is* the
safety rail the bulk commands lean on.

### 1.8 What the existing per-surface undos actually cover

Four mechanisms, two idioms, no shared vocabulary.

| # | Surface | Trigger | Record | Depth | Lifetime | Redo | Restores |
|---|---|---|---|---|---|---|---|
| 1 | Trash toast | **mouse only** — `App.tsx:3028` | closure over `path`, in App's single toast slot `App.tsx:304-309` | 1, **shared with every toast in the app** | **4 s** (`App.tsx:393-397`) | ❌ | whole note via `vaultTrashList` → `vaultTrashRestore` (`App.tsx:1486-1504`) |
| 2 | Calendar drag | mouse only | local const `prior` (`CalendarPane.tsx:277`) closed over, into the same slot | 1, shared | 4 s | ❌ | **one prop** — `vaultSetProp(path, prop, prior)` (`:285`) |
| 3 | Board drag | mouse only | local const `cur` (`DatabasePane.tsx:1395`) | 1, shared | 4 s | ❌ | **one prop** — `writeCell(path, groupBy, cur)` (`:1405`) |
| 4 | Food dashboard | **⌘Z / ⌘⇧Z** — `FoodDashboard.tsx:238-261` | two ref arrays of full note bodies (`:225-226`) | **50** (`:235`) | mounted pane only; dies on unmount | ✅ (`:249-251`) | whole body of one of two notes, **with the conflict guard** (`:257` → `vaultWriteBody` with `expected`) |

Undo-adjacent but not undo: TrashPane (`TrashPane.tsx:96-119`), HistoryPanel
(`HistoryPanel.tsx:118-131`), `presweepSnapshot` (`App.tsx:1040-1044` — takes a
snapshot before schema sweeps but **exposes no UI to roll it back**, and swallows
its own failure with `.catch(console.warn)` at `:1042`).

The yield-board ⌘Z (SUB-323) is **live** — `DashboardPane.tsx:96-131`, two ref
stacks of `{ body, claimed }` capped at 50, covered by `e2e/yieldundo.spec.ts`.
The `yield-apr` archive (SUB-447) landed 2026-07-25 and was reverted the same
day (`e88cb5a`, merged as `d64d6d5`), restoring the kind and both specs;
`FoodDashboard.tsx:219-220` notes the food stack is a copy of this design, not
its successor.

**⌘Z is not in the shortcut registry.** `src/lib/shortcuts.ts` is built to be the
one source of truth so "the sheet cannot drift from the real bindings"
(`shortcuts.ts:1-6`), and it contains **no undo or redo entry at all**. So
`matchShortcut` never fires for `z`, App's dispatcher returns early
(`App.tsx:2404`), and ⌘Z resolves to whoever else happens to be listening:

| Focus | ⌘Z hits |
|---|---|
| CodeMirror content | `historyKeymap` (`Editor.tsx:1124`) |
| Food dashboard (incl. inside `.dash-form`) | `FoodDashboard.tsx:239` |
| Any other input/textarea | native browser text undo |
| **Everywhere else** | **nothing** |

The food dashboard's ⌘Z is therefore completely undiscoverable — it appears in
neither the cheat sheet nor the hint panel.

### 1.9 API gaps that block undo today

1. **Trash ids are returned — this gap is closed.** `vault_delete` and
   `vault_delete_folder` return `Result<String, String>`
   (`commands/trash.rs:11`, `:85`), and the string is the trash id
   `<now_ms +N on collision>/<rel>` computed inside `trash_at()`
   (`vault/trash.rs:197-202`). `vaultDelete` / `vaultDeleteFolder` surface it
   to the frontend (`src/lib/ipc.ts:134`, `:141`), so an undo entry can capture
   the exact id instead of scanning `vaultTrashList()` for a path match and
   picking the first of two deletions of the same path.
2. **`vault_set_prop` has no conflict guard.** `vaultSetProp` takes no
   `expected` (`src/lib/ipc.ts:48`; engine `vault/mod.rs:1273`), unlike
   `vaultWriteBody` (`ipc.ts:46`). Every property undo is a blind
   last-write-wins overwrite.
3. **Bulk commands return counts, not rows.** `vault_clear_prop`,
   `vault_rename_type`, `vault_delete_type`, `vault_rename_prop`,
   `folder_dbs_rescan` — none say *which* notes changed or what the old values
   were. The four sweeps at least report *how many* even when they die partway
   (`BulkSweep.failed`, SUB-501); `folder_dbs_rescan` still loses its tally to a
   rejected call.
4. ~~**`vault_delete_folder` discards view-config.**~~ Closed: a folder delete
   parks icon, schema home, sidebar rows and keys in an `<id>.folder.json`
   sidecar (SUB-480/SUB-499), and a note delete parks its pin and keys in an
   `<id>.note.json` one (SUB-666). Both restore with yield-to-newer semantics —
   see `docs/vault-format.md` §10.
5. **Restore never overwrites**, so it numbers on collision (`vault/trash.rs:683`,
   `:822`) — "undo delete" is not guaranteed to restore the original path.
6. **Extract-selection is split across two stacks** (SUB-591). The create
   records on the app stack (`NotePane.tsx` `extractToNote` → `recordCreate`);
   the `[[link]]` replacing the selected text rides CodeMirror history. Since
   `App.tsx` scopes the app stack's ⌘Z out of the editor (§1.8), one gesture
   never undoes both: ⌘Z in the editor restores the text and removes the link
   but leaves the created note on disk; ⌘Z outside it trashes the note but
   leaves the `[[link]]` dangling in the source until the editor's own undo
   takes it back. Accepted, not fixed — the same shape as paste-asset, which
   isn't undoable at all.

---

## 2. The model

Three layers, each with a different job. They are not alternatives; a design that
tries to make one layer do all three jobs is the failure mode.

```
  layer            granularity        durability          bound to
  ───────────────────────────────────────────────────────────────────────
  1 text undo      keystroke group    in-memory           the open EditorState
    (CodeMirror)   (~500ms groups)    dies on note switch
  2 action undo    one user action    in-memory,          the app session
    (THIS DOC)     (inverse op)       session-scoped
  3 history        ~2–10 min          durable, on disk    the vault git repo
    (git)          whole-file         survives restart
```

Layer 3 already exists and is coarse by construction — §2.4. Layer 1 exists and
is correct — §3. **Layer 2 is what this document adds.**

### 2.1 The record

```ts
/** One reversible user action. Recorded at commit time, not at intent time. */
export type UndoEntry = {
  /** monotonic, assigned on push */
  id: number;
  /** what the toast/menu says: "Set Status", "Move to Trash", "Move 12 notes" */
  label: string;
  /** which stack this belongs to (§2.3) */
  scope: UndoScope;
  /** ms epoch of the commit — used for staleness display, never for logic */
  at: number;
  /** the paths this action touched — the invalidation key (§3.4) */
  paths: string[];
  /** run the inverse. Resolves on success; rejects with a conflict error the
   *  caller renders. MUST be idempotent-safe: it may be called at most once. */
  undo: () => Promise<void>;
  /** re-apply. Absent = this action is undo-only, and undoing it clears redo. */
  redo?: () => Promise<void>;
};
```

**Inverse operations, not snapshots.** Each entry closes over the minimum prior
state needed to reverse itself. Per class:

| Class | Inverse | Captured at commit time |
|---|---|---|
| property edit | `vaultSetProp(path, key, prior)` | `prior: PropValue \| null` — `null` *is* the absence sentinel and the engine already treats it as remove (`vault/mod.rs:1326-1339`). `prior` is the **raw parsed YAML**, so the writer has to accept everything the reader can hand back: string, number, bool, string list, absent. Numbers reach the write path this way only — the UI still authors strings (docs/vault-format.md §2). A structured prior (map, mixed list) is still refused, and its edit is correspondingly not undoable |
| bulk property edit | N × the above, sequenced | `Array<{path, prior}>` — one entry per note, one `UndoEntry` for the batch |
| content edit (body) | `vaultWriteBody(path, priorBody, expected = currentBody)` | prior body + the body the action wrote |
| frontmatter block | `vaultFmWrite(path, priorRaw)` | prior raw FM string, or a no-block sentinel |
| move | `vaultMove(path, priorFolder)` | prior folder |
| rename | `vaultRename(newPath, priorTitle)` | prior rel path + prior title + whether a `title:` prop existed |
| create | `vaultDelete(createdPath)` | the returned path |
| trash | `vaultTrashRestore(trashId)` | **the trash id — requires the API change in §6.2** |
| view-config | `vaultViewsSet(db, priorPref)` etc. | the whole prior object + index where order matters |
| schema (single-prop) | `vaultSchemaSet(db, prop, priorSchema)` | prior `PropSchema`, incl. explicit `Some(old_notify)` |
| schema (bulk sweep) | — | **does not participate**; the pre-sweep snapshot is the recovery path (§5) |

**Why inverses and not snapshots.** A snapshot of "the vault before this action"
is either huge (whole-vault) or wrong (whole-note snapshots lose concurrent
external edits to the *rest* of the note). An inverse touches exactly the bytes
the action touched, which is also exactly what makes the external-writer
coordination in §3 tractable: a narrow inverse can be conflict-checked narrowly.

### 2.2 Capture point

**At commit, from the value that was actually on disk — never from React state.**

The prior value must be read from the same source the write is about to
overwrite. Today `CalendarPane.tsx:277` and `DatabasePane.tsx:1395` both read
`prior` from the in-memory `notes` list, which can be up to one refresh stale.
The correct capture is the value returned by the write itself: `vault_set_prop`
already returns the post-write `NoteMeta` (`commands/notes.rs:34-40`), so a **prior-returning
variant** (§6.2) makes capture exact and free of a second round-trip.

Actions that fail do not push an entry. Actions that partially succeed (bulk)
push an entry covering **only the paths that succeeded** — `bulkWriteLive`
already knows which those are (`DatabasePane.tsx:1331`).

### 2.3 Scope stack — one global stack, scope-tagged

```ts
type UndoScope = "vault" | `pane:${string}`;
```

**One stack, not many.** The user's model of ⌘Z is chronological: "undo the last
thing I did." Per-pane stacks mean the same keystroke reaches different depths
depending on invisible mount state — which is exactly the incoherence the food
dashboard has today (its stack silently empties when you navigate away,
`FoodDashboard.tsx:223-224`).

The scope tag exists for **eviction**, not for routing: when a pane unmounts, its
`pane:*` entries are dropped from the stack because their inverses close over
pane-local state that no longer exists. `vault`-scoped entries — every note,
property, structural, view-config and schema action — survive pane changes,
because their inverses are pure IPC calls.

Depth: **50 entries**, matching the food stack's existing cap
(`FoodDashboard.tsx:235`). Time: unbounded within a session. **Not persisted
across restart** — a stale inverse against a vault that changed while the app was
closed is exactly the clobber this design exists to prevent; after restart, git
history is the recovery path.

### 2.4 Relation to git history

The vault *is* a quiet git repo (`history.rs:1-13`) — not a shadow repo. Its
cadence is batched idle snapshots:

```rust
const SNAP_QUIET: Duration = Duration::from_secs(120);      // lib.rs:85
const SNAP_MAX_DIRTY: Duration = Duration::from_secs(600);  // lib.rs:86
const SNAP_TICK: Duration = Duration::from_secs(15);        // lib.rs:87
```

`take_if_due()` fires when the vault has been quiet 120 s **or** dirty for 600 s
(`lib.rs:99`). So recovery resolution is **~2 minutes at best, ~10 minutes worst
case**, at whole-file granularity, in a commit that is vault-wide. A note edited
and re-edited inside one quiet window has only its final state committed.

That is the gap this design fills. Layer 2 covers the last-50-actions window that
git is structurally unable to see; git covers everything older, at coarser
resolution, durably. **Undo never writes to git and never reads from it** — they
are independent, and a layer-2 undo is just another mutation that the next
snapshot picks up. The one coupling: layer 2 does not attempt to undo anything
that already lives at git granularity (bulk schema sweeps, §5).

The `presweepSnapshot` rail (`App.tsx:1040-1044`) becomes the *documented*
recovery route for the non-participating class, and gets the UI it currently
lacks (§6.5).

### 2.5 Focus routing — which undo fires

⌘Z gets a registry entry, so routing stops being accidental. Precedence, top
wins:

1. **A text-editing surface has focus** (`.cm-content`, `input`, `textarea`,
   `contenteditable`) → its own text undo. CodeMirror's `historyKeymap`
   (`Editor.tsx:1124`) is a content-node handler and already fires before any
   window listener; native inputs likewise. App does nothing.
2. **Otherwise** → the app undo stack pops one entry.
3. **Stack empty** → nothing, and the app says so ("Nothing to undo") rather than
   silently no-op'ing.

Rule 1 is the existing `isTyping` predicate — which is currently **forked four
ways** with two different behaviours: `App.tsx:130-138` and `CalendarPane.tsx:40-48`
check INPUT/TEXTAREA/contentEditable/`.cm-content`; `DatabasePane.tsx:126-135`
and `FoodDashboard.tsx:52-61` add `SELECT`. Any routing that depends on "am I
typing" is inconsistent by construction until this is one exported helper. That
consolidation is slice 0 (§6.1).

**The escape hatch stays.** The food dashboard deliberately overrides rule 1
inside `.dash-form`, because after Enter-to-add the caret sits in a cleared field
and ⌘Z there means "undo the add" (`FoodDashboard.tsx:241-243`). That is correct
and generalizes: a form that *commits and clears* on Enter should opt its
container into app-undo. It becomes a declared attribute
(`data-undo-scope="app"`) rather than a hard-coded class check.

**Decided 2026-07-25**: ⌘Z inside a note's **property form** is native
input undo while a field has focus, app-undo once it blurs — the design's
default stands. The `data-undo-scope="app"` opt-in remains for commit-and-clear
forms like the food dashboard's.

---

## 3. The hard seam — editor undo vs filesystem undo vs external writers

This is where the design earns its keep. Substrate's vault is a shared surface:
agents edit files live, sync pulls rewrite them, other editors are open. Undo is
the operation most likely to write *stale* bytes, and SUB-287 proved it does so
silently when uncoordinated.

### 3.1 What the seam looks like today — verified

**Watcher** (`vault/watch.rs:61-230`): `notify::recommended_watcher`, recursive on
the vault root, with a **300 ms quiet-period debounce** that coalesces bursts
(`vault/watch.rs:151`). A 45 s full-rescan poll loop is the degraded fallback when
the watcher can't arm (SUB-157, `vault/watch.rs:52`, `:122`).

**The payload is empty.** `handle.emit("vault:changed", ())` — `lib.rs:682`. No
paths, no mtimes, no hashes. Every downstream consumer treats it as a wholesale
"re-read everything" signal. This is the single biggest structural fact about the
seam.

**Echo suppression** (`App.tsx:470-526`): app-initiated writes stamp
`lastOwnRefreshRef` (`App.tsx:366-368`); an event inside the **1000 ms** window
is deferred into one trailing refresh (`fireTrailing`, `App.tsx:477-491`) rather
than dropped. So a genuine external change inside the echo window surfaces ~1 s
late, never never. `refresh()` bumps `setVaultEpoch((e) => e + 1)` (`App.tsx:379`).

**Adopt** (`NotePane.tsx:519-556`, keyed on `vaultEpoch` alone at `:556`): re-read
the open note; if the body genuinely differs from `baseRef`, `adoptDiskBody`
(`:504-514`) swaps the doc in place. Guards, checked twice (`:523-524`, `:531`):
`missingRef`, `fileGoneRef`, `conflictRef`, `pending.current`, `saving.current > 0`,
plus a path-identity check (`:529`) so a late read can't land on a different note.

**Adopt never runs against a dirty buffer.** If there are unsaved edits, the epoch
effect returns early and divergence is discovered at write time instead.

**Save** (`NotePane.tsx:488-499`): trailing 500 ms debounce, whole-body write,
with a **compare-and-swap** — `expected = baseRef.current?.body` (`:328-329`),
compared server-side at `vault/mod.rs:1191-1195`. It is a **full body-string
comparison, not an mtime and not a hash**, and it deliberately excludes
frontmatter (`vault/mod.rs:1196-1199`), so an external FM-only edit never conflicts.
A conflict surfaces as a banner with reload-vs-overwrite (`NotePane.tsx:559-583`).
Failures never drop text — `pending.current = p` is restored in the catch (`:348`).

**The SUB-287 fix is one annotation** — `Editor.tsx:1253-1266`:

```ts
view.dispatch({
  changes: { from: 0, to: cur.length, insert: body },
  selection: { anchor: head },
  // not the user's edit: keep it out of the undo history, or the next
  // ⌘Z reverts the adopt and autosaves the stale body over the
  // external change (SUB-287). Earlier user edits stay undoable.
  annotations: [Transaction.addToHistory.of(false)],
});
```

It does **not** reset the history or rebuild the `EditorState`. The e2e lives at
`e2e/undoclobber.spec.ts`.

**Sync pull emits nothing.** `gitsync.rs` contains no `emit` at all. `vault_sync_pull`
(`commands/vaultsync.rs:93-99`) snapshots, then `gitsync::sync_pull_gated` fetches and may
`checkout_tree(...).force()` (`gitsync.rs:536`) over real files under the watched
root — so open editors learn about a pull **only through the OS watcher**, on the
300 ms debounce. `ensure_clean` (`gitsync.rs:582-593`) refuses a pull with a dirty
tree, and nothing flushes the frontend's `pending` buffer before the pull runs
(`VaultSyncPane.tsx:69-84` calls `vaultSyncPull()` directly).

### 3.2 The consequence SUB-287 left standing

The fix keeps pre-adopt user edits on the stack. So after an adopt, ⌘Z undoes
*the user's last edit, applied against a document someone else rewrote*. In the
e2e that is a no-op because there was no earlier edit. In general it is a
CodeMirror change-set replayed onto a document whose offsets moved. **Nothing
guards that today.** It is not the silent clobber SUB-287 fixed — the CAS guard
catches the write if the body diverged — but it is not coherent either.

### 3.3 Target design — the invalidation rule

> **An undo entry is invalidated the moment any path it touches changes on disk
> from a writer that is not this app's own action.**

Not "on any external change" (too aggressive — an agent editing an unrelated note
must not wipe the stack). Not "never" (that is the SUB-287 class of bug). The
entry's `paths` field is the key.

Implementation, in dependency order:

**(a) `vault:changed` must carry paths.** The watcher already has them — a
`HashSet<PathBuf>` accumulated across the debounce window (`vault/watch.rs:147-157`),
split by `config_path` at `lib.rs:668` and then **thrown away** at the emit.
Changing `handle.emit("vault:changed", ())` to carry the note paths is a small,
independently valuable change: it also lets `NotePane` stop re-reading the open
note on every unrelated bump. This is the enabling change for everything below,
and is scoped as its own slice (§6.4) precisely because it has value without undo.

**(b) Echo attribution.** With paths in hand, the existing 1000 ms
`lastOwnRefreshRef` window (`App.tsx:366-368`) becomes per-path instead of
global: a path this app just wrote is our echo; a path we didn't write is
external, even inside the window. Until (a) lands, the coarse window stands and
undo invalidation is conservative — see §3.5.

**(c) On an external change to path P**: every stack entry whose `paths` contains
P is marked `stale`. Stale entries are **not silently dropped** — they stay
visible in the undo menu (§6.5) greyed with "changed on disk", and ⌘Z **skips**
them. Dropping them silently would make ⌘Z reach further back than the user
expects, which is its own hazard. **Decided 2026-07-25: skip-and-show
ships as designed.**

**(d) Every undo write is conflict-guarded.** The inverse must fail rather than
clobber. Body writes already can (`expected`). Property writes cannot — §6.2 adds
`expected` to `vault_set_prop`. An inverse that hits a conflict does **not** pop:
it stays on the stack, marked stale, and the user is told what happened.

**(d′) Any inverse failure marks stale, not just a conflict.** `advance` runs only
on success (§6.1), so an entry whose inverse throws for *any* reason — the note was
deleted, the disk refused the write, the IPC errored — would otherwise stay at the
cursor and be re-offered on every subsequent ⌘Z, disabling undo for the session
after one failure. So the failure path marks the entry stale by the same mechanism
as (c) and the next ⌘Z walks past it. Conflicts keep their own message ("changed on
disk"); other failures toast the underlying error. Either way the stack keeps
moving.

This gives the invariant the credo demands:

> **An undo can never overwrite a change the user didn't make.** Either it
> applies to the state it was recorded against, or it refuses and says so.

### 3.4 Text undo and action undo do not merge

They stay separate stacks, and the rule that keeps them coherent is:

> **A note-body edit made through the editor is owned by CodeMirror's history and
> never enters the app stack.**

The app stack records *actions*: a property set, a move, a trash, a view change,
a bulk write. Typing is not an action; it's a continuous stream that CodeMirror
already groups better than any app-level scheme would.

Three consequences worth stating plainly:

1. **Adopts stay out of both stacks.** `Transaction.addToHistory.of(false)`
   handles CodeMirror; the app stack never sees an adopt because adopts are not
   user actions.
2. **The residual SUB-287 hazard (§3.2) gets an explicit answer**: when an adopt
   lands in a buffer that has undoable user history, that history is *marked* —
   the next ⌘Z in that editor shows a one-line confirm ("This note changed on
   disk since your last edit. Undo anyway?") instead of silently replaying. This
   is the only place in the design where undo asks a question, and it is asked
   because the alternative is replaying a change-set onto moved offsets.
   **Decided 2026-07-25: the confirm ships as designed.**
3. **Food dashboard's body-level undo is really an action undo.** Logging a meal
   is an action whose implementation happens to be a body rewrite. It folds into
   the app stack in slice 4 (§6.6) — and folding it in *fixes* its known bug: it
   mutates both stacks before the async write resolves (`FoodDashboard.tsx:252-257`),
   so a conflict permanently consumes the undo step and leaves a phantom redo.
   The shared implementation pops only on success.

### 3.5 Sync pull

A pull is not undoable and is not on the stack. But it rewrites files wholesale,
so it must **invalidate**. Two things:

1. `vault_sync_pull` emits an explicit `vault:pulled` with the changed paths
   before returning — the app should not learn about a git checkout by accident
   through the OS watcher on a 300 ms debounce. `gitsync::sync_pull` already
   knows the paths (it walks the diff for `conflicted`, `gitsync.rs:506-509`).
2. On `vault:pulled`, entries touching those paths are marked stale by the same
   rule as (c) above.

Interim behaviour, before (a) and this land: **any** `vault:changed` outside the
echo window marks the **whole stack** stale. Conservative, occasionally annoying,
never wrong. Slice 3 (§6.4) narrows it.

---

## 4. Can't-participate actions

Per the credo, each needs a named alternative recovery path.

| Action | Why not undoable | Recovery path |
|---|---|---|
| `vault_trash_delete` / `_folder` / `vault_trash_empty` | permanent by definition — the trash *is* the recovery layer | git history (`history_list`) — the note is still in past commits under its original path, since `history_purge_*` is a separate explicit action |
| `vault_assets_delete` | git history never tracks assets, and the delete is not on the undo stack | **trash parity landed**: the asset is moved to `.trash/<ms>/.assets/<name>` (`vault/assets.rs:259-289`) and `vault_assets_restore` puts it back, numbering rather than overwriting. Permanent only after `vault_assets_trash_delete` |
| `history_purge_note` / `_notes` / `history_trim` | rewrites/prunes git history itself | none by design; these are the "explicit actions are permanent" case. Must stay behind a confirm |
| `vault_sync_push` | publishes to a remote | remote-side; out of scope |
| `vault_sync_pull` | git-level merge | the pre-pull snapshot (`commands/vaultsync.rs:99`) |
| `vault_sync_set_remote` | stores a token that **cannot be read back** | re-enter the credential |
| `vault_rename_type`, `vault_delete_type`, `vault_rename_prop`, `vault_clear_prop` | count-only returns (partial runs report the count with the error, SUB-501); a reverse sweep catches notes that legitimately already matched | `presweepSnapshot` (`App.tsx:1040-1044`) → HistoryPanel restore. **Needs the UI in §6.5** |
| `folder_dbs_rescan` | multi-note, count-only | re-run it; the source folders are untouched |
| `term::*`, `file_open`, and any machine-bridge dashboard command | external processes and machine state | n/a |
| `export_text`, `export_note_bundle` | write **outside** the vault; prior destination contents are never read (`commands/assets.rs:20-23`) | n/a — but worth noting `export_text` silently truncates an existing file at the picked path |
| `url_capture` | mutates **asynchronously after returning** (`commands/notes.rs:106`, enrichment spawned at `:122`) | trash the created note manually |

**The rule for a new command**: if it can't be inverted with a bounded payload,
it must either take a `history_snapshot` first or be a soft-delete into the
trash. Landing a mutating command that does neither is a credo violation.

---

## 5. What "coarse recovery" means, concretely

Two durable layers behind the session stack:

- **Trash** — soft-deleted notes and folders, browsable and restorable
  indefinitely (`TrashPane.tsx:96-119`). Restore numbers on collision.
- **History** — `history_list(path)` runs `git log --follow` per note
  (`history.rs:257-267`), `history_diff` shows a unified diff (`:350-354`),
  `history_restore` writes an old version over the file and **snapshots on top —
  never a rewrite** (`commands/history.rs:121`, `:129`).

Note `history_restore` uses `write_raw` (`vault/mod.rs:1207`), which has **no
expected-body guard** — it is unconditional last-write-wins. That is defensible
for an explicit, user-chosen restore from a visible diff; it would not be
defensible for an automatic undo, which is why §3.3(d) exists.

---

## 6. Migration plan

Each slice ships and tests independently. Slice 1 is the most-felt gap.

### 6.0 Slice 0 — one `isTyping`, one registry entry (prep, ~half a day)

Not undo, but everything else routes through it.

- Export a single `isTyping` from `src/lib/` and delete the four copies
  (`App.tsx:130-138`, `CalendarPane.tsx:40-48`, `DatabasePane.tsx:126-135`,
  `FoodDashboard.tsx:52-61`). Settle the `SELECT` divergence — **include it**:
  a focused `<select>` should not eat ⌘Z.
- Add `undo` / `redo` entries to `SHORTCUTS` (`shortcuts.ts:188`+) with
  `scope: "app"`, so the cheat sheet stops lying by omission.

Tests: unit tests for `isTyping` across all five element kinds; a shortcuts test
asserting the sheet contains undo/redo.

### 6.1 Slice 1 — property edits ⭐ (the most-felt gap)

**Scope**: every `vaultSetProp` call site (§1.2) records an entry. Nine sites,
one shared helper. Bulk writes record one entry covering N notes.

**New module** — `src/lib/undo.ts`:

```ts
export type UndoScope = "vault" | `pane:${string}`;

export type UndoEntry = {
  id: number;
  label: string;
  scope: UndoScope;
  at: number;
  paths: string[];
  undo: () => Promise<void>;
  redo?: () => Promise<void>;
  stale?: boolean;
};

/** Pure stack mechanics — no React, no IPC. Unit-testable in isolation. */
export type UndoState = { entries: UndoEntry[]; cursor: number };

export const MAX_UNDO = 50;

export function push(s: UndoState, e: Omit<UndoEntry, "id">): UndoState;
/** the next entry ⌘Z would run — skips stale, returns null when exhausted */
export function peekUndo(s: UndoState): UndoEntry | null;
export function peekRedo(s: UndoState): UndoEntry | null;
/** mark every entry touching any of `paths` stale (§3.3c) */
export function invalidate(s: UndoState, paths: string[]): UndoState;
/** mark one entry stale by id — the failed-inverse path (§3.3d′) */
export function markStale(s: UndoState, id: number): UndoState;
/** drop entries whose scope is a pane that just unmounted (§2.3) */
export function evictScope(s: UndoState, scope: UndoScope): UndoState;
/** commit a successful undo/redo — moves the cursor. Never called on failure. */
export function advance(s: UndoState, id: number, dir: -1 | 1): UndoState;
```

Held in `App.tsx` as a `useReducer`, exposed to panes through a
`UndoContext` (`{ record(entry): void }`) so nine call sites don't each need a
prop drilled through.

**IPC changes** (§6.2 below). Slice 1 needs exactly one of them:
`vault_set_prop` gains an `expected` parameter and returns the prior value.

**Call-site change**, one shape everywhere:

```ts
// before
vaultSetProp(path, key, value).then(onMutated)

// after
setPropUndoable({ path, key, value, label: `Set ${key}` })
```

where `setPropUndoable` calls the IPC, reads `prior` out of the response, and
records `{ paths: [path], undo: () => vaultSetProp(path, key, prior, value) }`.

**What slice 1 deliberately does not do**: it does not touch the existing toasts.
Calendar and board drags keep their toast Undo button *and* gain a stack entry —
the toast becomes a discoverability affordance for an action that is also on ⌘Z.
Clicking the toast and pressing ⌘Z must be the same operation, so the toast's
`run` becomes "pop this entry by id", not a second independent closure.

**Test list (slice 1)**

*Unit — `src/lib/undo.test.ts`:*
1. push → peekUndo returns it; push 51 → the oldest is evicted, length 50.
2. push clears the redo side; advance(-1) then push clears redo again.
3. `invalidate(["A.md"])` marks only entries whose paths contain `A.md`.
4. `peekUndo` skips a stale entry and returns the next live one.
5. `evictScope("pane:food")` drops pane entries and keeps `vault` entries.
6. advance is a no-op for an id that isn't the current cursor (a rejected undo
   must not move the cursor).
6b. `markStale(id)` marks that one entry and `peekUndo` then returns the next
   live one — a failed inverse must not be re-offered forever (§3.3d′).

*Unit — property helper:*
7. `prior === null` (key absent) round-trips: set → undo → key absent again.
8. A list value (`string[]`) round-trips without stringification.
9. A bulk write over 3 paths where 1 fails records an entry with 2 paths.

*Rust — `src-tauri/src/vault/` tests:*
10. `set_prop_value` with a matching `expected` succeeds.
11. `set_prop_value` with a stale `expected` returns `conflict:` and leaves the
    file byte-identical.
12. `expected = None` bypasses the check (back-compat for existing callers).
13. The returned prior is `None` for a key that was absent, `Some(v)` otherwise.

*E2E — `e2e/undo-props.spec.ts`:*
14. Set a select cell in the database table → ⌘Z → the cell shows the old value
    and the file on disk has the old value.
15. Bulk-set status on 3 selected rows → ⌘Z → all 3 revert in one keystroke.
16. Set a prop, then have `__mockEditNote` change that same note externally, emit
    `vault:changed` → ⌘Z is refused with "changed on disk" and the external value
    survives. *(the SUB-287 pattern, at property granularity)*
16b. An inverse that fails for a non-conflict reason is skipped, not retried
    forever: the next ⌘Z reaches the entry beneath it (§3.3d′).
17. ⌘Z with focus in the editor undoes text, not the last property edit.

### 6.2 IPC changes required

Additive and back-compatible — every existing caller keeps working.

```rust
// commands/notes.rs:34 — gains `expected`, returns the prior value alongside the meta
#[tauri::command]
fn vault_set_prop(
    state: State<AppState>, dirty: State<SnapDirty>,
    path: String, key: String,
    value: Option<serde_json::Value>,
    expected: Option<Option<serde_json::Value>>,  // None = no guard (today's behaviour)
) -> Result<SetPropResult, String>;

pub struct SetPropResult { pub meta: NoteMeta, pub prior: Option<serde_json::Value> }
```

The double `Option` is load-bearing: outer `None` = "don't check", inner `None` =
"I expect this key to be absent". Engine change in `set_prop_value`
(`vault/mod.rs:1273`) — compare against the parsed prop map before mutating, return
`Err("conflict: property changed on disk")` on mismatch, mirroring the body
guard's wording (`vault/mod.rs:1193`).

Later slices need:

```rust
// commands/trash.rs:11 — return the trash id so undo doesn't scan by path (gap §1.9-1)
fn vault_delete(...) -> Result<String, String>;          // slice 2
fn vault_delete_folder(...) -> Result<TrashedFolder, String>;  // slice 2
//   TrashedFolder { id, icon: Option<DbIcon>, homes: Vec<(String,String)>, sidebar: Option<..> }
//   — the three config bits trash_folder currently discards (gap §1.9-4)

// lib.rs:682 — the watcher emits paths instead of ()                 slice 3
app.emit("vault:changed", ChangedPaths { notes: Vec<String> })
// gitsync — an explicit signal instead of learning via the OS watcher  slice 3
app.emit("vault:pulled", ChangedPaths { .. })
```

### 6.3 Slice 2 — structural actions

Trash (already has a toast, gains a stack entry + the returned id), create, move,
rename, folder create/rename/trash. Needs the `vault_delete` return-value change
so `restoreTrashed`'s path-scan (`App.tsx:1490`) can be replaced with an
id-keyed restore — which also fixes the "two notes trashed from the same path"
bug.

Rename is the risky one: its link sweep touches third-party notes, so its entry's
`paths` must include **every note whose links were rewritten**, not just the
renamed note. `Engine::rename` knows them; it must return them.

### 6.4 Slice 3 — path-scoped invalidation

`vault:changed` carries paths; echo attribution goes per-path; `vault:pulled`
lands. Until this ships, slice 1 and 2 use the conservative rule (§3.5: any
external change marks the whole stack stale). Independently valuable: NotePane
stops re-reading the open note on every unrelated vault bump
(`NotePane.tsx:519-556`).

### 6.5 Slice 4 — surface and discoverability

- An undo menu (Edit menu + a stack popover) listing the last N actions with
  their labels and stale marks — this is what makes a 50-deep stack usable and
  what makes "changed on disk" legible rather than mysterious.
- Toast Undo buttons become "pop entry #id", not independent closures.
- **A restore affordance for `presweepSnapshot`** — the snapshot is taken today
  (`App.tsx:1040-1044`) and no UI offers it. A schema sweep should end with
  "Renamed 47 notes — Restore from snapshot", and the snapshot's own failure must
  stop being swallowed by `.catch(console.warn)` (`App.tsx:1042`).

### 6.6 Slice 5 — fold in the food dashboard, view-config, single-prop schema

The food stack becomes `scope: "pane:food"` entries in the shared stack, which
fixes its pop-before-write bug (§3.4-3). View-config and single-prop schema
actions are all whole-object replaces (§1.5, §1.4) and are the cheapest entries
in the design — they land last only because they're the least-felt.

Bulk schema sweeps never join (§4).

---

## 7. Rejected alternatives

**Full event sourcing (log every mutation, rebuild state by replay).** Rejected:
Substrate's source of truth is *the files*, not a log. Any log is immediately
wrong the moment an agent or `rsync` touches the vault — which is a first-class
scenario, not an edge case (`docs/vision.md`, agents-edit-the-vault). A log that
can't see the writes that matter most is a liability that looks like a guarantee.
Git history already is the durable log, and it has the right property: it
observes the filesystem rather than trying to be it.

**Snapshot everything (copy the note, or the vault, before each action).** Rejected
on two counts. Cost: a per-action whole-vault copy is unaffordable and a
per-note copy is still large for a big note edited continuously. Correctness:
restoring a whole-note snapshot clobbers concurrent external edits to the parts
of the note the action never touched — the exact failure SUB-287 was about,
generalized. Narrow inverses are both cheaper and safer.

**Persist the stack across restarts.** Rejected: an inverse recorded before quit
is a bet that nothing changed while the app was closed — and sync, agents, and
other machines make that bet unwinnable. After a restart, git history is the
honest recovery path. (Revisit if per-path content hashes ever get cheap enough
to validate a whole stack at boot.)

**Per-pane stacks with focus-based routing.** Rejected: it's what exists today in
miniature, and it's why ⌘Z means five different things (§1.8). The user's model
is chronological, not spatial. Scope survives only as an eviction tag.

**Make the toast the whole design (extend it to every action).** Rejected: the
toast is a single shared slot (`App.tsx:304-309`) with a 4 s timer
(`App.tsx:393-397`), mouse-only, and it's destroyed by the *next* toast —
including by the undo action's own failure toast. It is a good notification and a
bad undo. It stays as a discoverability affordance over the real stack.

**A "conflict-free" undo that force-writes (`expected = null`).** Rejected
outright: it is the SUB-287 bug promoted to a feature. An undo that can overwrite
someone else's edit fails the credo more badly than having no undo at all,
because it destroys work the user never chose to touch.

**Undo via git revert of the last snapshot.** Rejected: the snapshot cadence is
120–600 s (`lib.rs:85-86`) and vault-wide. Reverting the last commit would undo
every change in a 2–10 minute window across every file — far more than the user's
last action, and completely unpredictable to them.
