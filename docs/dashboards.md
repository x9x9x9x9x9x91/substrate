# Dashboards — a guide

A dashboard is just a note: `type: dashboard` plus a `dashboard:` prop naming the
renderer. The note's frontmatter and fenced blocks are the config and the data —
everything is plain text, so a dashboard is created by writing a file (or making a
note in-app and adding the props). This guide shows each kind with a complete
copy-paste example; the exact on-disk contract lives in
[vault-format.md §5](vault-format.md).

A ready-made vault with working instances of everything below is in
[`examples/vault/`](../examples/vault/Welcome.md) — copy it somewhere and point the
app at it:

```sh
cp -r examples/vault ~/SubstrateDemo
VAULT_DIR=~/SubstrateDemo npm run tauri dev
```

(Copy first — the app initializes version history and support folders inside the
vault it opens, which you don't want inside this repo.)

## The portable kinds

These read only the vault. They work anywhere.

`metrics`, `charts` and `hub` also leave the app: the head's **Print** action
prints the live pane as designed — a workbook's *active* page, not
every page — through the same `@media print` surface notes use (Save as PDF
lives in the dialog). The machine-specific kinds stay screen-only.


### `metrics` — stat cards over a sheet

Cards bind to named summaries on a [sheet](sheets-spec.md). Two notes: the sheet
holds data + formulas, the dashboard holds the cards.

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
total  = SUM(value_usd)
crypto = SUMIF(bucket, "crypto", value_usd)
```
````

```markdown
---
type: dashboard
dashboard: metrics
cards:
  - label: Total value
    bind: "{{Holdings.total}}"
    format: usd
    emph: true
  - label: Crypto
    bind: "{{Holdings.crypto}}"
    format: usd
---
```

`format`: `eur` | `usd` | `number` | `pct`; optional `digits` (0–8; in
frontmatter more is clamped to 8, while the ` ```cards ` fence and a ` ```tile `
card line say so as an error). A bind must name a **summary** (an aggregate line), not a
column. `emph: true` marks a card as one
of the board's anchors — at most two stay sharp, everything else sinks to the
quiet voice (design principle 11). `FX("USD","EUR")` in formulas uses a
live rate cached on the sheet's own `fx_rate`/`fx_date` props.
`accent: teal` tints a card — see **Style tokens** below.

A bind can also name a [mount](vault-format.md#8-vaultmountsjson--mounted-folders-reality-mounts) instead of a sheet, and read the
mounted folder's live index: `{{Ableton projects.count}}` for how many project
files there are, `{{Ableton projects.newest}}` for the last one you touched.
The aggregates are `count`, `present`, `missing`, `bytes`, `newest`, `oldest`.
Since a folder is only mounted on the machine it lives on, a card over a mount
that isn't bound here keeps showing the last-known number and says why
underneath rather than blanking the board.

#### iOS home-screen widgets

On iOS 17+, the **Dashboard card** WidgetKit extension offers every card from
every `dashboard: metrics` note as a configurable small or medium home-screen
widget. The widget gallery's picker lists cards by name only; a card's rendered
value is exported to the App Group **only while a widget on the home screen is
configured for it**. With no widgets placed, nothing but names ever leaves the
app. For allow-listed cards the app evaluates the same sheet/formula/card code
used by the dashboard renderer and atomically writes the rendered value and
snapshot time whenever the vault index changes — including after a sync pull.
The extension never opens the vault or runs the sheet engine.

A widget remembers its card by dashboard path and position, so inserting or
reordering cards in a dashboard's frontmatter re-points widgets placed on the
cards after the edit — re-pick the card after restructuring a board. Sealed
notes are never offered to widgets, locked or unlocked.

That boundary is intentional: a widget is always last-synced data and prints a
quiet `as of HH:MM` stamp. Tapping it deep-links to the source dashboard
through the ordinary `substrate://note/…` route. The first slice covers metric
cards only: no charts, editing, or background sync from WidgetKit. A widget
added moments ago says "Open Substrate to load" until the app next runs and
notices its configuration — open the app once after adding or changing a card
so the shared snapshot refreshes.

### `charts` — bar/line charts over a database or sheet

One ` ```chart ` fence per chart; the body can hold several. `source` is a database
type or `{{Sheet Name}}`.

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
y: sum:value_usd
kind: bar
```
````

`x` is a prop, or `prop:day|week|month` for date bucketing; `y` is `count`,
`sum:<prop>`, or `avg:<prop>`. A malformed fence renders its parse error in place
and never breaks the others. `size: tall` gives one chart more room — see
**Style tokens** below.

`title` is not a caption above the chart — it *is* the chart's section label,
set in the same voice and carrying the same hairline tail as any other section
on the board. So a chart fence sitting under a markdown heading needs a title
that says something the heading doesn't: `## Money` over `title: Holdings by
bucket` reads as a section and its chart, while `## Holdings by bucket` over
the same title prints the noun twice.

**Charting a mounted folder.** A mount is a database, so `source` can name one
and the chart plots the folder's live index — one row per file, with `name`,
`extension`, `size`, `created`, `modified`, plus anything its sidecar notes
annotate. Point a mount at your Ableton projects folder and this is the whole
setup for "projects touched per month" — no import step, no stub notes:

````markdown
```chart
source: Ableton projects
x: modified:month
y: count
title: Projects touched per month
```
````

`by:` splits it like any other chart (`by: stage` over a sidecar prop). Since a
folder is only mounted where it lives, a chart over a mount that isn't bound on
this machine — or whose folder is away — plots the last-known index and says so
in a quiet line under the title.

Hovering or focusing a bar or a point shows the exact value, the x label, and —
on a split chart — every series at that x. Each chart is one tab stop: arrow
keys, Home and End walk the axis. Tooltips are a pointer affordance and never
print.

**Splitting into series (`by`).** `by: <prop|column>` pivots the measure into
one series per distinct value of that field — a stacked bar or a multi-line
chart, with a legend above the plot:

````markdown
```chart
source: {{Spending}}
x: month
y: sum:amount
by: category
kind: bar
title: Spending per month, by category
```
````

Bands keep first-seen order and first-seen casing, folding case to group. A row
whose `by` field is blank is skipped, not collected into an invented series.
`by` and `series` both name the series axis, so a fence with both is a parse
error; a `by` field that exists nowhere in the source is named in the chart's
error like any other binding.

The current neutral token ramp distinguishes two series. A split resolving to
three or more renders an in-place message instead of repeating an ambiguous
gray. Stacked bars
accept non-negative `sum`/`count` measures; use a line chart for averages or
negative split values. On a split bar the series encoding replaces any schema
hue that the x-axis options would otherwise supply.

**Plotting a sheet's summaries (`series`).** `x`/`y` plot *rows*, so a set of
bucket totals that only exists in the summary bar would need bucket rows
materialized in the sheet to chart. `series` binds those named summaries
directly — one bar per name, in fence order:

````markdown
```chart
source: {{Holdings}}
series: etf, crypto, cash
kind: bar
title: Buckets
```
````

`series` replaces `x`/`y` rather than joining them: a fence carrying both is a
parse error, as is `series` on a database source (summaries are a sheet thing).
Names match case-insensitively and the summary bar's own casing labels the bar.
A name that isn't a summary on that sheet — a row column, a typo, a summary
that errored or isn't a number — fails the whole chart with a message naming
it, rather than quietly dropping the bar; a chart whose points are named by
hand should never lie about a missing one.

**Plotting a fact's own past (`history`).** `x`/`y` plot rows and `series` plots
summaries; both read the vault *as it is now*. `history` plots one frontmatter
fact's history instead — the chart half of time-travel queries (§3.3 of the
time-travel query spec):

