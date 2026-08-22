# Time-travel queries — spec

Ask the vault what a value *was*. `AT("2026-01-01", Holdings.total)` in a sheet,
a weight curve charted straight from a frontmatter key's past — computed from the
git history every vault has been accruing since its first launch. No snapshot
system gets built; the snapshots are already there.

**Status: §7.2's first slice shipped in 0.23.0; §4 did not.** `PROP()` and
`AT()` are in the formula engine (`src/lib/formula.ts`, `SCALAR_FNS`), the
chart `history:` source parses and renders (`src/lib/chart.ts`), and the
shared Rust lane engine underneath all of it is `src-tauri/src/factlane.rs`,
reached through `history.rs` / `githist.rs` and a `commands/history.rs`
command. What is **not** built: §4's persisted lane cache — every lane is
still walked out of git per call — and its measurement gate was never run.
§5.3's key-rename stitching stays out by §7.1's own choice. The open
product-shape questions below were answered by the slice that shipped; read
them as the record of why it works the way it does.

File refs are against main's tip at the time of writing; symbols are the
stable reference, line numbers may drift. Every claim about current
behaviour below carries a `file:line` anchor, or is marked **assumption**
where it wasn't verified in code.

This spec is subordinate to the **receipts spec** — the separate design for
showing a fact's full change history — on everything the two share: the
key-following lane engine, its storage, and its invalidation contract. Where this
document would diverge from it, it says so out loud (§5.4) rather than quietly
designing a second engine. That worked out: one engine shipped for both, and
`src-tauri/src/factlane.rs`'s module doc names receipts, `AT()`/`PROP()` and
the chart `history:` source as its three consumers.

---

## Open questions

Six product-shape questions. Each has a recommended default first; the spec stays
buildable on the defaults if they lag.

1. **When the past is unknowable, does the cell go blank or shout?** After a
   history trim — or for any date before the vault existed — Substrate genuinely
   cannot answer, and a blank in a money column reads as "it was zero".
   Options: **(a) a visible `no history before 2025-03-01` message in the cell**,
   (b) blank like any missing value, (c) zero. *Recommended: (a).*

2. **March's total — computed with March's formula, or today's?** A sheet queried
   at a past date can re-run the formula that was written back then (the sheet as
   it was), or today's formula over March's rows (the analysis as you think about
   it now). Options: **(a) the sheet as it was**, matching the existing vault
   scrubber, which renders old databases against their old schema
   (`commands/history.rs:71-73`); (b) today's formula over historical data.
   *Recommended: (a).*

3. **Can a whole sheet be pinned to a date, or is the vault scrubber enough?**
   The shipped time scrubber already browses the entire vault at any past
   snapshot (`src/components/TimeTravelBar.tsx`), so a per-sheet date pin would be
   a third way to address the past. Options: **(a) no per-sheet pin — `AT()` for
   values, the scrubber for browsing, and later teach the scrubber to jump to a
   typed date**; (b) a per-sheet "as of" control. *Recommended: (a).*

4. **What do the functions get called?** They will be typed by hand into formula
   fences, so the words matter. Options: **(a) `AT("2026-03-01", Holdings.total)`
   and `PROP("Health/Weight.md", "weight")`**; (b) `ASOF(…)` / `WAS(…)`;
   (c) something in your own words. *Recommended: (a) — short, and `AT` reads as
   English in the position it occupies.*

5. **Money converted in the past — today's exchange rate, or refuse?** Substrate
   stores no historical FX rates, so a past portfolio total in EUR can only be
   converted at today's rate. Options: **(a) convert at today's rate, with the
   sheet's existing `USD→EUR …` stamp making it visible**; (b) error out rather
   than mix a past number with a present rate; (c) return the past value in its
   own currency, unconverted. *Recommended: (a).*

