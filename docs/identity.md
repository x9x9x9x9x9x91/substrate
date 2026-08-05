# Stable identity — relations and sync

**Status: spec, not built.** No engine code exists for it yet. Every
current-behavior claim below is cited to `file:line` as it stands on
`main` at 0.15.0.

## 0. The decision, in one paragraph

Notes get an opaque, stable `id:` in frontmatter. **Relations and sync
machinery resolve by that id; humans keep resolving by name.** Wikilinks do
not change at all — `[[Gero]]` stays `[[Gero]]` forever, and its ambiguity
stays a *reporting* problem for the vault doctor, not a resolution
problem. Ids are assigned lazily, so every note in an existing vault stays
byte-identical until it actually participates in something that needs
identity. The entire on-disk footprint is one line per participating note.

Why this and not more: `docs/vision.md:112` rules out CRDTs ("self-hosted /
file-based, no CRDT complexity"), and `vision.md:113-116` commits sync payloads
to end-to-end encryption — so there is no server that could hold an id→path
index. Identity has to be *intrinsic to the file*. A frontmatter line is the
smallest thing that is.

Why now: the reference vault this spec was measured against has **zero
relation props** (`.vault/schema.json`: text, multi, date and checkbox props
only, across a dozen databases). The migration's blast radius on real data is
currently nil. Every relation created between now and
the implementation is one more value to upgrade later.

---

## 1. The id

### 1.1 Shape

**12 characters of lowercase Crockford base32, 60 bits of entropy, no
structure.**

```
id: k3f9x2mq7ab1
```

Alphabet: `0123456789abcdefghjkmnpqrstvwxyz` — Crockford's, which drops `i`,
`l`, `o`, `u`. Generated from OS entropy, not from content, not from a clock.

Justification, against the alternatives:

- **vs ULID (26 chars, time-sortable).** Sort-stability buys nothing here:
  nothing in the codebase sorts by id. `SavedView` already carries an
  `id: String` (`src-tauri/src/vault/views.rs:168`) and no code path orders by it;
  notes sort by title, date, or prop. So ULID's one advantage is unused, and
  its costs are real — 26 characters is twice the frontmatter noise, and the
  embedded wall-clock timestamp becomes a lie the moment a note is created
  from a template copy or restored from `.trash/`, disagreeing visibly with
  `created:` one line above it.
- **vs UUIDv4 (36 chars with dashes).** Most noise, least readability, and the
  dashes invite people to think the segments mean something.
- **vs a 4–6 char "short random".** Too few bits. At 30 bits a 2000-note vault
  has a ~0.2% collision chance and a growing vault gets worse fast; collisions
  here are a *silent* correctness bug across devices that never talk to each
  other, which is the worst kind.
- **60 bits is the sizing.** Birthday bound: for *n* notes the collision
  probability is ≈ n² / 2⁶¹. At n = 100 000 that is ~4×10⁻⁹ — negligible for
  a vault an order of magnitude larger than any we've measured, generated
  independently on every device with no coordination.
- **Crockford specifically** (rather than plain base32 or hex) because
  dropping `i/l/o/u` makes ids unambiguous when read aloud or hand-copied,
  *and* because it does real work in the relation-value grammar (§2.1): an
  English word ending a title can almost never be mistaken for an id, since
  most words contain one of the four excluded letters.

**Not derived from content.** A content hash changes on every edit, which is
the exact opposite of stable. Named here only to close it off.

### 1.2 The key

**`id:`** — reserved, top-level frontmatter, string scalar.

The key is free in both namespaces that could claim it:

- The reserved-prop table (`docs/vault-format.md:139-149`) lists `type`,
  `title`, `created`, `calendar`, `url`, `artwork`, `dashboard`, `icon`,
  `cards`, `claimed_usd`, `log`/`db`/`floor`/`ceiling`. Not `id`.
- Schema prop-name reservations are only `icon` and `home`
  (`vault/schema.rs:847-852` in `rename_prop`, same pair in `create_type` at
  `vault/schema.rs:549-553`).
- Empirically: in the reference vault this spec was measured against, **no
  note carries `id:` or `uid:`** (illustrative scale below: ~2000 notes).

The credo objection — "an opaque line in a readable file" — is already settled
by that same vault: **almost every note carries a `notion_id:`** left by an
importer (32 hex chars, zero duplicates) and has for months. A 12-char `id:`
is a third of that footprint.

Cost of reserving a common word: someone may want a free-text `id` prop
("invoice id"). They use `ref:` or `invoice_id:`. This is documented in the
reserved table; the engine does not rename anyone's existing prop.

**The engine reads any id; it writes only the canonical shape.** A
hand-written `id: INV-2024-003` is a perfectly good identity — resolution is
exact string match, so any non-empty scalar works. Only *generation* is
constrained. This avoids a whole class of "the app rewrote my frontmatter"
surprise, and the doctor still catches duplicates regardless of shape.

Frontmatter serialization is alphabetical (`vault/mod.rs:2083`,
`serde_yaml::to_string` over a sorted map; documented at
`vault-format.md:93-95`), so `id:` lands mid-block, between `format:` and
`notion_id:` on a typical release note. It does not displace anything.

### 1.3 When an id is assigned — lazily

An id is written **only** by these triggers:

1. **Note creation through the app.** `create_full` (`vault/mod.rs:1376`) already
   writes `created:` and optionally `type:` into a fresh map
   (`vault/mod.rs:1427-1431`); `id:` joins them. Zero extra cost — the file is
   being written anyway.
2. **The note becomes a relation target.** Writing a relation value that
   points at note X stamps X in the same operation, then stores X's id in the
   source (§2).
3. **An explicit, opt-in maintenance action** from the vault doctor
   ("stamp all notes"), for someone who wants full coverage before a bulk
   operation. Never automatic.

And by nothing else. In particular:

- **Not on index, open, read, or search.** Reading must never write.
- **Not on sync.** One tempting variant is "lazily on first relation *or sync*
  touch"; sync-triggered stamping is the one variant to reject outright. A
  stamp is a file write; a write during pull produces a new commit on the
  pulling device, for a file the user did not touch, on both devices
  independently — which **manufactures exactly the conflicts this whole design
  exists to remove**. Sync reads identity; it never creates it.

Why lazy rather than a one-shot stamp of every note (say ~2000, the scale of
the vault this was measured against):

- Prop edits re-serialize the *entire* frontmatter block
  (`vault/mod.rs:1341-1347`; `vault-format.md:93-100`), normalizing quoting and key
  order. A one-shot stamp is therefore a whole-vault rewrite whose diff is
  mostly incidental re-quoting — unreviewable, and irreversible in practice
  even with a history snapshot.
- Under git-backed sync that lands on the phone as ~2000 changed files in one
  commit. Doing that immediately before phase 3 would be the single most
  hostile thing available to us.
- Old notes that never participate in a relation never need identity, and
  stay exactly as the user left them. That is the credo, applied.

**Consequence worth naming:** a note with no frontmatter at all gets a `---`
block created when it first becomes a relation target. Untyped notes *can* be
relation targets (`vault/search.rs:372-375` — an untyped target can't be aimed at,
so any relation matches it). The alternative — refuse to stamp
frontmatter-less notes — creates a permanent second class of note that can
never be identified. Accept the block; it only appears when the note has
actually joined a structure, and the doctor never proposes it.

**Notes whose frontmatter is unparseable or has duplicate keys cannot be
stamped.** `edit_props` refuses on those blocks (`vault/mod.rs:2078`, via
`parse_props_for_write`; `vault-format.md:97-99`). Such a note stays
identity-less and resolves by title forever, and the doctor reports it. This
is correct: a broken block is never silently normalized away.

### 1.4 Duplicate ids

Two files carrying the same id is the one failure mode ids introduce. It
happens three ways:

**(a) External file copy.** `cp Releases/Foo.md "Releases/Foo copy.md"`, or a
Finder duplicate, or a template copied outside the app. The copy inherits the
id.

**(b) Hand-edit.** Someone pastes an id from one note into another.

**(c) Concurrent lazy stamps under sync.** Both devices stamp the same
previously-unstamped note while offline. Handled separately in §4.6 — it is
a *merge* problem, not an index problem.

Detection is index-time and free: the index keeps
`by_id: HashMap<String, Vec<String>>` (id → rel paths) built in the same pass
that fills `notes`. More than one path per id = ambiguous.

**Resolution rule: an ambiguous id resolves to nothing, and nothing is
rewritten.**

- `resolve_id` returns `None` when the vec has ≠ 1 entry.
- Relation values naming an ambiguous id fall back to their cached title
  (§2.2). Behaviour degrades to *exactly today's*, never worse, never wrong.
- The doctor reports it as an **error**, listing both paths, with a
  user-driven fix: "give this file a new id", defaulting the suggestion to the
  later-mtime file (the likely copy). **The engine never picks silently.**

The rejected alternative — resolve to the oldest file by `created:` — is a
guess, and a wrong guess silently rebinds a relation to the wrong note. That
is worse than an unresolved relation, because it is invisible.

### 1.5 Deleted ids

A user who deletes `id:` from a note has erased its identity. The engine's
behaviour:

- The note is unidentified again; relations naming that id fall back to title.
- On the next lazy trigger the note gets a **new** id. It is not resurrected
  from anywhere — there is no id history and no shadow store.
- The doctor reports "N relation values name an id no note carries" as a
  **warning**, not an error, because a dangling id is indistinguishable from a
  trashed target — the same asymmetry that already exists for titles
  (`vault-format.md:754-756`: trashing a target rewrites nothing).

---

## 2. Relations

### 2.1 Stored value grammar

Today a relation value is the target's display title as a YAML scalar, or a
string list for several (`vault-format.md:733-742`; frontend model in
`src/lib/relation.ts:11-27`).

Going forward a value is **`Title ^id`**:

```yaml
contact: Gero ^k3f9x2mq7ab1
contact:
- Gero ^k3f9x2mq7ab1
- Noa ^7bq4nz8t2v0m
```

Parse rule: `^(?<title>.*?)\s*\^(?<id>[0-9a-hjkmnp-tv-z]{4,})$`. Anything that
doesn't match is a bare title, handled by the fallback path. The value stays a
plain YAML string, so it rides the existing prop discipline unchanged
(`vault-format.md:743-746`: strings or string lists via `vault_set_prop`,
non-string lists refused, prop editor writes strings only,
`vault-format.md:101-103`).

Why this shape and not the alternatives:

- **Bare id (`contact: k3f9x2mq7ab1`)** — unreadable in a text editor. Fails
  the credo outright: the file stops telling you what it says.
- **Two props (`contact:` + `contact_id:`)** — doubles the prop count, breaks
  the one-prop-one-thing model, and every bulk operation (`rename_prop`
  `vault/schema.rs:833`, `clear_prop` `vault/schema.rs:1073`) would need to know
  about the shadow key and keep it in step. Two things that must agree will
  eventually disagree.
- **YAML mapping (`contact: {title: …, id: …}`)** — a non-string value. The
  prop editor can't write it (`vault-format.md:101-103`), lists of them are
  refused on the write path, and every reader in the frontend
  (`relation.ts:13-19` `propList`) assumes strings. Largest blast radius for
  the least gain.
- **The caret specifically** — quiet, not already meaningful in this format
  (`#` is a tag, `|` implies the wikilink alias form that
  `vault-format.md:157-158` explicitly does not have, parens are common in real
  titles). And a misparse is safe: `Ancestors ^Live` doesn't match, because
  `i` isn't in the Crockford alphabet, so the whole string is treated as a
  title and resolves the old way. **Misparse degrades to today's behaviour,
  never to a wrong note.**

The title half is a **cache for humans and for fallback**. The UI renders the
resolved note's *live* title, so a stale cache is never visible in the app —
only in a text editor, and only until the value is next written.

### 2.2 Resolution order

1. If the value parses as `Title ^id` and **exactly one** note carries that
   id → that note. Title is ignored.
2. Otherwise (no id, unknown id, or ambiguous id) → today's name match:
   case-insensitive against title-or-stem, scoped to props aimed at the
   target's type (`vault/mod.rs:1743-1744` in `relation_rewrites`,
   `vault/search.rs:372-375` in `related()`).