````markdown
```chart
history: Assets/BTC.md#price
x: month
y: last
kind: line
title: BTC through the year
```
````

`history` names one `<note path>#<frontmatter key>` — the last `#` splits, so a
path may contain one. `x` buckets by `day` (default), `week` or `month`; `y`
reduces each bucket by `last` (default), `avg`, `min` or `max`. `last` is the
value standing at the bucket's close, the same rule `AT()` uses, so a monthly
point and an `AT(<that month's last day>, PROP(…))` cell can never disagree.
`avg`, `min` and `max` also fold in the value carried *into* the bucket, so a
fact that didn't change in March still has a March average.

`history` replaces `source` + `x`/`y` and `series` rather than joining them: a
fence carrying either alongside is a parse error naming the key to drop, as is
`by` (there are no rows to split). One fact per fence — chart two by writing two
fences.

Values from before the vault's oldest surviving snapshot are unknowable, not
zero. The chart omits those buckets and says `no history before <day>` beside
the plot rather than drawing a flat line back to the beginning of time. A vault
with no version history at all says so instead of rendering an empty frame, a
key that was never recorded says *that* rather than blaming the trim boundary,
and a value that isn't a number is counted in the footer's skipped tally rather
than plotted as 0.

A long fact is plotted from the **recent** end: at most 400 buckets, the last
of them today, with `· showing from <label>` in the footer when older buckets
were left off — and labels carry the year once the window spans more than one.

The note path is resolved against the vault as it stands now, so a `history`
fence follows a renamed note but cannot plot one that has been deleted; and
this slice takes a note path only — a sheet summary's past (`{{Sheet}}#member`)
is not a chart address yet, so plot it by reading it into a fact or charting
the sheet in the present tense.

### `heatmap` — a year of days over a database or sheet

One ` ```heatmap ` fence per grid; the body can hold several. A heatmap asks one
question — how much, per day, across a year — so it takes no `kind`, no `title`
and no axis, and it picks its own year: the latest one the data reaches.

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

`source` is a database type or `{{Sheet Name}}`, exactly as a chart's is.
`date` is the date prop/column the squares sit on (a time suffix is ignored, so
`2026-07-17 10:28` lands on its day). `value` is `count` or `sum:<prop>` — no
`avg`, which answers a different question than an intensity grid asks. `query`
is the filter bar's own query language and is database-only; on a sheet it is a
named error, not a silent no-op.

Intensity quarters the shown year's heaviest day into four steps of the same
quiet greyscale the charts use — nothing here is color-coded. Every day of the
year is a square, and the grid is a **single tab stop**: arrows walk it (up/down
a day, left/right a week), Home/End jump to the year's ends, and a live readout
under the grid says what the cursor is on. A source spanning several years puts
a year switch above it.

A note whose fences are heatmaps opens as a heatmap dashboard; a note carrying
charts too leads with the charts and hangs the heatmaps under them — the same
either way, whether the note names `dashboard: charts` or names no kind at all
and is read by body content. A malformed fence renders its parse error in place
and never breaks the others.

### Progress fences — goal thermometers

One ` ```progress ` fence per goal; the body can hold several. `label` is
optional (otherwise derived from `value`). `value` is either
a `{{Sheet.summary}}` bind — resolved by the metrics dashboard's own loader, so
a summary reads identically on a card and on a bar — or the literal `count` over
a `source` database with an optional `query` in the ` ```view ` grammar, which
reports the total that query matches. `target` is a positive number or a bind,
and `format`/`digits` are the metrics card's formats.
`accent: <name>` tints the goal's label and not its bar — see **Style tokens**
below.

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

**The pace line only claims what the vault can back.** Nothing on disk records
what a summary or a row count was yesterday, so "ahead of schedule" needs the
fence to say where the line starts. With `start:` — the day the value stood at
zero — a straight line runs from 0 to `target` on the deadline and the fence
reports the distance from it ("behind by 13.000 € · 44 days left"). Without it,
a `deadline` still gives days left and the per-day rate required from here, and
the fence makes no ahead/behind claim at all. `start` without a `deadline`, or
on/after it, is a parse error; so are an unknown key, a `value` that is neither
`count` nor a bind, `count` without a `source`, `source`/`query` on a bound
value, a non-positive `target` and a malformed date. Each errors where it sits
and never breaks its siblings.

The bar clamps at 100 %; the percent text does not, so overshooting a target
says so. Hub bodies host the same fence with the same parser and renderer.

### `calendar` fences — a month grid over any date property

One ` ```calendar ` fence per grid; the body can hold several, and a body that
carries them needs no `dashboard:` key. `source` is a database type or
`{{Sheet Name}}`, `date` names the date property (or sheet column) the entries
sit on.

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

