# Dashboards — a guide

A dashboard is just a note: `type: dashboard` plus a `dashboard:` prop naming the
renderer. The note's frontmatter and fenced blocks are the config and the data —
everything is plain text, so a dashboard is created by writing a file. In the app,
**⌘K → “New dashboard…”** does the same thing: pick the kind, name the note, and it
opens on its own empty state, which says what that kind still wants. This guide
shows each kind with a complete copy-paste example; the exact on-disk contract
lives in [vault-format.md §5](vault-format.md).

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

`metrics`, `charts`, `hub` and `heatmap` also leave the app: the head's
**Print** action prints the live pane as designed — a workbook's *active* page,
not every page — through the same `@media print` surface notes use (Save as PDF
lives in the dialog). The rest stay screen-only: `calendar` carried the action
once and lost it, because a month grid loses its last columns on paper — it can
re-earn it. The
machine-specific kinds never had it.

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
frontmatter more is clamped to 8, while the ` ```cards ` fence says so as an
error). A bind must name a **summary** (an aggregate line), not a
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
becomes a side-by-side card row — a callout can ask for the double-width card
with `> [!note|span:2] Title` — and ` ```view `, ` ```chart `, ` ```cards `,
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

> [!note|span:2] Studio
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

**The topic chips are a setting.** Clicking them narrows the stream and writes
`feed-topics` in `Settings.md` (a list of slugs; empty or unset = the whole
stream), through the same undoable path the ⌘, rows use — so ⌘Z takes a topic
back, an agent can set the filter by editing the note, and the selection
follows you to another machine. A slug the selection names but today's stream
doesn't have still gets a chip, so a filter that came from another machine and
now matches nothing can be switched off rather than only edited out of the
note by hand. Vault-format §12 has the key.

**Plugging in a curator.** The head carries a **refresh button** once a
`feed-curator` command is configured — the pane's own "plug in a curator" card
writes it, or set the key in `Settings.md` (⌘, → Terminal → Feed curator does the same):

```yaml
feed-curator: ~/scripts/curate-news.sh
```

The command is anything that re-curates the items sheet: a shell script
calling your agent CLI, `claude -p "re-curate News Items per AGENTS.md"`, a
curl into your own pipeline. The contract, from the app's side:

- It runs headless through **your login shell** (`$SHELL -lc`) with the
  **vault root as working directory** — PATH and profile resolve exactly like
  a line typed into your terminal, and relative paths mean "in the vault".
- It should rewrite the items sheet's csv rows (columns above) and ideally
  bump the dashboard note's `curated:` stamp — the rows land through the
  vault watcher like any external edit, so writing the files IS the API
  (vault-format §13 has the writer rules).
- **One run at a time**, no queue; a second click while live is refused. The
  button spins while it works and acts as cancel; a **20-minute watchdog**
  kills a wedged run, and quitting the app kills a live run too.
- Exit `0` = done; the **last line printed to stdout** becomes the run
  summary on the button's tooltip. A non-zero exit shows the stderr tail as
  the pane's error banner.

Because `Settings.md` is vault content — it syncs, imports, and an agent
pointed at your vault can write it — the exact command string is gated behind
the same **per-machine approval** as `terminal-command`: a command you didn't
save through the pane's own card asks for your yes before its first run, and
approvals are remembered on this machine only, never in the vault. That makes
"set up a curator for my news feed" a safe one-line agent prompt: the agent
writes the key and the sheet contract does the rest; you approve the command
on first click.

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
board's spine, in render order: **Overdue**, **Due today**, the tasks picked
for today (`today:` carrying that day, the same mark the Today pane's Pick
verb writes), then a section per `area:`. Empty sections are omitted. Urgency
outranks the pick — a picked task that is overdue or due today sits in that
section instead of Today — and `due:` accepts a bare
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
board — and rows picked for today carry neither, since they're already chosen;
the exact age lives in the hover title in both views. A picked task wears a
small pin glyph in that same chip slot instead, on rows and on board cards: in
the Board view there is no **Today** heading to explain the missing chip, so the pin
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