6. **How does a key's history get onto a chart?** Options: **(a) a new
   `history: Health/Weight.md#weight` line inside the existing ` ```chart `
   fence**, reusing the `day|week|month` bucketing the fence already speaks
   (`docs/dashboards.md:151`); (b) materialise the history into a sheet first and
   chart the sheet like any other rows. *Recommended: (a) — (b) means every chart
   needs a maintained side-sheet.*

---

## 1. Where this sits — one engine, three surfaces

The three history features address the past three different ways. Naming which
belongs to which is half this spec's job.

| | Addresses by | Returns | State |
|---|---|---|---|
| **Time scrubber** | snapshot *position* | the whole vault, projected | **shipped** |
| **Receipts** | one fact | all its changes, with actors | **shipped** |
| **Time-travel queries** | one fact + a *date* | one value (or a date-series) | this spec |


**The scrubber is done** and is in the tree. Its bar drives an
`<input type="range">` over the snapshot **index**, not over dates
(`src/components/TimeTravelBar.tsx:77-86`), and renders a commit-precise instant
with `Intl.DateTimeFormat` down to the minute (`TimeTravelBar.tsx:17-24`). Behind
it, `build_vault_snapshot` (`src-tauri/src/commands/history.rs:95-163`) reads one
commit's whole tree and rebuilds notes, frontmatter, schema and views from *that*
tree. So the scrubber already answers "show me everything as it was at snapshot
N". It does not answer "what was this number on 1 March", and it is not a data
source — nothing computes on top of it.

That is the line: **the scrubber browses commits by position; time-travel queries
address values by date.** Same underlying history, different addressing,
different output. This spec adds no browse surface and changes nothing the
scrubber shipped.

**The receipts spec owns the engine both it and this feature read.** Its §7 defines
`fact_history(path, key) → [(commit, ts, prior, value, actor)]` — a fact's
ordered *lane* — and states that value-at-date is a binary search on a lane. This
spec consumes that interface and ignores the `actor` column. It does not define a
second parser, a second cache, or a second invalidation rule.

Design mandate this feature answers: **show history, not just status** — where a
value came from is part of the value. Constraint it must respect: speed — instant
search, keyboard-first everything, no loading states worth naming — which is why
§4 exists at all.

---

## 2. Semantics — what "value at date" means

### 2.1 The rule

> **`AT(D, …)` is the value in the newest snapshot whose commit time is at or
> before the last instant of local day `D`.**

"Value at close of business on D." Three consequences, all deliberate:

- **Multiple snapshots on one day → the last one wins.** A day is a bucket, and
  the bucket reports its closing value, not its opening or its average.
- **A date with no snapshot of its own is not empty.** The rule reaches backwards
  through quiet days to the last snapshot that exists, which is what "the value
  on that date" means for a value that simply didn't change.
- **A future date returns the present value**, since no snapshot is newer. (An
  `AT()` with a future date is more likely a typo than an intent; slice 1 returns
  the present value and does not warn. **Open to revisit**, not filed as a
  product-shape question.)

### 2.2 Timezone honesty

Git stores commit time as **UTC epoch seconds**. Both engines multiply it into
`ts_ms` unchanged: desktop parses `%ct` from `git log --format=%H%x1f%ct%x1f%s`
and does `.saturating_mul(1000)` (`src-tauri/src/history.rs:182-193`); mobile
reads `commit.time().seconds()` (`src-tauri/src/githist.rs:334` in
`history_points`, `:215` in `history_list`).

The sheets language, by contrast, is entirely **local-calendar**: dates are ISO
day strings and all arithmetic runs on y/m/d components precisely to avoid
UTC-midnight drift (`docs/sheets-spec.md:237-241`, `src/lib/dates.ts:44-66`).

`AT()` reconciles them in one place: the end of local day `D` is computed as
`new Date(y, m - 1, d + 1).getTime() - 1` — the same construction
`msUntilNextMidnight` uses (`src/lib/dates.ts:38-41`), which the Date constructor
normalises across month, year and DST boundaries — and compared against the
commit's `ts_ms`. Stated plainly for the spec's readers:

- **Stored** in UTC, **queried** in the reading machine's local zone.
- A vault edited in Berlin and read in New York will resolve a different snapshot
  for edits made near local midnight. This is not fixable without recording the
  writer's zone per commit, which git does carry (`%cI` offset) but neither
  engine currently reads (`history.rs:182`, `githist.rs:215` — both take epoch
  seconds only — **assumption**: git's own `%cI` carries the writer's offset,
  but nothing in this repo reads it). Slice 1 uses the reader's zone and says so.

### 2.3 Boundaries

| Situation | Answer |
|---|---|
| The note exists today, but not yet at `D` | **blank** — a genuine "did not exist yet", and blanks are already the language's skip value for aggregates (`docs/sheets-spec.md`) |
| The key didn't exist yet on an existing note | **blank**, same reasoning |
| The note path is unknown *today* | **error**, naming the path — a typo must not read as "not yet" |
| The value is non-numeric | returned **as-is**, as text. `AT()` is value-typed, not number-typed; arithmetic over it errors exactly like arithmetic over any other text cell |
| `D` is before the oldest surviving snapshot | **unknowable — open question 1.** Recommended: a visible `no history before <date>` message |
| `D` falls inside a purged or trimmed range | **unknowable**, same treatment — see below |

**The trim trap, stated explicitly.** `trim_before` (`history.rs:618-657`) drops
old snapshots entirely. After a trim, the oldest surviving snapshot holds
whatever the vault looked like at the trim boundary — so a naive "last snapshot
at or before D" would happily return that value for a date years earlier, and
report a 2026 number as if it were a 2024 one. **Any date strictly before the
oldest surviving snapshot is unknowable and must be reported as such, never
answered.** This is a correctness requirement, not a nicety.

### 2.4 The merge blind spot

Both engines simplify path history through the first TREESAME parent and do not
render the merge itself (`githist.rs:191-208`, whose comment states it: *"A merge
resolution that differs from every parent is omitted by `--follow`, but both
histories remain live"*). A test pins the behaviour: a `vault sync merge` commit
is asserted absent from a file's history (`githist.rs:1132-1138`).

For a phone-synced vault this means **a value that only ever existed on the
remote side of a merge can be invisible to `AT()`**, and a value introduced *by*
a conflict resolution may be dated to the next ordinary snapshot rather than to
the merge. Not fixable inside path history; a lane builder would have to walk all
parents and diff trees. Slice 1 inherits the blind spot from the shipped engines
and documents it.

---

## 3. Surface

### 3.1 The engine constraint that shapes everything

`src/lib/formula.ts` is **entirely synchronous** — `evaluate(e, scope, fx, today)`
(`formula.ts:873-878`) and every helper below it; there is no `async`/`await`
anywhere in the file. A formula function therefore **cannot** do IPC inline.

The shipped answer to exactly this problem is the FX pattern, and time travel
copies it move for move:

1. **Static scan** — `sheetUsesFx(model)` asks whether any formula calls `FX`
   (`src/lib/sheet.ts:744-746`, built on `callsFunction`, `formula.ts:126`).
2. **Gated async prefetch** — `ensureFxRates()` runs only when the scan says yes
   (`src/components/NotePane.tsx:828`, with the comment *"Ordinary notes keep this
   disabled, so opening prose cannot phone out"*).
3. **Synchronous resolver injected** — `makeFxResolver(rates)` produces a
   `FxResolver = (from, to) => number | null` (`formula.ts:24`) handed to
   `evaluate` (`NotePane.tsx:270-276`, `src/components/SheetGrid.tsx:92,116`).

Time travel adds a `HistoryResolver` alongside `fx`, on the same seam. The
`today` parameter already threaded through `evaluate`/`evaluateSheet`
(`formula.ts:876`, `sheet.ts:411-421`) is the precedent for injecting an as-of
clock, and `TODAY()`'s volatility rule (`formula.ts:990-997`) is the precedent
for how a date-dependent function behaves across re-evaluations.

**The static-scan requirement bites, and the spec is honest about it.** The
prefetch must know *what* to fetch before evaluation begins, so a new
`collectHistoryRefs(expr)` scanner — modelled on `collectCrossRefs`
(`formula.ts:166`) — collects `(path, key, date)` triples from the parsed
expression. Therefore:

> **`AT()`'s date and address arguments must be statically resolvable**: literals,
> or date arithmetic over literals and `TODAY()`. `AT(bought, Holdings.total)` —
> a *per-row* date column — is **not** supported in slice 1; it would need a
> two-phase evaluate (evaluate dates → prefetch → evaluate values) the engine
> does not have. §7 lists it as a later slice.

### 3.2 Functions

Two, both registered in `SCALAR_FNS` (`formula.ts:68`) — neither is an aggregate,
neither reads row scope.

**`PROP(path, key)`** — a frontmatter key on another note, as a scalar. The key
binds case-folded, exact spelling first — the same identity rule as every live
prop read, applied per historical blob, so a key whose casing changed
mid-history stays one continuous fact rather than reading as a deletion. Present
value by default; the as-of value when it appears inside `AT()`. This is the
addressing the pitch's "weight curve from a frontmatter key" requires, and the
language has none today: sheets read CSV fences, dashboards bind `{{Sheet.member}}`
(`docs/sheets-spec.md:303-306`). `PROP` is useful on its own, which is the
argument for shipping it rather than inventing an `AT`-only address form.

```
weight_now   = PROP("Health/Weight.md", "weight")
weight_march = AT("2026-03-01", PROP("Health/Weight.md", "weight"))
```

**`AT(date, expr)`** — evaluates `expr` with the as-of date bound. `expr` must be
*history-addressable*: a `PROP()` call, a cross-sheet member ref
(`Holdings.total`, the existing v2 grammar, `docs/sheets-spec.md:215`), or
arithmetic composing those.

```
q1_growth = (AT("2026-03-31", Holdings.total) - AT("2026-01-01", Holdings.total))
            / AT("2026-01-01", Holdings.total)