3. If step 2 matches **more than one** note within the aimed-at type → resolves
   to nothing, and the doctor reports it.

Step 3 is where "the winner is unspecified" dies for relations. Today
`resolve_link` takes the first arbitrary `HashMap` iteration match:

```rust
// vault/mod.rs:1712-1718
pub fn resolve_link(&self, name: &str) -> Option<NoteMeta> {
    let needle = name.trim().to_lowercase();
    self.notes.values()
        .find(|n| n.title.to_lowercase() == needle || n.stem.to_lowercase() == needle)
        .cloned()
}
```

…and `vault-format.md:745-746` states the consequence plainly: "two target
notes sharing a title are indistinguishable as values." That line stops being
true. Concretely: the picker currently collapses duplicate titles and keeps
the first, so the second note is **literally unpickable**
(`relation.ts:37-51`, `seen` set keyed on lowercased title). With ids both
are pickable and each resolves to itself.

This matters on real data. A vault of a couple of thousand notes typically
carries a dozen or so live case-insensitive duplicate stems — the same name
used for a person and for a contract, a `home` note per area, a stray
`untitled`. Some pairs are saved by type scoping (`Contacts/Alex Wang.md` is a `contact`,
`Label/Contracts/Alex Wang.md` is a `contract`); same-type pairs are not.