### `yield-apr` — moved into the vault

Not an app kind any more. It is a **vault-resident kind** (`docs/vault-format.md`
§5.8): a `.vault/kinds/yield-apr/` folder holding a manifest, a module and a
stylesheet, which `dashboard: yield-apr` mounts in a vault that carries it.
Without the folder the name renders the unknown-kind card like any other value
this build does not know. It was a single-purpose finance tracker carrying
headline weight it did not earn, and the move to vault-resident kinds demoted
it out of app code; the note format it reads and writes is unchanged and still
documented at `docs/vault-format.md` §5.3.

That leaves `charts` as the one kind that names its renderer outright:
`src/lib/kinds.ts` reserves the name and `DashboardPane` dispatches it fence or
no fence, so a note keeps it before the first fence is written.

A note with `type: dashboard` and **no `dashboard:` key at all** falls back by
body content: ` ```chart ` fences → charts, ` ```heatmap ` fences → the heatmap
dashboard (beside charts they hang under them). ` ```calendar ` fences fall back
to the month grids the same way. The fences with no board of their own —
` ```progress `, ` ```cards `, ` ```timeline `, ` ```view ` — fall back to the
hub, which already draws all four, so every fence that draws anywhere also
configures a note that names no kind. That arm is tried last, so a body holding
a chart and a thermometer is still a charts dashboard, exactly as before. A
body with **none** of those fences renders a help card naming the kinds that
exist — it used to render the yield tracker, so
a note saying only `type: dashboard` became a financial instrument with a live
rates request and a Claim button that wrote back into it. A key that *is*
written but isn't a kind this build knows renders that same card naming the
value — a typo shows you the typo, rather than quietly handing you a different
dashboard.

### Tax readiness — fences, not a kind

There is no `tax` kind. A tax year is metrics and a checklist, and both of those
are fences the app already has, so the board is an ordinary [`hub`](#hub--a-designed-home-page):
a ` ```cards ` fence bound to an aggregates sheet's summaries, and the documents
still owed written under it as a plain markdown checklist. It prints from the
head like any other hub, which was the point of the board — the page you hand to
whoever does the filing.

Nothing about it knows a country's filing rules, and nothing about it is
special-cased: the totals a year is judged on are the note's cards, and the
checklist is yours to keep in step with whatever exports it. `cookbook/tax/` is
the worked recipe — a board and the two sheets it reads.

````markdown
---
type: dashboard
dashboard: hub
---
How ready the year is to hand over. Totals come from [[Tax 2026]]; what is still
owed is the checklist below.

## The year so far

```cards
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
```

## Still owed

- [ ] Studio rent — March · Receipt no.
- [ ] Interface repair · Document Filed; Receipt
````

The aggregates sheet is an ordinary [sheet](sheets-spec.md), so the year's
numbers are `csv` + `formulas` and the cards bind to its summaries — a bind that
names a summary the sheet doesn't define says so on the card. A vault that still
carries a `dashboard: tax` note renders the unknown-kind card until the note is
moved onto the shape above; nothing on disk is lost.


## Style tokens — `accent`, `size` and `span`

A dashboard can set mood and coarse shape, and only that. Three tokens exist,
all **values from a closed list** — never a hex value, a pixel value, a font,
or arbitrary CSS. The design system owns taste; a board picks from what it
offers.

- **`accent: <name>`** on a metric card or a hub callout (`> [!note|teal]
  Title`). The names are the ten your select options and status pills already
  use: `gray`, `blue`, `indigo`, `violet`, `pink`, `red`, `orange`, `yellow`,
  `green`, `teal`. It tints the card's label and its rule — mood, not state,
  and never the number itself, so the value ramp keeps its contrast.