```

`AT(date, Sheet.member)` **re-evaluates the historical sheet**: that commit's CSV
fence, run through that commit's formula fence (open question 2 — recommended
default). This deliberately sidesteps the sheet-cell identity problem the
receipts spec's §8 names, since nothing is addressed positionally — a reordered or re-sorted sheet
still totals correctly at every past date. Summaries and computed columns are
recomputed, never read from a cache of stored numbers.

Cross-sheet resolution in the historical case runs against the historical tree
too, matching `build_vault_snapshot`'s stated principle that an old projection
renders against its old config (`commands/history.rs:71-73`).

### 3.3 Charts — a key's past as a series

A date-series is row-shaped, which is exactly the shape a *computed column* may
not be: a computed column must match the CSV's row count, and a key's history has
a length of its own. So **`HISTORY()` is not a formula function.** It is a chart
source (open question 6 — recommended default):

````markdown
```chart
history: Health/Weight.md#weight
x: day
y: last
kind: line
title: Weight
```
````

- `history:` names a fact — `<note path>#<frontmatter key>`, or
  `{{Sheet}}#<member>` for a summary's past.
- `x:` reuses the fence's existing date bucketing vocabulary, `day|week|month`
  (`docs/dashboards.md:151`).
- `y:` picks the bucket's reducer: `last` (default — matches §2.1's closing-value
  rule), `avg`, `min`, `max`.