**Rule 2 is permanent, not transitional.** A bare title always resolves. There
is no flag day, no cutoff version, no "migrate or your relations break."

### 2.3 Migrating existing title-based relations

**Lazy rewrite on next write, plus an opt-in one-shot from the doctor.**

- Lazy: whenever a relation prop is written for any reason, its values are
  upgraded to `Title ^id` (stamping targets as needed). No separate pass.
- Opt-in: the doctor reports "N relation values could carry ids — upgrade
  now?", taking a `history_snapshot` first, as `vault-format.md:1164-1166`
  already requires before any bulk sweep.

The nothing-is-ever-lost argument: because rule 2 is permanent, an unmigrated
value is not *degraded*, it is simply **pre-id** — it resolves exactly as well
as it does today. So the one-shot is a convenience, never a requirement, and
a user who never runs it never notices. That is what makes it safe to ship
lazily; a migration you are allowed to skip forever cannot break anyone.

And on the reference data specifically: with zero relation props live, there is
currently nothing to migrate at all.

### 2.4 What this does to rename

`rename`/`rename_tracked` (`vault/mod.rs:1515`, `:1531-1715`) today does one
logical operation as many writes: wikilink rewrites across every referring note
(collected at `1557-1585`, flushed at `1629-1635`), `fs::rename`
(`1618-1620`), relation-value rewrites collected pre-move and applied after
(`1643`, `1672-1684`), the note's own frontmatter re-serialized
(`1650-1670`), then reindex (`1686-1695`). Sources that can't be read or
written are collected into `failed` and reported *after* the rename has
already landed (`1709-1717`).

