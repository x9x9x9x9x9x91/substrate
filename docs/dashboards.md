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
(SUB-676) prints the live pane as designed — a workbook's *active* page, not
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

`format`: `eur` | `usd` | `number` | `pct`; optional `digits`. A bind must name a
**summary** (an aggregate line), not a column. `emph: true` marks a card as one
of the board's anchors — at most two stay sharp, everything else sinks to the
quiet voice (design principle 11). `FX("USD","EUR")` in formulas uses a
live rate cached on the sheet's own `fx_rate`/`fx_date` props.

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
and never breaks the others.

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
gray; SUB-952 carries the categorical-palette call under SUB-932. Stacked bars
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

### `hub` — a designed home page

The body stays ordinary markdown; the renderer lays it out. `## ` headings become
section labels, a run of consecutive callouts (no blank lines between them)
becomes a side-by-side card row, and ` ```view ` fences embed live database
tables between them.

````markdown
---
type: dashboard
dashboard: hub
---


## Now

> [!note] Studio
> Mixdown pass on [[Vessel]] this week.
> [!warn] Deadline
> Master delivery due Friday.
> [!idea] Later
> Try the granular chain on the outro.


## Releases in flight

```view
type: release
query: status:mastering
view: table
sort: released:desc
limit: 5
columns: status, artist
```
````

A fence's `sort:`, `limit:` and `columns:` keys are all optional (SUB-942).
`sort: <prop>` / `<prop>:desc` orders by the database table's own rules
(declared select order, numeric numbers, chronological dates); `limit: N` cuts
AFTER the query and the sort, so the pair above means "the five newest"; and
`columns:` picks and orders the columns explicitly, matched case-insensitively.
When rows are cut the table says so honestly — "5 of 23 rows — this view's
limit" for your own `limit:`, "open the database for the rest" when the
surface's safety cap is what clipped it. An unknown key or a malformed value
renders a quiet error card in place of that one table, never taking the rest of
the page down. Full key list: `docs/vault-format.md` §5.6.


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
`stale · <age>` instead of the item count (SUB-699); anything unparseable
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

Reads every `type: task` note in the vault (SUB-786, reshaped in SUB-870). The
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
still drives the secondary chips: a task past the stale threshold reads
`stale`, one with no `created:` at all reads `undated`. Those are diagnostics,
never a row's reason for being on the board — and pinned Now rows carry none,
since they're already chosen.

Config is the dashboard note's own frontmatter, all optional:

| prop | meaning |
| --- | --- |
| `areas` | area allowlist — comma-separated or a YAML list. Omit for every area; tasks without an `area:` group under Unassigned. |
| `stale_days` | whole days before age alone chips a task (default 30). |

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
body content: ` ```chart ` fences → charts, otherwise the yield tracker. A key
that *is* written but isn't a kind this build knows renders a small card naming
it and listing the kinds that exist (SUB-993) — a typo shows you the typo,
rather than quietly handing you a different dashboard.


## Workbook pages — tabs at the bottom (SUB-464)

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
current theme instead of inventing a second look. `ctx.onChange` is the redraw
signal — `mount` runs once, and the returned function is your cleanup on
unmount. `ctx.setState({ color, label })` lights the dot in the header;
`null` keeps it quiet.

Beyond `notes()`, ctx gives you `read(path)`, `sheet(title)` (a parsed,
evaluated sheet fence), `create(…)`, `openNote(path)`, `toast(msg, action?)`
and the two writes. **Writes take a compare-and-swap guard and it isn't
optional** — `setProp(path, key, value, expected)` and
`writeBody(path, body, expectedBody)` refuse rather than overwrite when the
note changed since you read it. Check before calling anything you're not sure
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

Full contract, including the manifest grammar, the hash layout and every ctx
member: [vault-format.md §5.8](vault-format.md).

## Creating one in-app

New note (⌘N or the palette), then add the props — set “Database” to `dashboard`
and add a `dashboard` prop with the kind. The sidebar's Dashboards section lists
every `type: dashboard` note. Since dashboards are files, an external tool or
agent can also just write them into the vault; the watcher picks them up live.