- `history:` is **exclusive with both `source:`+`x`/`y` and `series:`**, extending
  the rule the fence already enforces: *"`series` replaces `x`/`y` rather than
  joining them: a fence carrying both is a parse error"* (`docs/dashboards.md:202-203`).
- Points before the oldest surviving snapshot are **omitted, and the chart says
  so** in place rather than drawing a flat line back to the beginning of time —
  the charting half of open question 1.

Multiple keys on one chart (`history: A.md#weight, B.md#weight`) fits the
existing categorical ramp, which is bounded at five series
(`--series-1..5`, `docs/dashboards.md`). Slice 1 supports a single fact per fence;
multi-fact is a later slice.

### 3.4 What this spec does *not* add to the surface

- No new panel, no timeline, no scrubber change. The scrubber shipped the browse
  surface and is untouched.
- No "pin this sheet to a date" control (open question 3, recommended default).
- No inline-prose form. `AT()` inside the separately-designed inline prose
  expressions falls out for free once both ship, but is not a slice-1 target (§7).

---

## 4. Performance — the lane cache

Walking git per query violates the speed credo outright, so queries read a
derived index. **The design is the receipts spec's §5 Option B, inherited
verbatim, not re-argued** — the two features must not build two engines.

### 4.1 Storage

- **SQLite, in the app data dir, keyed by vault — never inside the vault.** The
  snapshot path runs `git add -A .` (`history.rs:276`), so anything inside the
  vault would be committed and would churn sync forever. `app_data_dir` is the
  established location (`src-tauri/src/lib.rs:464`).