With ids, the relation half of that fan-out stops being load-bearing.
Rewriting the cached titles remains — it is cheap, already written, already
tested — but is **demoted from correctness to hygiene**: a failed relation
rewrite now leaves a stale word in a file, not a broken link. So:

- Wikilink rewrite failures stay hard errors. Wikilinks have no id; a stale
  `[[Gero]]` really is broken.
- Relation rewrite failures become warnings **when every failed value carried
  an id**, and stay errors when they didn't.

That is a real reduction in the severity of the two known partial-failure
bugs, without changing the rename flow's shape.

---

## 3. Databases

### 3.1 The decision

**Databases get a stable id in `.vault/schema.json`; notes keep the human
`type:` string.** Machinery references the id; humans and note frontmatter
reference the name.

This is a third option, deliberately, against the two obvious ones:

- **Notes carrying `type: k3f9x2mq7ab1`** would let a database rename touch
  only schema.json — a genuine sync win. Rejected anyway: `type:` is the
  single most-read prop in the vault, present on nearly every note, and read
  and hand-edited constantly outside the app. Making it opaque trades a
  *rare* operation (renaming a database: a handful of times ever) against a
  *constant* one. That is the credo's whole point, and this is the one place
  where an id would visibly break it.
- **Pure name-keying (status quo)** leaves `rename_type` doing an O(all-notes)
  rewrite *and* five separate machinery rewrites — and it already misses
  three of them (§3.2).

So: ids where machinery reads, names where humans read. Same rule as §2,
applied to the other axis.

### 3.2 What name-keying costs today

`rename_type` (`vault/schema.rs:606-721`) rewrites, in order: `type:` on every
member note via `edit_props` — a full frontmatter re-serialize per note
(`645-655`); the schema key (`662-666`); relation `target` fields across
all types (`667-675`); the views.json per-db pref key (`681-685`); the
`$sidebar` databases order (`686-691`, via `remap_sidebar_entry`
`vault/views.rs:975`); the template file (`697-702`); folders.json mappings
(`706-719`).

It misses three, verified:

1. **Saved views' `db` field.** `SavedView` (`vault/views.rs:167-193`) has
   `db: String` at `:170`, stored under `SavedView::KEY = "$views"`
   (`:195-197`). `rename_type` never touches `$views`. Rename a database and
   every saved view on it silently points at a database that no longer exists.
2. **`$sidebar.collapsed` `dbpins:<type>` entries.** `remap_sidebar_entry`
   (`vault/views.rs:986-1015`) maps `order.databases` and `order.keys` only;
   `collapsed` is a separate `Vec` holding entries like `"dbpins:release"` (see
   the fixture at `vault/views.rs:1552`). Collapse state orphans on rename.
3. **` ```view ` fences in note bodies** (`vault-format.md:483-513`), whose
   `type:` / `saved:` keys name databases in prose. Rename and the embed goes
   blank.

Each is a separate rewrite site someone forgot. Adding three more is not the
fix — it's the fourth, fifth, and sixth chance to forget one.

### 3.3 The rename flow, after

Schema type entries gain a reserved **`"$id"`** key. The `$` prefix is the
existing reservation convention in this format (`vault-format.md:866-869`:
"Keys starting with `$` are reserved — real database names never start with
`$`"), and it cannot collide with a user prop, which matters because
`TypeSchema` flattens user props into the same map
(`vault/schema.rs:176-177`, `#[serde(flatten)] props`). It is declared as a real
field with `#[serde(rename = "$id")]`, not left to the flatten.

Then:

- `$views[].db`, the views.json per-database pref key, `dbpins:<…>` entries,
  a folder mapping's `type` (`FolderMapping::db_type`, `vault/foldersync.rs:21-22`),
  and a relation's `target` (`PropSchema.target`, `#[serde(rename = "type")]`
  at `vault/schema.rs:61-62`) all store the **db id**, with read-time fallback to a
  name for files written before this ships.
- `rename_type` shrinks to two operations: rewrite `type:` on member notes,
  and set the schema entry's display name. Every machinery reference is
  untouched *by construction* — the three misses become impossible rather
  than fixed.