- **`size: tall`** on a ` ```chart ` fence. The one size name a chart can ask
  for; how tall `tall` is stays the app's call.
- **`span: 2`** on a hub callout (`> [!note|span:2] Title`, or with an accent:
  `> [!note|teal|span:2] Title`). The card claims two of its row's columns
  instead of one — a width in columns, never a measurement, and 1 or 2 are the
  only widths there are. A pane too narrow to hold two columns renders it as an
  ordinary card, so a wide card never overflows the page it is on.
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
follows the theme when the theme moves — including the accent-tone setting,
which since 2026-08-22 drives the whole app's accent family, not just the
dashboard surfaces.
A vault-resident kind gets the same roster as `ctx.accents` and reaches mood
the same way, through exactly one class: `data-accent="<name>"` on a
`dash-card`. That is the one sanctioned class wired for it — the attribute on
a `dash-metric`, on a `dash-table` or on an element of your own paints
nothing, and paints nothing silently, so a kind that wants hue elsewhere puts
it there with its own CSS and accepts that it no longer follows the theme.

## When a board has nothing to draw

Every kind speaks the same two sentences, so a reader — or an agent iterating
on a config — can tell the two apart at a glance without knowing the kind.

- **Nothing here, and nothing is wrong**: a quiet dot and one sentence in the
  page's reading voice, saying what this board still wants. A board that filters
  to nothing, a sheet that has no rows yet, a note with no fences in it. Where
  the emptiness is itself the good news — the readiness board with nothing left
  to file — the dot is green and the sentence says so.
- **Something failed**: a banner, marked with a rule and set in the page's data
  voice. A fence that would not parse, a source that names nothing, a file that
  could not be read, a write that did not land. It always says what broke and,
  where the app knows it, what to change.

The distinction is load-bearing rather than decorative: an empty board is a
board waiting for content, and a failed one is a board whose config or data is
wrong. Rendering the second as the first — "no rows matched" over a database
that does not exist — is the one answer these surfaces refuse to give.

A fence that is opened and never closed is a failure, not an absence: the
board would otherwise count zero fences and say nothing about the one plainly
written in the note. It gets the banner, naming the missing closing line.

The same split reaches the other way, into ordinary notes. A ` ```chart `,
` ```cards `, ` ```progress `, ` ```heatmap `, ` ```calendar ` or ` ```timeline `
block only draws where a dashboard renders it; written into a note that is not
one, it is a code box and nothing more. So the note hangs one line under it in
the calm voice — a dot and a sentence, "A heatmap draws on a dashboard note —
here it stays as text." Never the banner: nothing has failed, the block is
simply somewhere it does not draw. A ` ```view ` gets no line, because it embeds
its table in an ordinary note already, and neither does a tailed opener of a
bare-form language (` ```calendar month `), which draws nowhere at all —
sending its author to a dashboard would be wrong twice.

## Workbook pages — tabs at the bottom

Any dashboard can grow pages: add a `pages:` list to its frontmatter and the
pane gains a sheet-tab strip at the bottom, like a spreadsheet. The first tab
is the dashboard itself; each entry adds a page pointing at a sheet note
(editable grid), another dashboard, or a database cut (`view:` or `saved:`)
with the same optional `sort:`, `limit:` and `columns:` keys as a view fence;
`query:` applies to `view:`, while `saved:` keeps its pin's query. ⌃⇥ / ⌃⇧⇥
cycle pages. The demo vault's `Label Accounting` workbook is the reference:
metrics cards over a statements sheet, with the statement and splits sheets
plus the release database one tab away. Full contract: `vault-format.md` §5.6a.

When a page points at a dashboard that has pages of its own, those pages come
with it: a small switcher appears at the top of that page, above the
dashboard, and moves between them. So a hub whose Tax tab is itself a
workbook of sheets reaches those sheets from inside the hub, instead of
showing the Tax overview and quietly dropping the rest. The strip along the
bottom stays the workbook you opened, so it is always clear which of the two
you are paging. It goes one level: a dashboard opened from inside a switcher
renders on its own, which is also why two dashboards pointing at each other
can't spiral.

## Adding a fence

Extending the app runs in three sizes, and this is the smallest: a new block
language that boards render live — no new pane, no new kind, just another
thing a note's body can draw. Most ideas that arrive as "a new dashboard"
fit here (a sparkline, a countdown, a streak strip), and a fence reaches
further than a kind does: it draws inside the hub, inside any prose
dashboard, and anchors a keyless `type: dashboard` note on its own.

Every fence the app parses is declared in one table — `FENCE_REGISTRY` in
`src/lib/fenceRegistry.ts` — and adding one is working outward from a single
new row:

1. **Declare it in the registry.** One entry names the id, whether its opener
   is *tailed* (dispatched on the first word, so ` ```view table ` is live)
   or *bare* (the strict opener only — a tailed opener of a bare-form
   language is someone's prose), whether dispatch folds case, the noun the
   editor's out-of-place hint calls it, and whether the hub draws it. The
   strip pattern, the editor hint and the keyless-dashboard fallback all
   derive from this row; none of them is edited by hand.
2. **Mirror the id into the Rust twin.** The vault reader strips machine
   fences from search text with its own copy of the pattern
   (`machine_fence_re` in `src-tauri/src/vault/mod.rs`).
   `scripts/check-fence-langs.ts` compares the compiled TypeScript pattern
   against the Rust literal character for character and fails `npm test`
   until both sides agree — entry order is part of the pattern, so keep the
   two sides in the same order.
3. **Write the parser and renderer.** A `parse…Blocks(body)` function in its
   own module and a component that draws the parsed config; the existing
   pairs — chart, heatmap, calendar — are the templates to copy.
4. **Dispatch it on the hub canvas**: one row in the renderer map in
   `src/components/HubDashboard.tsx`, beside the others. The map is keyed by
   the registry's own hub ids, so a row you declared live and never wrote a
   renderer for does not compile — there is no list to remember to update.
   `src/lib/hubFenceDispatch.component.test.ts` then renders every declared
   fence and fails if one comes back a code box.
5. **Give it a `/` scaffold** in `src/lib/slashmenu.ts`, so typing `/` in the
   editor offers the fence with a ready body and the cursor placed inside.

Then say what you built where readers look: a subsection in this file, and a
row in the fence grammar in `docs/vault-format.md` §5.

One fence breaks step 3's shape on purpose and is worth knowing about before
you copy a template: ` ```kind ` (§5.5e) takes its SUBJECT from the info string
rather than the body, and hands the body through to vault code without reading
a key. Its parser therefore validates an id and a `key: value` shape and stops
— it has no key table to grow. Copy it when your fence configures something the
app does not own; copy chart or calendar when it configures something the app
does.

When a fence is not enough — the thing you want is a whole pane with its own
chrome, not a block inside one — the next size up is a kind.

## Composing a custom kind into a page — ` ```kind ` fences

Everything above composes: a hub page can carry a chart, a card strip and a
live table side by side. Until now the one thing it could not carry was *your
own* kind — a `.vault/kinds/` bundle was a whole note or nothing. A ` ```kind `
fence closes that: your kind becomes a block, sitting wherever you wrote it.

```kind gear-log
room: studio
limit: 5
```

The word after ` ```kind ` is the kind id — the folder name under
`.vault/kinds/`, the same name a note's `dashboard:` prop would use. The lines
underneath are optional, and **Substrate does not read a single one of them**:
they arrive at your kind as `ctx.config`, a frozen map of strings, and what the
keys mean is entirely yours to decide. So the same bundle can draw the studio
rack in one block and the hall rack in the next:

````markdown
## Studio

```kind gear-log
room: studio
```

## Hall

```kind gear-log
room: hall
```
````

Read them with a default, because the same kind also mounts as a whole note,
where there is no fence and `ctx.config` is `{}`:

```js
const room = ctx.config.room ?? "studio";
const limit = Number(ctx.config.limit ?? 10);
```

Two differences from a full-note mount, both about chrome rather than power:
the block has no head of its own (the page owns the title bar, so
`ctx.setState`'s dot has nowhere to draw), and it is sized by the page rather
than by the pane. Everything else — every `ctx` member, the vault access, the
reclamation rules — is identical.

### It asks before it runs, once

A kind fence is code from your vault, so it is gated exactly as a full-note
kind is, **by the same decision**. The first time a hub tries to draw a kind
this vault has not consented to, the block shows the review card you already
know: what the kind is, who wrote it, which file runs, what the hash covers,
and what enabling means. Press *Enable* and the kind mounts in place.

What "the same decision" buys you:

- **One decision per kind, per vault** — not one per fence. Three fences over
  `gear-log` each draw their own review card, in their own block, because a
  block that showed nothing would be a hole in the page with no way to act on
  it. But it is one question asked three times, not three questions: answer any
  one card and all three fences light at once.
- **Enabling from a fence enables the kind everywhere**, including its
  full-note pane. There is one record; the fence is another place to be asked
  about it, never another thing to answer.
- **Saying nothing is safe.** A block waiting on review is a quiet card. The
  rest of the hub draws normally — a kind you never enable costs you one block,
  not the page.
- **Revoking is Settings → Vault**, and it takes effect on screen: disable a
  kind and every fence over it stops and returns to the review card, with no
  reload. The folder stays; only the record goes. Editing the bundle's bytes
  does the same thing — the fence stops and asks about the new code — unless
  you turned on that kind's *trust updates* rider, which is the loop to use
  while you are the one writing it.

Only vault-resident kinds compose this way. A built-in name in a kind fence
(` ```kind tasks `) says so rather than pretending not to exist — built-ins
already have their own fences.

Full contract: `docs/vault-format.md` §5.5e (the fence) and §5.8 (the bundle,
the record and the review).

## Adding a built-in kind

Every kind above is built the same way, and the recipe is short enough to state
in full: **one component, plus one line of dispatch in
`src/components/DashboardPane.tsx`**. When the kind needs the OS — reading
something outside the vault, talking to a service — that's **one Rust command in
`src-tauri/src/lib.rs` plus a mock case in `src/lib/mockBackend.ts`**, so the
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
unmount. The host reclaims what it can see: the element, the stylesheet, its
own subscriptions, and the timers and `window`/`document` listeners you armed
while `mount` was running. Anything registered later, from an `await` or a
callback, is yours to stop — and, the other way round, a timer the app arms
because your mount dispatched a `window` event it listens for is taken away
with your pane, so reach the app through `ctx` rather than through the
document. Two things it enforces rather than trusts — write
outside `el` and the app repairs the structure (nodes you added out there are
removed, nodes you removed are put back), stops the kind and shows a card
instead of your pane, and a `mount` promise that neither settles nor draws for
five seconds becomes a card naming the stall rather than a pane that stays
blank. Read that first one as a backstop, not a licence: it restores the shape
of the document, not an attribute, text node or inline style you overwrote in
place, and nothing at all that wasn't the DOM. `el` stays the same element across redraws while your `innerHTML`
replaces its children, so wire clicks as one delegated listener on `el`, not
on children that vanish with the next draw. `ctx.setState({ color, label })`
lights the dot in the header — `color` is any CSS color; `null` keeps it
quiet.

**Layout is your job.** `el` is a plain flow container inside the dashboard's
own centred column; the app draws the head and the width, and stops there. The
roster carries no layout primitives beyond its two grids (`dash-metrics` and
`dash-cards`) — anything spatial past that is your bundle's own CSS, shipped
as the manifest's `style`, and so is behaviour at narrow widths, since nothing
reflows a kind for you. Positioned children deserve particular care: absolute
placement lets two of them overlap, and the one on top swallows clicks meant
for the one underneath, so a delegated handler just stops firing for that
element with nothing in the UI to say why. If you place by coordinate, make
collisions impossible — stack into sub-rows, nudge, or fall back to flow —
rather than trusting the data to stay sparse.

**The app is dark, and there is no light theme to design for.** There is one
screen palette, the dark one; nothing at runtime switches it, so a kind does
not need a light variant, a toggle, or a `prefers-color-scheme` block — that
last one is not "unsupported" so much as inert, since the app's own colours
never answer it. What you do need is to take your colours from the app rather
than from your own hexes: render through `ctx.css` and, for your bundle's own
stylesheet, `var(--text-2)`, `var(--border)`, `var(--bg-panel)` and the rest of
the tokens. Two payoffs. Your board keeps matching the app when a token moves,
instead of being the one pane that stayed the old grey. And it is the only way
a kind survives the one ground that genuinely does invert: a printed board
renders on paper, where those same tokens remap to ink on white. A hard-coded
`#e8e8ea` is legible on screen and invisible on the page. For colour with
meaning use `ctx.accents` — put a name from that roster on `data-accent` and
the app resolves the hue for both grounds.

Beyond `notes()` (whose optional argument is a plain predicate:
`ctx.notes((n) => n.props.type === "gear")`), ctx gives you `read(path)`,
`sheet(title)` (a parsed,
evaluated sheet fence — it resolves `{ model, ev }`, and the rows you draw are
`ev.rows`, positional against `ev.headers`, never `sheet.rows`), `create(…)`, `openNote(path)`, `toast(msg, action?)`
and the two writes. **Writes take a compare-and-swap guard and it isn't
optional** — `setProp(path, key, value, expected)` and
`writeBody(path, body, expectedBody)` refuse rather than overwrite when the
note changed since you read it; the refusal is a rejected promise, so catch
it, toast, and redraw from a fresh read. Check before calling anything you're
not sure
this build has (`if (ctx.sheet) …`): ctx gains members without bumping `api`.

A note's frontmatter reaches you as `props`, and nothing is promised about
what is in it: the values are unknown-typed, whatever that note's YAML parsed
to, so coerce before you compare. `Number(n.props.bpm) > 128`, not
`n.props.bpm > 128` — the second one silently does a string comparison the day
a note writes its tempo in quotes, and draws a wrong board rather than an
error.

**The read doors past your notes.** Three more members hand a kind the same
data the built-in surfaces draw from, and none of them writes. `ctx.mounts()`
resolves the mount roster — every folder the vault watches, each with its
bound path, whether it is missing here, when it was last scanned and how many
files the index remembers — and `ctx.mountRows(name)` resolves one mount's
last-known rows by name (folded, so the spelling in your bundle and the
spelling in the picker are one thing). A name no mount carries rejects by
name; so does a mount whose index will not read, with the reason, because an
unplugged drive answering as an empty folder is a board drawing "0 files" over
a shelf that is only unplugged. The verbs stay out: no bind, no rescan, no
annotate — those live behind the app's own surfaces, where the folder picker
and the consent for touching disk are.

`ctx.view(name)` evaluates a saved view — a pin — through the app's own
evaluator, the one the database pane paints and the headless reader prints. So
a board that wants "the open tasks" asks for the pin by name and gets the rows
the user sees in the table beside it, in the same order, with the cells
rendered the same way, rather than re-implementing membership, the filter
grammar and the sort and getting three chances to disagree. What comes back is
a `substrate.view/1` table: `columns`, `total`, `rows` (each with `title`,
`path` and a `cells` map keyed by column), and `groups` when the view sections
— the pin's own grouping, or its database's when the pin captured none, the
same composition the pane makes, so your sections and the app's are the same
sections. A name no pin carries rejects by name; a folded name two pins share
answers with the first.

`ctx.schema()` is the vault's databases and their registered properties —
names, kinds, select options, a relation's target, a number's format, an entry
hint where there is one. It is synchronous, since the app already holds it. A
kindless property that has options reads as `"select"`, the way every app
surface spells it; the reserved `icon`/`home`/`parent` keys are not properties
and do not appear. Use it to draw a picker whose values match the ones the
table offers, instead of hard-coding a list that goes stale the first time
someone adds a status.

**There is no `ctx.move`, and that is deliberate.** Renaming or moving a note
is not a write — it is a fan-out across wiki-links, sidebar pins, shortcut
keys, saved-view sort and filter keys, relation values and folder metadata,
and it only holds together with one caller inside the app, where undo, open
editors and index invalidation are in reach. A second caller in vault code
would either skip that repair or duplicate it, and a half-repaired rename is
worse than none. A kind that wants a note moved asks the person:
`ctx.openNote(path)` and a `ctx.toast(msg, action)` that takes them there.
`kind-api.d.ts` states this in the contract too, so the absence reads as a
decision rather than a gap.

**You can have the whole contract as types.**
[`kind-api.d.ts`](kind-api.d.ts) declares `mount`, every ctx member and
everything ctx hands back. Copy it next to your `index.js` — the declarations
are global, so an editor with TypeScript picks it up for a plain `.js` file
with no import and no config — and annotate the export:

```js
/** @type {SubstrateKind} */
export default {
  mount(el, ctx) { /* ctx.sheet(…), ctx.css[…], … all complete now */ },
};
```

Nothing about it is a dependency: it never runs, the app never reads it, and a
bundle that ships without it behaves identically. What it buys is the class of
mistake this page can only warn about — `sheet.rows` for `ev.rows`, a class
name off the roster, a write missing its guard — caught while you type instead
of on a blank pane. It cannot go stale, either: the app asserts against these
declarations in its own typecheck, so a ctx member that changed shape fails
the build until the published file agrees.

**A second pass, using more of the roster.** The thirteen names in `ctx.css`
are a vocabulary of objects, not a layout system, and most of them want a
particular element under them. A rundown that reads like the rest of the app:

```js
el.innerHTML = `
  <div class="${ctx.css["dash-section-label"]}">By room</div>
  <table class="${ctx.css["dash-table"]}">
    <thead><tr><th>Piece</th><th>Room</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="${ctx.css["dash-foot"]}">${gear.length} logged</div>

  <div class="${ctx.css["dash-cards"]}">
    <div class="${ctx.css["dash-card"]}" data-accent="teal">
      <div class="${ctx.css["dash-label"]}">Studio</div>
      <div class="${ctx.css["dash-metric-sub"]}">${studio.length} pieces</div>
    </div>
  </div>`;
```

`dash-section-label` is a self-decorating heading — it draws its own trailing
hairline, so a rule of your own beneath it doubles the line. `dash-table` wants
a real `<table>`: `th` and `td` are what carry the styling, and the first cell
of each row reads quieter on purpose, which is why the name column goes first.
`dash-foot` is the quiet closing line under a block. `dash-cards` is the second
grid and `dash-card` its tile — the one class `data-accent` is wired on, and
the accent reaches the card's `dash-label`. Two more that are easy to swap:
`dash-value` is styled only inside a `dash-metric`, and `dash-metric-sub` is
the sub-line inside a tile or card while `dash-sub` is the page-level subtitle
under a heading. `dash-link` is a link-looking reset for a `<button>`, so use
it on a button and keep the keyboard behaviour.

**Enabling it is a deliberate act.** A kind runs with the same access as
Substrate itself — there is no sandbox — so a bundle does nothing until you
enable it for this vault on this device, after reading its title, description
and author. Consent is pinned to a hash of the bundle's bytes: if the code
changes, the kind stops and asks again, which is what keeps a synced folder
from delivering new code into an already-trusted slot. A second device asks
you again on purpose. A bundle that can't run — broken manifest, wrong api,
not enabled yet — shows a card saying which and why; it never silently falls
back to another renderer.

**iOS syncs custom kinds but does not run them.** The `substrate-kind:` URI
scheme a bundle loads over is registered on every target except iOS
(`#[cfg(not(target_os = "ios"))]`, `src-tauri/src/lib.rs:888`), so the folder
and its consent record ride sync to the phone intact while nothing there can
serve the module: the frontend still builds the same
`substrate-kind://localhost/…` URL (`src/lib/kindpane.ts:317-325` — no iOS
branch), the import finds no handler, and the pane fails to load rather than
drawing your board. This is the state of the first TestFlight build, not a
permanent design call.

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

**Settings → Vault** is the standing view: every bundle this vault has,
what state it is in here, the rider (editable for a kind that is currently
running), and *disable*. Disabling withdraws consent only — the folder, its
files and its history stay exactly where they were, and re-enabling is the
same review again. The button is there whenever this device holds a consent
record, including for a kind that has since become unrunnable, which is
precisely when you most want to withdraw it.

### The author's loop

Nothing above says how a folder you just wrote becomes a pane you can look at,
and that is the shortest way to lose an afternoon. The whole path is four
steps, all inside the running app:

1. Write the folder at `.vault/kinds/<id>/` in the vault you have open —
   `kind.json`, your entry file, an optional stylesheet.
2. Point a note at it: `dashboard: <id>` in the frontmatter, exactly as for a
   built-in kind.
3. Open that note. Because the kind isn't consented to yet, the review lands
   *in place of the body*, listing the files it covers.
4. Press Enable. The pane mounts there and then — no relaunch, no reopen.

Iterating is the same loop with one setting. Every save changes the bundle's
bytes, so the hash the consent is pinned to no longer matches and the kind stops
and asks again — safe, and unbearable at the pace you edit code. The **trust
updates to this kind** rider on that second review is the escape: tick it once
and later saves re-enable themselves and the pane re-mounts on the new bytes.
There is no stale-module trap under this; the module URL carries the bundle
hash, so new bytes are a new URL and the old code cannot be served back to you.

One thing to know because it is invisible: `.vault/` is not watched the way
your notes are, so writing a bundle does not by itself tell the app the folder
changed. The list is re-read when the vault changes, when a consent is written
(enabling, disabling, an auto-re-enable), or at app start. If a freshly written
bundle isn't showing, touch a note or reopen the vault rather than assuming the
manifest is wrong.

Debugging is the webview console plus the cards the host draws for you. A
`mount` that throws, or an entry file that fails to import, replaces the body
with a card naming the kind and the file — it never goes blank and never falls
back to another renderer. What the cards cannot catch is anything that throws
*after* mount returns: a timer, a promise you didn't await, a listener. Those
reach the console only, so handle your own rejections and put the message
somewhere you'll see it — `ctx.toast(msg)` or `ctx.setState({ label })`.

If you are working in the Substrate repo rather than a vault, there is a
faster lane: the browser mock. `npm run dev`, then from the console
`window.__mockWriteKind({ id, manifest, files, enabled: true })` stages the
same row the real loader would, hashed over the same bytes, and the pane
imports your module through a blob URL. `e2e/customkind.spec.ts` is the worked
example, including the failure states. What it does **not** exercise is the
part that only exists in the app: the `substrate-kind:` scheme the real pane
loads over, the consent record on disk, and the CSP that gates both. A kind
that works in the mock lane is a kind whose code works; it is not yet a kind
you have seen run.

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

A dashboard you'd rather not see in that list takes `sidebar: false` in its
frontmatter (the string `"false"` works too). It keeps no sidebar row — section
or tree — and loses nothing else: it still opens from a workbook tab, a
wikilink, search and the folder tree, and deleting the prop brings the row back.
Pinning is the one exception: a pinned hidden dashboard keeps its pin row,
nested under its folder like any other pinned note — the pin was your explicit
ask, so the opt-out doesn't eat it.
That's how a hub dashboard whose tabs already carry its sub-dashboards shows up
as one row instead of a stack of them. If hiding leaves a subfolder group with a
single visible dashboard, that one renders as a flat row rather than a group
with one member; hiding nothing leaves your one-dashboard folders alone.