- **This would be the app's first persisted SQLite store.** `rusqlite` is already
  a dependency (`src-tauri/Cargo.toml:40`), but its only current use is the search
  index, which is `Connection::open_in_memory()` and rebuilt at boot
  (`src-tauri/src/vault/mod.rs:1020`). An on-disk store brings schema migrations,
  corruption handling and a delete-and-rebuild path that the in-memory index never
  needed — an honest new cost, and the reason §7 keeps it out of slice 1.
- **The cache is derived and disposable.** Deleting it costs a rebuild and
  nothing else. No commit id is persisted anywhere durable outside it.

### 4.2 Lazily per key, bounded-walk first

Per the receipts spec's §5: first read of a cold key serves the newest N changes
from a bounded newest-first walk synchronously (recent commits are cheap), while the
full lane materialises in the background. A query for a *recent* date is
therefore fast even on a cold cache; a query deep into a long history may
visibly build, once per key per machine.

### 4.3 Invalidation, and why purge stays real

Purge and trim both funnel through `replay` → `finish_rewrite`
(`history.rs:576-601`, `618-657`, `506-527`), which mixed-resets to the new tip,
writes the rewrite marker (`history.rs:522` → `gitsync::mark_history_rewritten`,
`gitsync.rs:449-452`), deletes every sync-owned ref, and prunes. **Every commit id
changes.** `purge_removes_content_from_disk_forever` (`history.rs:805`) and
`purge_drops_sync_refs_so_the_old_graph_is_pruned` (`history.rs:830`) pin it.

So the invalidation rule is:

- **Head moved, old head still an ancestor** → append the new commits to affected
  lanes.
- **Head unknown, or the cached head is no longer an ancestor** → **drop the whole
  cache** and rebuild lazily.

**Purged history vanishes from query results by construction**, because nothing
in the cache survives a rewrite. That is the hard requirement met — purge is not
a lie.

**One correction to the obvious implementation, worth stating.** The rewrite
marker `.git/substrate-sync-rewritten` is *cleared* on the next successful push
(`gitsync.rs:645`, `clear_history_rewritten`, `gitsync.rs:460-467`), so a cache
that watched only the marker could miss a rewrite that was pushed before the next
query. **The primary signal must be the ancestry check on the cached head**
(marker as corroboration only). A cache keyed on a vanished commit id is a cache
serving purged data.

### 4.4 Cost of building a lane

A lane is built from the file's commit list plus its content at each of those
commits:

- **Commit list** — one process: `git log --follow --numstat --format=…`
  (`history.rs:309-330`) on desktop; one libgit2 revwalk with
  `Sort::TOPOLOGICAL | Sort::TIME` (`githist.rs:153,165`) on mobile.
- **Content per commit** — this is where a naive build dies. `history.rs:203-208`
  already records the lesson for the whole-tree case: it routes `snapshot_files`
  through libgit2 on **both** platforms because that *"does this in one repository
  walk on desktop and mobile, avoiding one `git show` process per note for a large
  vault."* The lane builder inherits the rule: **one batched read, never one
  `git show` per commit** (`git cat-file --batch` fed by the commit list on
  desktop; the existing revwalk on mobile).