- The relation type-scoping comparisons (`vault/mod.rs:1743-1744`,
  `vault/search.rs:372-375`) resolve the note's `type:` string to a db id
  through the schema before comparing.

Two things stay name-based, deliberately:

- **`.vault/templates/<type>.md`.** A template file named
  `k3f9x2mq7ab1.md` is unfindable in Finder. Keep the name, keep the rename
  (`vault/schema.rs:697-702`).
- **` ```view ` fences.** These are human-authored config in prose
  (`vault-format.md:483-513`); an id there is unreadable. They resolve by
  name at render time. **Decided 2026-07-25: a database rename
  rewrites the fence's `type:`/`saved:` line in note bodies too** —
  "frictionless wins always if it's not destructive," and this rewrite is
  surgical (one config key inside a fence, never prose) and lossless (old
  name → new name, reversible by renaming back). The implementation slice
  must scope the rewrite to the fence's key line only — the grammar is
  structured, so this is a targeted edit, not free-text replacement. A fence
  naming a database that genuinely doesn't exist (typo, hand-edit) still
  renders an explicit "no such database: X" state, and the doctor reports it.

**Accepted cost:** the `type:` rewrite across member notes stays. A database
rename remains an N-file sync event. That is the price of a readable `type:`,
and it is worth it because database renames are rare and `type:` reads are
constant.

---

## 4. Sync semantics — worked examples

Current model, verified: `sync_pull` (`src-tauri/src/gitsync.rs:428-541`)
fetches, builds a three-way merge **in memory** via `repo.merge_commits`
(`:503-505`), and on conflict inspects the index and returns:

```rust
// gitsync.rs:506-509
if merged.has_conflicts() {
    let conflicted = conflict_paths(&mut merged)?;
    return Ok(report(0, 0, conflicted, local_oid));
}
```

The doc comment at `:425-427` states the consequence: "a conflicted index is
inspected and then dropped, leaving the repository's real index, HEAD, and
working tree untouched." So **one conflicted file blocks the entire pull**,
leaves no on-disk artifact, and offers no in-app resolution path. Both devices
also commit as the same identity, `Substrate <substrate@local>`
(`gitsync.rs:226`, `:269`, `:519`), so there is no device provenance to
resolve by either.

That is the cost model: every extra file a rename touches is another chance to
block every future pull until someone opens a terminal on the Mac.

### 4.1 The headline case — offline rename, concurrent prop edit

- **Phone (offline):** renames `Contacts/Gero.md` → `Contacts/Gero Weiss.md`.
  Today that is 1 file move + this note's own frontmatter + relation-value
  rewrites in the 12 release notes pointing at it (`vault/mod.rs:1672-1684`).
  **13 changed files.**
- **Mac (same window):** adds `status: mastered` to one of those 12 releases.
  A prop edit re-serializes the whole frontmatter block
  (`vault/mod.rs:1341-1347`), so the entire `---` region is one changed hunk.
- **Merge:** both sides rewrote the same frontmatter region of the same file →
  **conflict** → the whole pull is blocked (`gitsync.rs:506-509`), for a
  rename that has nothing whatsoever to do with `status:`.

With ids: the value `Gero ^k3f9x2mq7ab1` still resolves after the rename, so
the 12 rewrites are cosmetic (§2.4) and can be skipped or deferred. The phone
changes **1 file**. Zero overlap with the Mac's edit. **Clean merge.**

The general form: *an id turns a 13-file rename into a 1-file rename, and 12
fewer files is 12 fewer conflict opportunities.*

### 4.2 Divergent renames of the same note

- **Phone:** `Gero` → `Gero Weiss`. **Mac:** `Gero` → `G. Weiss`.
- **Today:** two paths for one note (a real rename/rename conflict), *plus*
  12 unrelated notes rewritten to two different strings on the two sides — 12
  more conflicts, all blocking. Worse, after someone resolves them by hand the
  relation values can end up split: some say `Gero Weiss`, some say
  `G. Weiss`, and **half the relations silently point at nothing** because the
  file only has one name.
- **With ids:** the file-name conflict remains — that is a genuine human
  disagreement and no design can resolve it. But every relation value on both
  sides is byte-identical (`Gero ^k3f9x2mq7ab1`), because none of them named
  the title. Resolving the one file resolves everything. **No relation is ever
  left dangling.**

This is the nothing-is-ever-lost argument in its concrete form.

### 4.3 Same-titled targets, one added per device

A vault with duplicate stems (§2.2) hits this. Add a relation on the Mac meaning one
`Alex Wang`, and on the phone meaning the other.

- **Today:** both values are the string `Alex Wang`. Type scoping saves this
  particular pair (one is `contact`, one is `contract`) — but a same-type pair
  is unrecoverable: `vault-format.md:745-746` says the two are
  "indistinguishable as values," and the picker won't even offer the second
  (`relation.ts:37-51`).
- **With ids:** the values differ, both are pickable, both resolve exactly,
  and the merge is a clean two-line addition.

### 4.4 Move on one device, relate on the other

- **Today:** already fine — moving rewrites nothing, because values name
  titles rather than paths (`vault-format.md:752-753`).
- **With ids:** identical.

Listed so the doc doesn't oversell: **ids fix rename and ambiguity, not
everything.**

### 4.5 The duplicate-copy case, propagated

Phone duplicates a note outside the app; both files carry the same id; sync
propagates both. The id goes inert (§1.4), every relation naming it falls back
to its cached title, the doctor reports both paths. **Nothing is silently
rebound onto the copy** — which is precisely what a "resolve to the oldest"
rule would have done.

### 4.6 Concurrent lazy stamps — the hazard ids introduce

Both devices stamp the same previously-unstamped note while offline. Both
insert an `id:` line at the same alphabetical position in the same frontmatter
block, with different values → a text conflict inside one note → the whole
pull blocks (`gitsync.rs:506-509`).

This is real, and it is the one case where identity needs merge smarts.

**Repair rule: the lexicographically smaller id wins; the other is
discarded.** Ids carry no information, so discarding one loses nothing. The
only consequence is that relation values written on the losing device now name
a dead id and fall back to their cached title — which is exactly pre-id
behaviour. Degradation, not loss.

Implementation shape: on a conflicted pull, if a file's only conflicting hunk
is the `id:` line, resolve it in memory by that rule before concluding the
pull is blocked. Scoped as its own slice (§6, slice 6) because it is the only
place in this design that touches the merge path.

Rejected alternative: derive the id deterministically so both devices produce
the same one. That requires hashing content, which makes the id change on
every edit (§1.1).

---

## 5. What does **not** change

Stated explicitly, because the value of this design is as much in what it
leaves alone.

- **Wikilink grammar.** `[[Target]]`, exactly `\[\[([^\[\]]+)\]\]`; the inner
  text may carry a heading anchor and a display alias, `[[target#anchor|alias]]`,
  and resolution still matches the target alone (SUB-1095, `vault-format.md` §3).
  **There is no `[[id]]` form and never will be** — a link names a note by its
  name, and an alias changes what you read, not what it points at.
- **Wikilink resolution.** Case-insensitive title-or-stem, one test not two
  phases (`vault/mod.rs:1712-1718`, `vault-format.md:160-163`). Unchanged.
- **Wikilink rewriting on rename.** Still happens, still a hard error on
  failure (`vault/mod.rs:1629-1635`, reported at `:1705-1710`).
- **Note bodies never contain ids.** No write path puts an id in body text.
  The word never appears in prose.
- **Backlinks stay name-based** (`vault_backlinks`; `vault-format.md:170-171`).
- **Search does not index ids.** Typing an id into `[[` does nothing; typing
  one into search finds nothing. Ids are not a user-facing addressing scheme.
- **Wikilink ambiguity stays a reporting problem.** The winner remains
  unspecified for `[[…]]`, and the answer remains the **vault doctor's**
  duplicate-title / title-stem-collision report (not built yet). §2.2's
  rule-3 hardening applies to relation values only.

Why the split is coherent rather than arbitrary: **a wikilink is prose written
by a human for a human; a relation value is a machine-maintained field in a
structured record.** The first has to *read* like English, so its identity has
to be its name, and its ambiguity has to be solved socially (rename one of
them — that's what the report is for). The second only has to *display* like
English, so it can carry an id behind the name.

---

## 6. Agent contract

For `vault-format.md` §13 ("Rules for well-behaved external writers") and §2.

**Creating a note:** omit `id:`. The engine assigns one when the note first
needs identity (§1.3). An agent that writes its own must use the canonical
grammar (§1.1) and must never reuse one it has seen.

**Copying a note: strip the `id:`.** This is *the* rule external writers must
know — a file copied with its id in place is a duplicate identity (§1.4), and
duplicate identity is the only way this design fails. It sits alongside the
existing "if you rename a file directly, update the `[[links]]` yourself"
(`vault-format.md:1132-1134`).

**Never rewrite or tidy another note's `id:`.** It is not yours, it is not
formatting, and normalizing it breaks every relation pointing at that note.

**Writing a relation value:** a bare `Title` is always valid and always
resolves (§2.2 rule 2) — an agent that doesn't know the target's id should
write the title and stop. `Title ^id` is preferred when the agent does know
it (read it from the target's frontmatter). **Never write a bare id with no
title** — the file would stop being readable, which is the whole point.

**Reading:** to find a note by id, scan frontmatter, or call
`vault_resolve_id` when the app is running (§7 slice 1).

**Deleting an id** is allowed and means "this note has no stable identity."
The engine re-stamps on next need with a **new** id, and relations naming the
old one degrade to title (§1.5).

---

## 7. Rollout slices

Independently shippable, each with its own test list, each sized for one
sitting. Slices 1–6 are sequential; slice 7 is independent of 2–6.

### Slice 1 — id generation, index, `vault_resolve_id`

No user-visible behaviour change. Foundation only.

- **New file `src-tauri/src/id.rs`:**
  - `pub fn new_id() -> String` — 8 bytes from `getrandom`, low 60 bits,
    12 chars over `0123456789abcdefghjkmnpqrstvwxyz`.
  - `pub fn is_id(s: &str) -> bool` — length ≥ 4, alphabet-only, lowercase.
  - `pub fn parse_relation_value(s: &str) -> (&str, Option<&str>)` — the
    `Title ^id` split from §2.1, used by both Rust and mirrored in TS.
- **`src-tauri/Cargo.toml`:** add `getrandom = "0.3"`. Already present in
  `Cargo.lock` transitively via tauri (three versions: 0.2.17, 0.3.4, 0.4.3),
  so **no new crate enters the build graph** — this is a direct-dep
  declaration, not a new dependency.
- **Index:** `NoteMeta` gains `id: Option<String>` read from `props["id"]`;
  `Vault` gains `by_id: HashMap<String, Vec<String>>` built in the same pass
  as `notes`; `pub fn resolve_id(&self, id: &str) -> Option<NoteMeta>`
  returning `None` when the vec length ≠ 1.
- **IPC:** `vault_resolve_id` in `src-tauri/src/lib.rs`, Links/search group.

**Tests:**
1. `new_id` output matches the grammar: 12 chars, alphabet-only, contains no
   `i`/`l`/`o`/`u`.
2. 10 000 generated ids are all distinct.
3. `is_id` rejects `""`, `"abc"` (too short), `"live"` (excluded letter),
   `"K3F9X2MQ7AB1"` (uppercase), `"k3f9-x2mq"` (punctuation).
4. `parse_relation_value("Gero ^k3f9x2mq7ab1")` → `("Gero", Some(...))`.
5. `parse_relation_value("Ancestors ^Live")` → `("Ancestors ^Live", None)`.
6. `parse_relation_value("Gero")` → `("Gero", None)`.
7. A hand-written `id:` is picked up by the index.
8. Two files sharing an id → `resolve_id` returns `None`, and `by_id` lists
   both paths.
9. A non-canonical id (`INV-2024-003`) indexes and resolves normally.
10. A note with no `id:` indexes with `id: None`.
11. `id:` survives `vault_write_body` byte-verbatim
    (`vault-format.md:84-92`).
12. `id:` survives a prop edit, landing in its alphabetical position.

### Slice 2 — stamp on create, `ensure_id`

- `create_full` (`vault/mod.rs:1427-1431`) writes `id:` alongside `created:`;
  `"id"` joins `"created" | "type" | "title"` in the caller-prop filter at
  `vault/mod.rs:1432-1438` (callers can't set it; an explicit `import_id`
  parameter is a later hook if a Notion import ever wants
  `notion_id` → `id`).
- `pub fn ensure_id(&mut self, rel: &str) -> Result<String, String>` — returns
  the existing id, or stamps one via `edit_props`.

**Tests:** create writes a well-formed id; two creates differ; `ensure_id` is
idempotent and writes nothing on the second call (assert the existing
`#[cfg(test)] note_writes` counter at `vault/mod.rs:2087-2090` is unchanged);
`ensure_id` on an unparseable frontmatter block returns `Err` and leaves the
file byte-identical (`vault/mod.rs:2078`); `ensure_id` on a
note with no frontmatter creates the block with only `id:` in it.

### Slice 3 — relation values carry ids

- `src/lib/relation.ts`: `parseRelationValue` / `formatRelationValue`;
  `RelationCandidate` (`relation.ts:5-9`) gains `id`, sourced from
  `NoteMeta.props.id` — it already carries `path` at `:49`, so the picker
  already knows which note it means and only lacks a stable handle for it.
- Writing a relation value calls `ensure_id` on the target first — the §1.3
  trigger.
- Rust: `relation_rewrites` (`vault/mod.rs:1727-1779`) and `related()`
  (`vault/search.rs:353-399`) match id first, name second.
- Resolution implements §2.2 including rule 3 (ambiguous name within the
  aimed-at type → nothing).

**Tests:** an id-valued relation resolves after the target is renamed with
*no* rewrite applied; a bare-title value still resolves (permanent fallback);
an unknown id falls back to its cached title; two same-titled same-typed
targets are both offered by the picker and each resolves to its own note;
`related()` counts an id-valued source; a title ending in ` ^live` is not
parsed as an id; a list value mixing `Title ^id` and bare-title entries
resolves both.

### Slice 4 — rename demoted to cosmetic

- In `rename_tracked` (`vault/mod.rs:1672-1710`), relation-rewrite failures become
  warnings when every failed value carried an id, and stay errors otherwise.
  Wikilink failures (`vault/mod.rs:1632`) stay errors unconditionally.

**Tests:** rename with an unwritable id-backed relation source succeeds with a
warning; the same with bare-title values still errors; an unwritable wikilink
source still errors.

### Slice 5 — doctor findings

- **Error:** duplicate id, both paths, "re-stamp this one" fix defaulting to
  the later-mtime file.
- **Warning:** relation value naming an id no note carries.
- **Warning:** relation value ambiguous by title within its aimed-at type.
- **Warning:** note whose frontmatter can't be parsed, so it can never be
  stamped.
- **Info:** count of bare-title relation values, with an "upgrade N values"
  bulk action that takes a `history_snapshot` first
  (`vault-format.md:1164-1166`).

### Slice 6 — merge repair for concurrent stamps

- In `sync_pull` (`gitsync.rs:503-509`): when a file's only conflicting hunk
  is the `id:` line, resolve in memory by smaller-id-wins (§4.6) before
  concluding the pull is blocked.

**Tests:** a two-branch fixture stamping the same note differently merges
clean and keeps the smaller id; a real body conflict on the same file still
blocks; relation values naming the discarded id fall back to title.

### Slice 7 — database ids (independent of 2–6)

- `TypeSchema` (`vault/schema.rs:168-178`) gains `#[serde(rename = "$id")] id`,
  declared as a field so the `#[serde(flatten)] props` map can't swallow it.
- `$views[].db` (`vault/views.rs:170`), views.json per-db pref keys, `dbpins:<…>`
  entries, `FolderMapping::db_type` (`vault/foldersync.rs:21-22`), and
  `PropSchema.target` (`vault/schema.rs:61-62`) store ids, with read-time name fallback.
- `rename_type` (`vault/schema.rs:606-721`) shrinks to member-note `type:` rewrite
  + display-name change.
- ` ```view ` fences stay name-based; a database rename rewrites the fence's
  `type:`/`saved:` key line in note bodies (decided 2026-07-25 — frictionless,
  non-destructive, key-line-scoped); a name that resolves to nothing renders
  an explicit error state and surfaces in the doctor.

**Tests:** rename a database → saved views still resolve; `dbpins:` collapse
state survives; folder mappings survive; a relation `target` survives a
target-database rename; a schema.json with no `$id` loads and resolves by
name; a `view` fence's `type:` line is rewritten on database rename while
surrounding prose is byte-untouched; a fence naming a nonexistent database
renders the error state rather than an empty table.

---

## 8. `docs/vault-format.md` diff plan

**Not applied yet** — these are the exact edits the implementation should
make to that file.

| Section | Edit |
|---|---|
| §2 *Props the app gives meaning to* (`:135-151`) | Add an `id` row to the reserved table. After `:151` ("Everything else is yours"), add a short paragraph: shape, lazy assignment, and the copy hazard. |
| §2 *What the engine preserves vs normalizes* (`:82-103`) | Note that a prop edit may additionally stamp `id:` when the note becomes a relation target — a write can add one key the caller didn't ask for. |
| §2 *`title:` and the filename* (`:105-133`) | The new-note skeleton at `:126-133` gains an `id:` line. |
| §3 *Wikilinks* (`:155-172`) | One sentence: links never carry ids. The ambiguity note at `:160-163` stands, and gains a pointer to the doctor's report. |
| §4 *Databases and prop values* (`:203-274`) | Mention that `type:` stays the human name while machinery keys on the schema `$id`. |
| §6 *`.vault/schema.json`* (`:576-727`) | Document the reserved `$id` key on type entries; `PropSchema.target` stores a db id with name fallback. |
| §6 *Relation properties* (`:728-768`) | The largest edit. New value grammar `Title ^id`; resolution order (§2.2); rename demoted to cosmetic; **rewrite `:745-746`** — "two target notes sharing a title are indistinguishable as values" is no longer true; `related()` matches ids. |
| §7 *views.json* (`:798-911`) | `$views[].db` and per-database pref keys hold db ids; `dbpins:<id>`. |
| §8 *folders.json* (`:926-978`) | A mapping's `type` (`:943`) holds a db id, with name fallback; note the `rename_type` sentence at `:950-952` shrinks accordingly. |
| §11 *`.git/`* (`:1024-1061`) | The concurrent-stamp merge-repair rule (§4.6). |
| §13 *Rules for well-behaved external writers* (`:1103-1138`) | New numbered rule: **never copy a note's `id:`**. Plus the create and relation-write contract from §6 of this doc. |
| §14 *IPC surface* (`:1140-1178`) | `vault_resolve_id` joins the Links/search group at `:1147`. |