Optional `label` picks the property each chip reads instead of the note title;
optional `query` is the database filter-bar language (a `query` on a sheet
source is a parse error — a sheet has no filter bar). Each fence keeps its own
month cursor, so paging one calendar leaves the others where they were, and a
malformed fence renders its parse error in place without touching its siblings.

Clicking an entry opens its note. **Repeating notes expand in the grid**:
`repeat` / `repeat_until` / `repeat_skip` are read by the same engine the
Calendar pane uses, so a weekly note fills the month it is viewed in without
anything being written to disk. A `{{Sheet}}` source has no notes and so no
recurrence — one row, one day, and every chip opens the sheet.

A tailed opener (` ```calendar month `) is not a fence anywhere: the parser
reads the bare form only, so it renders as a code box and stays searchable
prose.

### `hub` — a designed home page

The body stays ordinary markdown; the renderer lays it out. `## ` headings become
section labels, a run of consecutive callouts (no blank lines between them)
becomes a side-by-side card row, and ` ```view `, ` ```chart `, ` ```cards `,
` ```progress ` and ` ```calendar ` fences render live between them: a `view`
embeds a database table, a `chart` plots exactly as it does on a charts
dashboard, `cards` shows the metrics dashboard's stat-card row, `progress`
draws a goal thermometer, and `calendar` draws the month grid described above.
A ` ```heatmap ` fence draws its year of days there too, exactly as it does on a
heatmap dashboard, and a ` ```timeline ` fence draws database items with a
start/end arc on a horizontal date axis.
Prose, headings, callout rows and fences render in the order they were written,
interleaved however you like — a hub is a canvas, not a fixed slot layout.

````markdown
---
type: dashboard
dashboard: hub
---

Label home — the week at a glance.

## Now

> [!note] Studio
> Mixdown pass on [[Vessel]] this week.
> [!warn] Deadline
> Master delivery due Friday.
> [!idea] Later
> Try the granular chain on the outro.

## Money

```cards
- label: Total value
  bind: "{{Holdings.total}}"
  format: eur
  emph: true
- label: Crypto
  bind: "{{Holdings.crypto}}"
  format: eur
- label: Positions
  bind: "{{Holdings.positions}}"
  format: number
```

```chart
source: {{Holdings}}
x: bucket
y: sum:value_eur
kind: bar
title: Holdings by bucket
```

## Releases in flight

```view
type: release
query: status:mastering
view: table
sort: released:desc
limit: 5
columns: status, artist
```

```heatmap
source: release
date: released
value: count
```

```timeline
source: release
start: started
end: delivery
label: title
group: stage
query: status:mastering
```
````

A fence's `sort:`, `limit:` and `columns:` keys are all optional.
`sort: <prop>` / `<prop>:desc` orders by the database table's own rules
(declared select order, numeric numbers, chronological dates); `limit: N` cuts
AFTER the query and the sort, so the pair above means "the five newest"; and
`columns:` picks and orders the columns explicitly, matched case-insensitively.
When rows are cut the table says so honestly — "5 of 23 rows — this view's
limit" for your own `limit:`, "open the database for the rest" when the
surface's safety cap is what clipped it. An unknown key or a malformed value
renders a quiet error card in place of that one table, never taking the rest of
the page down. Full key list: `docs/vault-format.md` §5.6.

The ` ```heatmap ` fence takes the same keys a heatmap dashboard's fences take,
over the same sources.

The ` ```timeline ` fence takes `source`, `start` and `label`, with optional
`end`, `group` and `query`. Missing ends are milestones; overlapping items in
one group pack onto subtracks, and each bar/dot opens its source note. Its
source is a database type in v1 (not a sheet), because every rendered item is
required to have a truthful note-opening action. See vault-format §5.5d.

The ` ```cards ` fence takes the same card items a metrics dashboard's `cards:`
frontmatter list takes — `label` and `bind` required, `format` (`eur`, `usd`,
`number`, `pct`), `digits`, `emph` and `accent` optional — and binds resolve
identically, `{{Sheet.summary}}` against a sheet note. The ` ```chart ` fence
takes the same keys its own dashboard's fences take, over the same sources, and
the ` ```progress ` fence takes the goal keys above, over the same source
contracts.

Emphasis is capped across the **whole page**, not per fence: a hub spends at
most two sharp values however many ` ```cards ` fences it carries, so `emph` on
a third card is ignored rather than flattening the page's contrast.

A fence that doesn't parse says what's wrong where it sits — an unknown key, a
bad `format`, a card missing its `bind` — and everything around it still
renders. A fence in a language the hub doesn't render (` ```csv `, ` ```rust `)
stays a code box, as does a ` ```cards ` fence inside a callout body.

### `food` — daily net-kcal tracker

The dashboard note holds only config; rows live in a separate log **sheet** the
pane reads and appends to (columns `date,food,kcal,protein_g`; negative kcal =
exercise). The ‹ › arrows or a click on a strip bar review/log past days. A
second sheet (`db` prop, default "Food DB") holds stable kcal bases the
autocomplete prices from — `per` is `100g`, `100ml`, or `x` (per unit), with
optional `protein` at the same basis and optional `g` (grams per unit) on `x`
entries, which lets gram-typed quantities price against piece-based foods;
the pane's Database section adds/removes entries. The food field also takes kcal expressions: `<name> <qty>g <kcal>ph`
prices a weight at a per-hundred basis ("Eintopf 200g 100ph" → 200), and
trailing arithmetic evaluates ("Pizza 2*180", "23+23") — either beats the
remembered/DB fill.

````markdown
---
type: dashboard
dashboard: food
log: Food Log
db: Food DB
floor: 1900
ceiling: 2300
---
````

````markdown
---
type: sheet
title: Food Log
---

```csv
date,food,kcal,protein_g
2026-07-20,Porridge with berries,420,14
2026-07-20,Evening run,-300,0
```
````

````markdown
---
type: sheet
title: Food DB
---

```csv
name,kcal,per,protein
Skyr,60,100g,11
Eggs,80,x,7
```
````

### `feed` — curated newsfeed

The dashboard note holds only config; the items live in a separate **sheet** an
external curator agent writes (columns
`date,topic,title,source,url,blurb,why,fb`). One unified stream, newest day
first — and inside a day the sheet's row order stays untouched, because that
order is the curator's ranking. `blurb` says what it is, `why` says why it
matters to you. `curated` is rendered verbatim as the head's meta — and parsed
leniently for the head's state dot: a stamp older than ~36h reads as a warning
`stale · <age>` instead of the item count; anything unparseable
stays neutral.

The app writes **only** the `fb` column: ↑ / ↓ per item, clicking the active
verdict clears it. The write is conflict-guarded and touches that single cell,
so a re-curation mid-session fails safe instead of clobbering the new stream.

````markdown
---
type: dashboard
dashboard: feed
items: News Items
curated: 2026-07-26 09:10
---
````

````markdown
---
type: sheet
title: News Items
---

```csv
date,topic,title,source,url,blurb,why,fb
2026-07-26,plugins,"Morph 3 ships, realtime now",CDM,https://cdm.link/x,"Spectral morph, low latency.","First one you could perform with.",up
2026-07-25,ai,Open-weights stem separator,HN,https://news.ycombinator.com/x,"Local, ~2x realtime.","Archive salvage for tracks with no stems.",
```
````

Unknown `topic` values render with a neutral chip, so the curator is free to
invent slugs. A non-`http(s)` or empty `url` renders the title unlinked.


### `music-work` — the work index, pivoted

A read-only board over a **sheet** an external tree scanner writes (columns
`category,client,job,year,last_active,files,size_mb,flags`). The production
folder tree it indexes is category-first — `MASTERING/<artist>/<job>` — so the
filesystem already answers "everything for this artist" and can't answer "what
did I do in 2025". This pane supplies the missing axes over the same rows.

Three views, switched in the head: **year** (default — years newest first,
categories inside), **artist** (artists A–Z, their years newest first), and
**category** (categories A–Z, years inside). The group header carries the
page's two sharp values, the group's job count and total size; every job line
stays quiet. The filter box narrows by artist or job substring and the group
totals follow it. A non-empty `flags` cell puts a small chip on the job name
with the scanner's reason in its tooltip — it marks dating the scan isn't sure
about, not a broken job.

The app never writes this sheet, so a malformed row is skipped rather than
raised, and a missing sheet reads as an empty state, not an error.

````markdown
---
type: dashboard
dashboard: music-work
index: Work Index
---
````

````markdown
---
type: sheet
title: Work Index
---

```csv
category,client,job,year,last_active,files,size_mb,flags
MASTERING,Ada Voss,Voss Signal,2026,2026-06-13,318,23949,
MASTERING,Mira,Fern Static,2025,2026-07-29,51,1392,name 2025 vs files 2026
MIXING,Juno Marek,ep4,2026,2026-07-18,196,14324,
```
````

`index:` names the sheet by title and defaults to `Work Index`. Column order is
free and header matching is case-insensitive, so the scanner can grow columns
without breaking the pane; a row with no job name or no 4-digit year is
skipped, and missing counts read as 0.

### `tasks` — the working board

Reads every `type: task` note in the vault. The
board's spine, in render order: **Overdue**, **Due today**, the hand-picked
**Now** list (`now: true` on the task), then a section per `area:`. Empty
sections are omitted. Urgency outranks the pin — a pinned task that is overdue
or due today sits in that section instead of Now — and `due:` accepts a bare
`YYYY-MM-DD` or a timed `YYYY-MM-DD HH:MM`; a malformed value reads as no due
date rather than bucketing the row as urgent or dropping it.

A `status:` of `done` or `cancelled` drops a task out, and a future
`snoozed_until: YYYY-MM-DD` moves one into its own collapsed **Snoozed**
section, soonest wake first, so nothing vanishes silently.

Inside every section rows sort by due bucket (overdue → today → upcoming → no
due), then priority (`priority:` high 3, medium 2, low/unknown 1), then
whole-day age from `created:`. Rot is the tiebreaker, not the headline. Age
still drives the secondary chips, on list rows and board cards alike: a task
past the stale threshold reads `stale`, one whose frontmatter has no `created:`
date at all reads `undated` (that chip is about the created date, never a
missing `due:`). Those are diagnostics, never a task's reason for being on the
board — and pinned Now rows carry neither, since they're already chosen; the
exact age lives in the hover title in both views. A pinned task wears a small
pin glyph in that same chip slot instead, on rows and on board cards: in the
Board view there is no **Now** heading to explain the missing chip, so the pin
says "exempt, not overlooked" on the card face itself.

Age chips are switchable, because staleness assumes every task wants touching
and some notes just aren't. Three levels, innermost wins:

1. **Per note** — `stale: never` (or `stale: false`) on a task exempts it for
   good, at any age, on any board. It reads exactly like a pin: the row still
   sorts and counts normally, it just carries no age chip. Any other value —
   including `true`, including a typo — is ignored and the task ages as usual,
   so a mistyped key can never be the thing that silently hides rot.
2. **Per board** — a dashboard that sets its own `stale_days` has asked for age
   chips explicitly, and keeps them even when the global toggle is off. An
   unreadable `stale_days` is a typo rather than a request: it reads as unset,
   so it neither turns chips on nor changes the 30-day fallback.
3. **Globally** — `task-stale-chips: false` in `Settings.md` (the **Task age
   chips** row in Settings) turns the chips off everywhere else. On by default.

A board with chips off shows neither `stale` nor `undated`: both are age
diagnostics, and opting out of age wants neither.

Config is the dashboard note's own frontmatter, all optional:

| prop | meaning |
| --- | --- |
| `areas` | area allowlist — comma-separated or a YAML list. Omit for every area; tasks without an `area:` group under Unassigned. |
| `stale_days` | whole days before age alone chips a task (default 30). Setting it also opts this board into age chips regardless of the global toggle. |
| `view` | `board` for the kanban view; the default (or `list`) is the list. Written by the header's List/Board control, not by hand — flipping back to the default clears the prop. |
| `sort` | `priority`, `due` or `age`; the default (or `urgency`) is urgency. Written by the header's sort control the same way; an unknown value falls back to urgency rather than blanking the board. |

````markdown
---
type: dashboard
dashboard: tasks
stale_days: 21
---
````

### `yield-apr` — the yield/APR tracker

Owns its data: an append-only csv fence of snapshots in its own body. The pane
computes per-interval APR and projected day/week/month/year yield, and its form
appends rows.

````markdown
---
type: dashboard
dashboard: yield-apr
---

```csv
at,yield_usd,principal_usd
2026-07-17 10:00,0,100000
2026-07-18 10:00,26,100000
2026-07-19 10:00,53,100000
```
````

`dashboard: charts` names this renderer outright, so a note keeps it even
before the first fence is written.

A note with `type: dashboard` and **no `dashboard:` key at all** falls back by
body content: ` ```chart ` fences → charts, ` ```heatmap ` fences → the heatmap
dashboard (beside charts they hang under them), otherwise the yield tracker. A key
that *is* written but isn't a kind this build knows renders a small card naming
it and listing the kinds that exist (SUB-993) — a typo shows you the typo,
rather than quietly handing you a different dashboard.
` ```calendar ` fences fall back to the month grids the same way.

### `tax` — tax-year readiness

Read-only over two sheets: the year's aggregates, and a snapshot of rows still
missing evidence that an external exporter regenerates from wherever the books
live. The app writes to neither — the books stay canonical. The board answers
one question, "is this year fit to hand over": the totals up top, a category
table under them, and a checklist of the documents still owed. It carries the
head's **Print** action, which is the point — this is the surface you print and
hand to whoever does the filing.

The board knows nothing about any one country's filing. Its cards are the
ordinary `cards:` bindings (the same `cards:` list [`metrics`](#metrics--stat-cards-over-a-sheet) uses),
so the totals a year is judged on — and what they are called — are the note's
decision; the sample below is one freelancer's shape, not a schema.

The readiness dot is green when nothing is missing and the snapshot is fresh,
amber while documents are outstanding, and red only when the snapshot itself
can't be trusted (unreadable, or an export stamp that is missing, invalid, in
the future, or older than `stale_hours`). Missing paperwork is ordinary work in
progress, so it never reddens the board.

````markdown
---
type: dashboard
dashboard: tax
sheet: Tax 2026
missing: Tax Missing
stale_hours: 240
cards:
  - label: Income YTD
    bind: "{{Tax 2026.income_ytd}}"
    format: eur
    emph: true
  - label: Profit YTD
    bind: "{{Tax 2026.profit_ytd}}"
    format: eur
    emph: true
  - label: Documents
    bind: "{{Tax 2026.documents}}"
    format: number
---
````

````markdown
---
type: sheet
title: Tax 2026
---

```csv
category,sheet,rows,amount_eur,basis
Income,Income,38,21400,Business
Business expenses,Expenses,52,9260,Business
Equipment,Expenses,0,0,Business
```

```formulas
income_ytd = SUMIF(category, "Income", amount_eur)
expenses_ytd = SUMIF(category, "Business expenses", amount_eur)
profit_ytd = income_ytd - expenses_ytd
documents = SUM(rows)
```
````

````markdown
---
type: sheet
title: Tax Missing
exported: 2026-08-03T06:00:00Z
---

```csv
sheet,name,date,missing
Expenses,Studio rent — March,2026-03-01,Receipt no.
Expenses,Interface repair,2026-05-14,Document Filed; Receipt
Expenses,Domain renewal,,Receipt no.
```
````

A card bound to a summary the sheet doesn't define says so on the card, so a
half-configured year still shows what it has. In the snapshot, `missing` is a
semicolon-joined list of the evidence fields still outstanding; a row with no
name or no missing fields is skipped rather than raised, and the checklist sorts
by sheet, then date (undated last), then name. Full contract:
[vault-format.md §5.2](vault-format.md).

## Kinds over the machine

These read state *outside* the vault, so they only light up on a machine that
has it. Elsewhere they render an empty state, not an error: the pane says in a
line what it was looking for and why there is nothing here, and renders no
action buttons at all — a verb whose only possible outcome is a failure is
better not offered than offered greyed out.

### `sync` — a control surface over an external sync system

Nothing in this app copies your files. Something else does — a runner script on
a schedule (launchd on macOS), writing a JSON state file as it goes. This kind
is a *window onto* that system: what each remote and leg last did, whether the
schedule is still loaded, the recent errors from its log, and buttons to start
a sweep now or pause the schedule.

Every binding is the note's own frontmatter, so the same kind works on any
estate:

| prop | meaning |
| --- | --- |
| `state` | the sync system's state file. Defaults to `~/.config/rclone/sync-state.json` — the path this kind looks in, not one anything writes for you: your runner does (rclone itself ships no such file). Must resolve under your home directory — a path with `..`, a symlink leading out of it, or one outside `$HOME` is refused rather than read. |
| `log` | its log file, tailed for recent errors. Defaults to `logs/sync.log` beside the state file. Same home-directory rule. |
| `prefix` | launchd label prefix of its agents, e.g. `com.example.sync.` — the pane reads (and pauses/resumes) only labels under it. Defaults to `com.example.sync.`, a placeholder every estate replaces; it must end with a dot and be specific enough to be a prefix, so a stray `c` can't sweep in every agent on the machine. |
| `runner` | the executable a Run button starts — a file with the exec bit set, outside your vault, under your home directory. If the state file names its own `runner`, that is used and this prop is unnecessary. Nothing runnable there → the Run buttons render disabled and say so. |
| `stale` | how old a remote's last completed sweep may get before its row reads alert. `12h` sets one window for every remote, `offsite=30h, nas=9h` sets them per remote, and the two forms mix. Default 30h. |

The runner is started with the direction (and leg) as its arguments and
nothing else — the note names *which* script, never a command line. It is
spawned directly, so it has to be executable itself (`chmod +x`); the app
picks no interpreter for it. And it may not live inside the vault: a note is
content that can arrive by sync or import, and a folder someone shares with
you must not be able to bring its own runner. Directions come from the state
file itself: a run of a remote the state file doesn't know is refused.

A complete note:

```markdown
---
type: dashboard
dashboard: sync
state: ~/.config/rclone/sync-state.json
prefix: com.example.sync.
runner: ~/bin/sync-run
stale: offsite=30h, nas=9h
---

Backup sync for this machine. Pausing here pauses the schedule for the
machine, not just for the app.
```

The state file is the contract, and every field in it is optional — unknowns
render as "—" or "never" rather than blanking the pane:

```json
{
  "host": "workstation",
  "updated": "2026-08-15T09:12:04Z",
  "runner": "~/bin/sync-run",
  "remotes": {
    "offsite": {
      "last_complete": "2026-08-15T04:03:11Z",
      "last_attempt": "2026-08-15T04:03:11Z",
      "running": false,
      "quota": { "free": 214748364800, "total": 1099511627776 },
      "quota_low": false
    }
  },
  "legs": {
    "Vault:offsite": {
      "status": "ok",
      "duration_s": 41,
      "errors": 0,
      "last_ok": "2026-08-15T04:03:11Z",
      "history": [{ "at": "2026-08-15T04:03:11Z", "outcome": "ok", "errors": 0 }]
    }
  }
}
```

The remote names (`offsite` here) are the directions a Run button can start;
leg keys are `LegName:remote`, split on the last colon.

### `coding` — per-repo git health

One row per project under a folder of repositories: a state dot, the repo name
and its current branch over the last commit subject, then chips for what needs
doing — dirty files, unmerged local branches (with the oldest one's age), extra
worktrees, and ahead/behind against `origin/<integration branch>`. Rows that
need attention (dirty, behind, harbouring a 4+ day old unmerged branch, or
broken) sort to the top in full contrast; quiet repos dim below them. Directories
that aren't git repos are listed at the foot with their size and last touch.

Strictly read-only, and never networked: the scan shells out to `git -C <repo>`
read verbs only — `status`, `log`, `branch`, `worktree`, `rev-list` — so an
ahead/behind count is measured against the `origin/…` ref your last fetch left
behind, not a fresh one. Read-only is enforced, not just intended: every call
carries `--no-optional-locks`, so a rescan landing while you are mid-rebase
can't take `.git/index.lock` out from under you, and `-c core.fsmonitor=`, so a
repo that arrived as an archive rather than a clone can't have the scan run a
command out of its own config. A repo git can't read shows its error on the row
and the rest of the table still renders.

The full scan is seconds-slow (sizing the directories dominates), so the result
is cached for an hour, per root. Mount reads the cache; the head's **↻ rescan**
forces a fresh walk. Sizing shares a 20-second budget across the whole scan — a
very wide root stops there rather than walking for minutes, and the footer says
the sizes are partial when it does.

| prop | meaning |
| --- | --- |
| `root` | folder to scan, one level deep — every child directory is a row. `~/…` expands, an absolute path is taken as given, and a bare name is read against your home folder. Defaults to `~/Coding`. |

A `root` is note text, and note text syncs between devices, so it answers to the
app's deny list: the credential and application stores an `asset:` link may
never open (`~/.ssh`, `~/.config`, `~/Library/Application Support`, …) are not
scannable either, and a bare name can't climb out of your home folder with
`..`. A refused root renders as an empty pane, not an error.

The integration branch a repo's unmerged branches are counted against is `main`
if that local branch exists, else `master`, else whatever is checked out — a
convention, not a setting.

```markdown
---
type: dashboard
dashboard: coding
root: ~/Coding
---

Per-repo git health. Nothing here is editable — the table is the scan.
```


These read state *outside* the vault, so they only light up on a machine that
has it. Elsewhere they render an empty state, not an error — and any button
that would need a missing tool renders disabled with the reason, rather than
offering a verb that could only fail.

### `jobs` — the scheduled jobs on this machine

launchd owns the clock. The app has no auto-start, so an in-app scheduler would
silently stop the moment nobody opened the window — this pane is a *window onto*
the machine's scheduler, never a replacement for it. Every row is one agent: a
state dot, the short name and its prefix, the schedule (and live pid), then
chips for a nonzero last exit, for the exit-status history, and for freshness.

macOS only, and the pane says so itself: it asks the backend whether there is a
launchd here before it reads anything, and on a machine without one it renders
that one line and no buttons at all.

Config is the note's own frontmatter:

| prop | meaning |
| --- | --- |
| `prefixes` | label allowlist — comma-separated or a YAML list. Defaults to `com.substrate.`; junk or empty falls back to that rather than blanking the pane. Name the prefixes your own agents use. |
| `control` | labels that get Pause / Resume / Run buttons. Everything else renders read-only — a job the app didn't register isn't the app's to poke. |
| `freshness` | probes shaped `label \| note/path.md \| prop \| 26h`. The prop is read from that vault note's frontmatter; older than the max-age (or missing/unreadable) warns on the row and on the header dot. |

Buttons are gated twice: the label must be listed in `control:` **and** the job
must exist on this machine with a plist on disk. On a machine with none of these
agents the pane says so calmly and offers no verbs at all.

**Exit history.** `launchctl list` exposes only the single most recent
`LastExitStatus`, so one lucky success paints a week of failures green. Every
poll (60s) therefore samples each job's `(pid, last exit)` picture into a
per-label ring of recent run outcomes, persisted app-side at
`.vault/jobs-exit.json` (last 10 per label, device-local, git-excluded). A row
with failures in its window gets a detail chip — "3 of last 5 runs failed" — and
the row reads unhealthy through the same dot/tint idiom as the exit chip:
**alert** (red) when most of the window failed, **warn** (amber) when some did,
and the header counts those rows as *failing* / *flaky* accordingly. **Polls are
not runs:** the 60s sample sees only the latest run — a run that starts and ends
between two polls leaves no trace — so the counts are approximate, a floor on
how often the job ran rather than an exact tally. Dedupe is by state transition:
the same picture twice is one run; a status flip or a pid turnover/end records a
new one; a pid appearing is a run *starting* and records nothing.

A complete note:

```markdown
---
type: dashboard
dashboard: jobs
prefixes: com.example., com.substrate.
control:
  - com.example.digest
  - com.example.verify
freshness:
  - com.example.digest | Dashboards/News.md | curated | 26h
---

Scheduled jobs on this machine. Pausing here pauses the job for the machine,
not just for the app.
```


## Style tokens — `accent` and `size`

A dashboard can set mood, and only mood. Two tokens exist, both **names from a
closed list** — never a hex value, a pixel value, a font, or arbitrary CSS. The
design system owns taste; a board picks from what it offers.

- **`accent: <name>`** on a metric card or a hub callout (`> [!note|teal]
  Title`). The names are the ten your select options and status pills already
  use: `gray`, `blue`, `indigo`, `violet`, `pink`, `red`, `orange`, `yellow`,
  `green`, `teal`. It tints the card's label and its rule — mood, not state,
  and never the number itself, so the value ramp keeps its contrast.
- **`size: tall`** on a ` ```chart ` fence. The one size name a chart can ask
  for; how tall `tall` is stays the app's call.
- The same `accent` name rides the other card surfaces: a ` ```cards ` fence
  card, and a ` ```progress ` fence, where it tints the goal's label and leaves
  the bar neutral.

Accent and `emph` are independent: hue says what a card is *about*, `emph` says
which card *matters*. Accenting everything therefore can't quietly spend the
board's two sharp values.

**An unknown token name renders as absent — never an error.** `accent: mauve`,
`accent: "#14b8a6"` or `size: 400px` leave the card or chart looking exactly as
it would with no token at all, and the board keeps rendering. That is deliberate
and it is the one place fences are lenient: a wrong `bind` is a lie about your
data and still fails loudly, while a wrong colour is only a preference nobody
can honour.

Because the names resolve through the theme, a board that asks for `teal`
follows the theme when the theme moves — including the accent-tone settings.
A vault-resident kind gets the same roster as `ctx.accents` and reaches mood
the same way: `data-accent="<name>"` on a sanctioned class.

## Workbook pages — tabs at the bottom

Any dashboard can grow pages: add a `pages:` list to its frontmatter and the
pane gains a sheet-tab strip at the bottom, like a spreadsheet. The first tab
is the dashboard itself; each entry adds a page pointing at a sheet note
(editable grid), another dashboard (rendered flat — no nested tabs), or a
database cut (`view:` or `saved:`) with the same optional `sort:`, `limit:` and
`columns:` keys as a view fence; `query:` applies to `view:`, while `saved:`
keeps its pin's query. ⌃⇥ / ⌃⇧⇥
cycle pages. The demo vault's `Label Accounting` workbook is the reference:
metrics cards over a statements sheet, with the statement and splits sheets
plus the release database one tab away. Full contract: `vault-format.md` §5.6a.

## Adding a built-in kind

Every kind above is built the same way, and the recipe is short enough to state
in full: **one component, plus one line of dispatch in
`src/components/DashboardPane.tsx`**. When the kind needs the OS — reading
something outside the vault, talking to a service — that's **one Rust command in
`src-tauri/src/lib.rs` plus a mock case in `src/lib/tauri.ts`**, so the
browser/e2e lane keeps working without a Tauri build.

A kind's name is written out in several inventories that must agree — the
built-in registry, the dispatch chain, the icon table, the dispatch table in
`docs/vault-format.md` §5.2 and the orientation file the app seeds into a new
vault (`src-tauri/src/seed/AGENTS.md`) — so `scripts/check-kinds.ts` compares
them and fails `npm test` on drift.
Add the name everywhere in the same change.

That is the shape for a kind that ships *in the app*. For one that lives in a
vault instead, read on.

## Writing your own kind

When none of the kinds above fits, you can put the renderer in the vault
itself: a folder under `.vault/kinds/<id>/` holding a manifest and a small
script. The note then names it like any other kind — `dashboard: gear-log` —
and the app mounts your code in the pane. This exists so "make me a board that
shows X" is a file someone (or an agent) writes in an afternoon, rather than a
change to the app.

**Reach for it last.** A chart over a sheet is a ` ```chart ` fence; a row of
numbers is `metrics`; a landing page is `hub`. Those are configuration, they
survive upgrades untouched, and they need no trust decision. Write a kind when
the thing you want is a genuinely different rendering or interaction — a
floor-plan view of your gear, a board with its own editing gesture — not to
restyle something a built-in already does.

A minimal bundle is two files:

```
.vault/kinds/gear-log/
  kind.json
  index.js
```

```json
{
  "id": "gear-log",
  "title": "Gear log",
  "api": 1,
  "entry": "index.js",
  "description": "What is plugged into what, by room."
}
```

The folder name **is** the kind id and must equal `id` — lowercase letters,
digits and dashes. `api` is the contract version you wrote against (1 today).
`entry` is a bare filename inside the folder. Optional: `style` (a CSS file in
the bundle), `icon` (a curated glyph name) and `author`.

`index.js` is a plain ES module — no build step, no imports, no React. It
default-exports an object with a `mount(el, ctx)`:

```js
export default {
  mount(el, ctx) {
    const draw = async () => {
      const notes = await ctx.notes();
      const gear = notes.filter((n) => n.props.type === "gear");
      el.innerHTML = `
        <div class="${ctx.css["dash-metrics"]}">
          <div class="${ctx.css["dash-metric"]}">
            <div class="${ctx.css["dash-label"]}">Pieces</div>
            <div class="${ctx.css["dash-value"]}">${gear.length}</div>
          </div>
        </div>`;
      ctx.setState({ label: `${gear.length} logged` });
    };

    draw();
    const off = ctx.onChange(draw);
    return () => off();
  },
};
```

`el` is yours to fill; the app draws the header above it. `ctx.css` hands you
the app's own class names, so a kind that renders through them picks up the
current theme instead of inventing a second look — the full roster and the
missing-key rule are in the contract
([vault-format.md §5.8](vault-format.md#58-custom-kind-bundles--vaultkindsid)).
`ctx.onChange` is the redraw
signal — `mount` runs once, and the returned function is your cleanup on
unmount. `el` stays the same element across redraws while your `innerHTML`
replaces its children, so wire clicks as one delegated listener on `el`, not
on children that vanish with the next draw. `ctx.setState({ color, label })`
lights the dot in the header — `color` is any CSS color; `null` keeps it
quiet.

Beyond `notes()` (whose optional argument is a plain predicate:
`ctx.notes((n) => n.props.type === "gear")`), ctx gives you `read(path)`,
`sheet(title)` (a parsed,
evaluated sheet fence), `create(…)`, `openNote(path)`, `toast(msg, action?)`
and the two writes. **Writes take a compare-and-swap guard and it isn't
optional** — `setProp(path, key, value, expected)` and
`writeBody(path, body, expectedBody)` refuse rather than overwrite when the
note changed since you read it; the refusal is a rejected promise, so catch
it, toast, and redraw from a fresh read. Check before calling anything you're
not sure
this build has (`if (ctx.sheet) …`): ctx gains members without bumping `api`.

**Enabling it is a deliberate act.** A kind runs with the same access as
Substrate itself — there is no sandbox — so a bundle does nothing until you
enable it for this vault on this device, after reading its title, description
and author. Consent is pinned to a hash of the bundle's bytes: if the code
changes, the kind stops and asks again, which is what keeps a synced folder
from delivering new code into an already-trusted slot. A second device asks
you again on purpose. A bundle that can't run — broken manifest, wrong api,
not enabled yet — shows a card saying which and why; it never silently falls
back to another renderer.

**Where you say yes, and how you take it back.** The question is asked where
it comes up: a dashboard naming a kind you haven't enabled renders a review
*in place of the dashboard body*, inside the normal head — not a modal, so
there is nothing to dismiss with Escape and nothing arriving on top of what
you were doing. The review names the kind, its author and description, the
entry file, the api it asks for, how many files the consent covers and how
big they are, plus the terms in plain words (your whole vault, read and
write; this vault on this device only; pinned to these exact files). *Open
the code* reveals the folder in Finder rather than opening the entry file, so
looking at it never runs it. Not deciding is a decision: the kind stays off.

When the bytes change under an enabled kind, the same pane comes back worded
for the second decision, and only there is a **trust updates to this kind**
rider offered — a standing yes for future changes to a kind this vault has
already approved once. It is never offered on a first enable, because one
interaction must not be able to both admit code nobody has read and
pre-approve every later version of it. Ticking it writes nothing on its own;
it rides the enable press next to it, so the change in front of you is still
consented to by hand.

**Settings → Kinds** is the standing view: every bundle this vault has,
what state it is in here, the rider (editable for a kind that is currently
running), and *disable*. Disabling withdraws consent only — the folder, its
files and its history stay exactly where they were, and re-enabling is the
same review again. The button is there whenever this device holds a consent
record, including for a kind that has since become unrunnable, which is
precisely when you most want to withdraw it.

**Your code is vault content, so version history covers it.** A bundle under
`.vault/kinds/` is snapshotted exactly like a note: history excludes only
`.assets/`, `.trash/`, `.DS_Store` and the four device-local `.vault` JSONs,
and nothing in that list is your folder. An overwritten or deleted bundle is
recoverable from history — an afternoon's work on a board is never one sync
glitch or one stray write away from gone. Keep your bundle in the vault and it
travels with the vault's own guarantees; no separate backup step is implied.

Full contract, including the manifest grammar, the hash layout and every ctx
member: [vault-format.md §5.8](vault-format.md#58-custom-kind-bundles--vaultkindsid).

## Installing one from the cookbook

Nothing above has to be typed from scratch. The app ships the repo's
[`cookbook/`](../cookbook/README.md) — one folder per ready-made surface, each
holding the dashboard note plus the sheets and sample rows it binds to — and a
**Cookbook** pane that browses them: the book icon beside the sidebar's release
history, or "Browse dashboard cookbook" in the palette (⌘K).

Each recipe lists with its screenshot, the kind it uses, what it binds to and
how to adapt it. **Install** copies that recipe's files into the open vault, so
the board renders with numbers the first time you open it; the pane then names
every file it wrote and offers a click-through to the dashboard.

Two properties worth knowing:

- **Nothing reaches the network.** The recipes are the ones your installed
  version shipped with, read from the app bundle.
- **Nothing is overwritten.** A recipe file whose path is already taken lands
  beside the existing note as `<name> (cookbook).md`, and the result names both,
  so a second install reads as a copy rather than a silent no-op.

The same recipes are plain files in the repo, so copying a folder in by hand —
or handing [`cookbook/index.json`](../cookbook/index.json) to your agent — gets
you the same board.

## Creating one in-app

New note (⌘N or the palette), then add the props — set “Database” to `dashboard`
and add a `dashboard` prop with the kind. The sidebar's Dashboards section lists
every `type: dashboard` note. Since dashboards are files, an external tool or
agent can also just write them into the vault; the watcher picks them up live.

## Where the rows show up

Make a top-level `Dashboards/` folder and it is the section's home: everything in
it lists in the Dashboards section (one level of subfolders becomes collapsible
groups), dropping a note on the Dashboards header files it there, and dashboards
you keep in content folders — `Studio/Gear Health.md` beside that folder's notes
— render on their folder's row in the Folders tree instead. That holds however
many dashboards pile up elsewhere; the folder decides, not a head count.

Without a `Dashboards/` folder the app infers a home instead — whichever folder's
subtree holds the most dashboards — so a vault that never made one still gets a
sensible section. Create the folder any time you want to stop it moving.