Order of magnitude for a note edited most days for three years: ~1000 commits
touching it, each needing a frontmatter parse. Batched, that is one process and
~1000 small blob reads — hundreds of milliseconds, not minutes; but it is not
instant, which is precisely why it happens once and lands in the cache. **This
estimate is an assumption** — it has not been measured against a real years-old
vault, and measuring it is the first thing the build slice should do.

One thing that is *not* a cost here: repacking. "A Substrate vault is never
packed" is a product contract (`docs/vault-format.md:2735`, `maintenance.auto` and
`gc.auto` pinned off at `history.rs:134-135`), so lane reads hit loose objects
throughout.

---

## 5. Key tracking — follow the key, not the line

### 5.1 The rule (inherited from the receipts spec §2)

Values are derived by **parsing the frontmatter at each commit and diffing by
key** — never line-based blame. YAML key reordering is therefore invisible to the
lane, by construction.

### 5.2 Renames and moves are followed

- **Desktop**: `git log --follow` with a `:(literal)` pathspec
  (`history.rs:309-330`, `--follow` at `:319`), which also keeps literal `->` in a
  filename from being parsed as a rename arrow — pinned by
  `list_keeps_literal_arrow_names_straight` (`history.rs:780`) and
  `list_follows_renames` (`history.rs:762`).
- **Mobile**: libgit2 rename/copy detection per commit before falling back to a
  literal diff — `path_delta` (`githist.rs:99-120`), whose doc states it
  *"preserv[es] `git log --follow` behavior"*, inside the same revwalk.

Both engines are already required to agree: a shipped test asserts the mobile
point list equals the desktop one (`commands/history.rs:620-624`, *"the
mobile/libgit2 scrubber order matches desktop git"*). Lanes sit above that line,
so phone parity comes free.

### 5.3 What is *not* followed — the honest gap

**A renamed key breaks its lane in two.** `vault_rename_prop` sweeps a key across
the vault (the receipts spec §4 lists it under `actor: bulk`), and nothing in the frontmatter
diff can tell "`weight_kg` disappeared and `weight` appeared in the same commit"
from two unrelated edits. So `AT("2025-06-01", PROP(note, "weight"))` is blank if
the key was called `weight_kg` back then.

Slice 1 does not solve this; it reports blank (which §2.3 already defines as "did
not exist yet"). The stitch exists in principle — the bulk sweep could record the
old→new key pair as a claim, and the lane builder could follow it — but it
depends on receipts' write-time claims shipping first, and it is listed as a later
slice rather than assumed.

### 5.4 Where this design would diverge from the receipts spec — named, not hidden

Two points, both raised here rather than silently contradicted:

1. **Sheet-cell addressing.** The receipts spec's §1 addresses a sheet fact
   positionally — `(path, fence index, row, col)` — and §8 concedes the cost:
   *"a reordered sheet can mis-thread a cell's past."* This spec **does not query
   cells at all**. It queries *summaries*, recomputed from the historical fences
   (§3.2), which is immune to row reordering. Not a contradiction — a narrower
   address that avoids the weakness — but the shared engine must expose both, and
   the summary path is an addition to `fact_history`'s frontmatter-key and cell
   forms rather than a replacement for either. **An implementation question for
   the build round, not a product-shape one.**

2. **What the resolver returns for an unknowable date.** The receipts popover
   shows what it has and stops; a query must distinguish "unchanged since before
   the trim" from "genuinely cannot say" (§2.3, the trim trap). So the shared
   `fact_history` interface needs the **oldest surviving snapshot's timestamp** in
   its return, which the receipts spec's §7 tuple does not currently carry. This
   is an additive interface request against that spec, not a divergence in
   behaviour.

---

## 6. Honest costs

- **Time resolution is the batch window, and nothing else.** Auto-snapshots batch
  a stretch of editing into one commit: `SNAP_QUIET` 120s of quiet **or**
  `SNAP_MAX_DIRTY` 600s of continuous dirt, polled every `SNAP_TICK` 15s
  (`src-tauri/src/lib.rs:91-93`, fired by `take_if_due`, `:105-114`), then one
  `git add -A .` and one commit for the **whole vault** (`history.rs:271-282`).
  The vault format states it as the public contract
  (`docs/vault-format.md:2691-2694`). Consequences, all of them real:
  - A value that lived only *inside* one quiet window was never committed and
    **cannot be queried** — it does not exist to git, so `AT()` does not show it.
    Nothing sharpens this; it is the storage layer's grain.
  - A commit is vault-wide, so a note's snapshot timestamp reflects when the
    *vault* went quiet, not when that note was edited. Intra-day ordering between
    two notes changed in the same window is unavailable.
  - Sub-daily queries are therefore not offered. `AT()` takes a **date**, not a
    datetime, and the closing-value rule (§2.1) is the honest granularity.
- **The index is real machinery**: a first persisted SQLite store, its migrations,
  its ancestry-check invalidation, its full-drop-on-rewrite path (§4).
- **Cold deep history is not instant.** Recent dates are fast on a cold cache;
  the first deep query on a long-lived note may visibly build (§4.2, §4.4).
- **Purge and trim make the past unknowable, correctly.** Recomputation buys
  correctness; there is no way to keep queries fast *and* let purged values
  survive, and the latter would make purge a lie.
- **Merge-only values can be invisible** on synced vaults (§2.4).
- **A renamed key splits its own history** (§5.3).
- **Past money converts at today's rate** — no historical FX store exists
  (open question 5).
- **Timezone is the reader's**, not the writer's (§2.2).
- **Per-row date columns are out of reach** without a two-phase evaluate (§3.1).
- **`AT()` over a sheet re-runs that sheet's formulas**, so a renamed summary
  makes old dates error rather than silently resolving to today's line (open
  question 2's cost, accepted deliberately).

---

## 7. Non-goals for slice 1, and the first buildable cut

### 7.1 Explicitly not this

- **The scrubber UI** — already shipped. Untouched here.
- **The receipts popover** — designed separately. This spec consumes its lane
  engine and ignores its actors.
- **Inline prose expressions** — designed separately. `AT()` inside an inline
  expression falls out for free once both land; it needs no design here.
- **Forecasts / projections** — a later, niche extension at most. Nothing
  forward-looking is in scope; a history series is not a forecast, and slice 1
  ships no extrapolation of any kind.
- **Sub-daily queries**, per §6.
- **Historical FX rates**, per open question 5.
- **Per-row `AT(date_column, …)`**, per §3.1.
- **Multi-fact history charts**, per §3.3.
- **Key-rename lane stitching**, per §5.3.

### 7.2 First buildable slice

Cut for the smallest thing that answers a real question end to end, with the
expensive machinery deferred one step:

1. **Lane engine (Rust, shared with the receipts engine).** `fact_history(path, key)` over
   `history_list` plus one *batched* content read, and `value_at(path, key,
   instant)` as a binary search on it. Plus the oldest-surviving-snapshot
   timestamp (§5.4.2). No persistence yet — an **in-memory** per-session cache,
   matching the existing search index's shape (`vault/mod.rs:1020`). This keeps
   slice 1 clear of SQLite migrations while proving the walk cost against a real
   vault (§4.4).
2. **`PROP(path, key)`** in the formula language, present-tense only. Independently
   useful, and it establishes the address form.
3. **`AT(date, expr)`** with static ref collection and the prefetch→resolver seam
   (§3.1), covering `PROP()` and cross-sheet members.
4. **Chart `history:` source**, single fact, `day|week|month` × `last|avg|min|max`.

Then, as slice 2: the persisted SQLite lane cache with the ancestry-check
invalidation (§4.1, §4.3) — at which point receipts and queries share one cache,
and the cold-start cost is paid once per machine instead of once per session.

Measurement gate before slice 2: **build a lane on a real multi-year vault and
time it.** If the in-memory build is fast enough on a real multi-year vault, the
persisted store may not be worth its migration surface at all — and the honest
version of this spec says that out loud rather than pre-committing to a database.
