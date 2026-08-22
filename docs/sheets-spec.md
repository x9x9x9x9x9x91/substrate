# Sheets — formula tables

The pieces: formula engine `src/lib/formula.ts`, sheet model `src/lib/sheet.ts`
(both tested via `npm test`), grid view `src/components/SheetGrid.tsx` (wired into
`NotePane` for `type: sheet` notes), metrics renderer `src/components/MetricsDashboard.tsx`
(dispatched from `DashboardPane` on `dashboard: metrics`).
v2 added cross-sheet references in the engine, and formula rename/edit from
the grid header. A later version added date arithmetic (`date ± days`, `date − date`) and
the volatile `TODAY()`.

Goal: spreadsheet-portfolio-tracker-class tables inside Vault — sum and math over rows, and
dashboards that read the results. Not Excel: no A1 cell grid, no cell-level formulas.
Column-and-aggregate formulas only (Notion-formula-column semantics), which covers the
real reference workbook (its Dashboard sheet is SUMIFS/IFERROR over a Holdings table).

## Storage — plain text in the note, like dashboard snapshots

A sheet is a note with `type: sheet`. Data + formulas live in fences in the body:

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

total       = SUM(value_eur)
crypto      = SUMIF(bucket, "crypto", value_eur)
etf         = SUMIF(bucket, "etf", value_eur)
```
````

- Lines with a bare name referencing column names → computed column (per row).
- Lines whose right side uses aggregate functions → named summary values. The
  one exception is a `LOOKUP` whose key is row-shaped: it evaluates per row, so
  its line stays a computed column (below).
- A right side referencing nothing row-shaped is a summary too — that includes a
  bare constant (`ceiling = 25000`) or constant arithmetic (`annual = 2500 * 12`):
  one named value in the summary bar, never repeated down the rows.
  Row scope stays data and computed columns only, so a per-row formula can't
  reference a constant by name — inline the literal there.
- **Blank lines group the fence, and the summary bar reads that grouping
**: lines separated by a blank line form blocks, and the FIRST block
  holding summaries is the sheet's headline — the numbers the bar shows at a
  glance. Every later block collapses behind one `show all (N)` toggle, closed
  by default, so a finance sheet's helpers and intermediates stop competing with
  its totals. The example above is the canonical shape: computed columns, blank
  line, totals — and because the headline is the first *summary-bearing* block,
  not simply the first block, those totals headline exactly as they did before.
  Consequences worth knowing when writing a fence:
  - A fence with no blank lines is one block: everything is headline, nothing
    collapses, no toggle appears. Existing sheets don't change.
  - A run of blank lines is one separator, and blanks above the first formula
    line belong to the first block — an empty block can't exist.
  - Comments (`#`) and unparsable lines never open or break a block.
  - Grouping is presentation only. It changes nothing about evaluation,
    classification, dashboard bindings or cross-sheet references — a summary in
    a collapsed block is bindable exactly like one in the headline.
- Everything greppable, diffable, agent-writable, syncable. The grid UI is a view.

## Formula language v1

- Arithmetic `+ - * / ( )`, comparisons, string literals.
- Row scope: any data or computed column by name.
- **Identifiers are unicode letters**: a name starts with a letter in
  any script or `_`, then letters, combining marks, digits and `_` — so `Größe`,
  `märz_total` and `价格` are referenceable, not just ASCII. Names still fold
  case-insensitively (`Größe` == `größe`), and a digit still can't start a name
  (a column called `2024` remains unreferenceable).
- **Names fold case-insensitively, and a fold collision is an error**:
  `price` and `PRICE` are the same name, so a sheet where two *different* names
  fold onto one has no honest answer for what that name means. In earlier versions
  the later binding silently won — `x = price * 2` over a `price,PRICE,units`
  CSV computed off the second column and `SUM(price)` returned its total, with
  no error anywhere. Three shapes collide, all same-sheet: two data columns,
  two formula lines (`total` + `TOTAL`), and a formula named like a data
  column. All three are reported the same way, and the engine never picks a
  winner:
  - `parseSheet` lists one message per folded name in `SheetModel.errors`
    (`two columns fold to “price” — rename one`), so the grid shows the
    collision next to the unparsable-formula errors it already surfaces —
    the sheet still loads and every data cell still renders.
  - Every *reference* to an ambiguous name evaluates to that same message, in
    row scope and summary scope alike, including as an aggregate's column
    argument and as a row-scoped LOOKUP's table column. A formula line whose
    own name is ambiguous carries the error as its value, since nothing can
    address it unambiguously — and it does not bind itself, so a later line
    can't overwrite the ambiguity it caused.
  - Blank headers take part in nothing; reusing one name in different casings
    (`Price` declared, `PRICE` referenced) is not a collision — that is the
    case-insensitive lookup working as designed.
  - Cross-sheet member precedence (summary > computed > data, below) is
    unchanged: it resolves one name across *kinds* on another sheet, and a
    same-sheet name that holds two kinds is a collision on that
    sheet rather than a silent pick.
- Aggregates: `SUM, AVG, MIN, MAX, COUNT, SUMIF(col, match, valueCol), COUNTIF`,
  `SUMPRODUCT(colA, colB, …)`, `LAST(col)`.
- **`SUMPRODUCT(colA, colB, …)`** multiplies the argument columns
  row by row and sums the products, so a €-weighted average is one summary line
  instead of a helper column: `avg_price = SUMPRODUCT(price, value_eur) /
  SUMPRODUCT(value_eur)`. Any number of columns compose; a single column is just
  `SUM(col)`. Coercion follows Excel rather than the skip rule the other
  aggregates use: a row whose cells aren't *all* numeric contributes 0 — a blank
  weight means "no weight", and because the row drops out of numerator and
  denominator alike, the weighted-average idiom stays honest. Numeric strings
  parse strictly, so `"1e3"` is text and zeroes its row. Error cells
  propagate like every other aggregate, from any argument and any position.
  Columns must all be the same length — a mismatch is an error, never a silent
  truncation to the shortest column, because money math must not quietly drop
  rows.
- **SUMIF/COUNTIF comparison criteria**: the match argument may be a
  string starting with `>=`, `<=`, `<>`, `>` or `<` — `COUNTIF(score, ">=1")`,
  `SUMIF(score, "<5", cost)`, `COUNTIF(score, "<>0")` — so a risk bucket is one
  line instead of an enumeration of `score_1 … score_10` (which broke on 0 and
  decimal scores). Excel semantics: `>=`/`<=` include the boundary, `>`/`<`
  don't. A numeric operand (`">=1"`) compares numerically; a non-numeric one
  (`">=delta"`) compares as case-insensitive text. Blank cells never satisfy a
  comparison — including `<>` — matching the ordering-comparison rule elsewhere
  in the language. A numeric comparator over a cell that isn't a
  number is an error, not a silent skip; so is a criteria with no operand
  (`">="`). Any other match value — numbers, booleans, and strings that don't
  start with a comparator — keeps exact-match behaviour unchanged, so a literal
  cell like `"a>b"` still matches exactly.
- **SUMIF/COUNTIF wildcard criteria**: an exact-match *string* may use
  Excel's wildcards — `*` for any run of characters (including none) and `?` for
  exactly one — so `COUNTIF(type, "ETF*")` counts every `ETF …` row and
  `COUNTIF(code, "a?b")` matches `axb` but neither `ab` nor `aXXb`. `~` escapes:
  `~*`, `~?` and `~~` are a literal star, question mark and tilde. Matching is
  case-insensitive, like every other exact match (`"etf*"` ≡ `"ETF*"`), and blank
  cells never match — not even `"*"` — following the blanks-don't-match rule the
  rest of the language uses. Wildcards live only on the exact-match
  path: comparison criteria (`">=1"`) parse first and are untouched, and
  every added `(column, match)` pair gets identical treatment.
  A match string with no unescaped `*`/`?` keeps exact-match behaviour verbatim,
  numeric loose equality included. The tradeoff: a match string that *does*
  contain one is now a pattern, so `"a*b"` — which previously matched only the
  literal cell `a*b` — also matches `aXb`. That is Excel's behaviour and is
  intended; write `"a~*b"` when the literal star is what you mean.
- `COUNTIF(x, "")` returns 0 over blank cells, because blanks never match `""`
; Excel counts blanks there. Use a comparison criteria or a computed
  flag column when you need a blank count.
- **SUMIF/COUNTIF multiple criteria**: extra `(column, match)` pairs
  append after the existing arguments — `COUNTIF(bucket, "etf", net_worth,
  "yes")`, `SUMIF(bucket, "etf", value_eur, net_worth, "yes")` — and a row must
  satisfy **every** pair to be counted or summed (AND, never OR). Each added
  match takes the same values as the first, comparison criteria included:
  `COUNTIF(bucket, "etf", score, ">=1")`. This removes the pre-filtering that a
  single criterion forced (a Finance sheet keeping only `Net Worth? = Yes` rows,
  where a later `No` row would have been silently counted).
  The extended `SUMIF` form always spells the value column, so the pair sequence
  starts at a fixed position: `SUMIF(criteriaCol, match, valueCol, col2, m2, …)`
  — pass the criteria column itself as `valueCol` when summing it. Chosen over
  an Excel-style `SUMIFS(sumCol, col1, m1, …)` alias because it keeps one
  function name and leaves every existing formula reading identically.
  An odd, unpaired trailing column is an arity error, and `SUMIF(col)` /
  `COUNTIF(col)` with no match keeps erroring as before. Criteria columns of
  different lengths are an error too, rather than a silent truncation — there is
  no honest row-by-row reading of a short column. The value column obeys the
  same rule: rows pair off criteria against values, so a value
  column of another length — reachable via a cross-sheet reference — errors
  instead of silently reading its overhang as blank rows that sum to 0.
  Computed columns work as criteria columns anywhere, since they are ordinary
  scope columns.
- `LAST(col)` returns the last non-empty cell in stored row order (not the sorted
  view), as-is — number, string, date, no coercion. Empty follows the cell-typing
  convention: nulls and blank/whitespace-only strings are skipped; error cells
  propagate like every other aggregate; an all-empty column is an error, like MAX
  over an empty set. Works over data and computed columns, so a snapshot sheet
  (rows appended over time) reads its most recent row: `latest = LAST(total)`.
- **`LOOKUP(key, keyColumn, valueColumn)`**: the first row whose
  `keyColumn` matches `key`, that row's `valueColumn` cell, returned as-is (no
  coercion). Matching is the language's usual loose equality — numeric keys
  compare numerically, text case-insensitively — so `LOOKUP("usd", code, rate)`
  and `LOOKUP(2025, year, budget)` both work. "First" means stored row order,
  not the sorted view; duplicate keys are a data smell in your table, not an
  error — the earliest row simply wins. Either column may be a data or a
  computed column. A blank key cell never matches, and a
  blank `key` argument is an error. A miss is an **error**, never `0` or blank —
  same for a matched row whose value cell is empty — because a rates table that
  silently reads as zero is a money bug, not a gap. Combined with cross-sheet
  refs this is the FX shape: one `Rates` sheet, and one line pulls its rate —
  `usd_rate = LOOKUP("USD", Rates.code, Rates.rate)` — so an FX change is one
  edit in one table instead of an inlined rate per row.
  **Row scope vs summary scope**: the *key* argument decides which
  one a LOOKUP line is. A key that reads nothing row-shaped — a constant or an
  earlier summary — keeps the summary shape: the line is a **summary** and its
  result lives in the summary bar (`usd_rate = LOOKUP("USD", …)`). A key that
  is row-shaped — a data column or an earlier computed column of this sheet —
  makes the line a **computed column** instead, and the LOOKUP runs once per
  row against that row's own key cell:
  `eur = price_usd * LOOKUP(currency, Rates.code, Rates.rate)` converts every
  row at its own currency's rate. Only the key flips classification; the
  `keyColumn` and `valueColumn` arguments stay whole-column table refs either
  way, including for a table living on the same sheet (`LOOKUP(cur, code,
  rate)` reads the whole `code`/`rate` columns while `cur` reads this row).
  Everything else is unchanged: first match in stored order, blank key cell
  never matches, and a miss or an empty value cell is an error — per the row
  convention that error lands in *that* row's cell only, leaving the rest of
  the column intact. Any real aggregate elsewhere on the line (`SUM(eur) *
  LOOKUP(currency, …)`) still makes it a summary.
- `IF(cond, a, b)`, `ROUND(x, n)`.
- `FX(from, to)` → cached frankfurter rate (same cache as dashboards).
- Date arithmetic on ISO day cells and volatile `TODAY()` — see the dates
  section below.

## v2 — cross-sheet references

- `SheetName.member` references another `type: sheet` note, resolved by title/stem
  (case-insensitive). Sheet names with spaces use quotes: `"Portfolio Tracker".total`.
- A member resolves summary first, then computed column, then data column — same
  precedence as a sheet's own summary scope. Summaries bind as scalars (usable in row
  and summary scope), columns bind as whole columns (usable inside aggregates);
  a whole column used as a single value is an error, like local columns.
- Classification: a formula line that references nothing row-shaped (only earlier
  summaries and/or cross-sheet values) is a summary, so
  `grand_total = total + Cash.cash_total` lands in the summary bar and is bindable
  from dashboards. The same rule covers a right side with no references at all
: `ceiling = 25000` is a summary — a single named value, bindable from
  dashboards (`{{Holdings.ceiling}}`) and other sheets, instead of a computed
  column repeating the constant on every row.
- Cycles (A → B → A, or a sheet referencing itself by name) are detected per
  evaluation network and become scoped errors (`circular sheet reference: a → b → a`)
  that propagate through dependent formulas Excel-style — no hangs.
- Missing sheets/members resolve to error values the same way.
- The grid and metrics dashboards load referenced sheets lazily by name
  (dashboards load the transitive closure) and re-load on vault changes.

## Dates and TODAY()

Date cells are ISO day strings (`2026-07-17`), the vault's date format. In `+`
and `-` they act as dates on the local-day calendar — `src/lib/dates.ts` does
the math on y/m/d components, so no UTC-midnight/DST drift:

- `date + days` / `date - days` → date (ISO string); `days + date` commutes.
  A fractional day count truncates toward zero — day math has no time
  component to carry a fraction. Blank cells count as 0, as in numeric
  arithmetic.
- `date − date` → signed whole days (number).
- Errors follow engine conventions: `date + date`, `number − date`, and a
  non-numeric day count are formula errors; `*`/`/` on a date error as
  "not a number". Date-shaped text that isn't ISO (`2026-7-17`) stays text
  and errors the same way.
- Comparisons need no special case: ISO days order lexicographically, which
  is chronological — `bought < "2026-01-01"` just works.

`TODAY()` (no arguments) returns the current local day as an ISO string and
composes with the arithmetic: a Days-Held column is `TODAY() - bought`, days
since year start is `TODAY() - "2026-01-01"`.

**Re-evaluation rule (volatile):** the engine holds no state across
evaluations — computed values are never persisted and the cross-sheet cache
lives for one `evaluateSheet` call only — so `TODAY()` is recomputed every
time the sheet is evaluated: on sheet (re)load and on any edit (an edit
re-evaluates the whole sheet). It is never frozen at first compute. The one
thing it does NOT do is tick on its own: an open, idle sheet has no midnight
timer (unlike the Today/Calendar panes), so a sheet left open across midnight
keeps showing the previous day until the next reload or edit.

Classification note: a line whose right side is `TODAY()` alone references
nothing row-shaped, so under the v2 rule it lands as a per-row computed
column (same value on every row), not a dashboard-bindable summary. Derive
summaries from rows or other summaries instead, e.g. `avg_held =
AVG(days_held)`.

## Time travel — reading other notes, and reading them as of a past day

Two functions read the vault outside this sheet, one of them outside today.
Full design in the time-travel query spec.

- `PROP(<note path>, <key>)` → one frontmatter value on another note, as a
  scalar, in the present tense: `PROP("Assets/BTC.md", "price")`.
- `AT(<date>, <value>)` → that value as it stood at the **end of** that local
  day: `AT("2026-01-31", PROP("Assets/BTC.md", "price"))`. The date is an ISO
  day or `TODAY()`, and is itself read in the present tense.

`AT` binds by wrapping the resolver its body reads facts through, so nothing
inside the body needs to know which tense it is in, and a nested `AT` just
wraps again — the innermost one wins, the way reading it aloud suggests. What
can be read in the past tense is `PROP()` and another sheet's member
(`AT("2026-01-31", Holdings.total)`, which re-evaluates that sheet as it stood
that day); reading a *column of this sheet* at a past date is not a thing this
slice does, and says so rather than quietly answering with today's number.

Three answers are deliberately distinct, because rendering the third as blank
would be a lie:

- **a value** — the fact was written and had this value at that instant;
- **blank** — the vault had history covering that day, but the key wasn't
  written yet (or was empty), which is the same blank the present tense gives;
- **`no history before <day>`** — the day is older than the oldest surviving
  snapshot, so the value is *unknowable*. Snapshots get trimmed; the answer
  never falls back to the oldest surviving value, which would silently invent a
  flat line reaching back forever.

The past is reached **through today's note**: a path is resolved against the
vault as it stands now, so `PROP()` follows a note that has been *renamed*
(the lane follows the rename through git) but reports a note that has been
*deleted* as no such note, even though its lane survives in history. That is
this slice's boundary, not a claim that the value is unknowable — asking about
a deleted note's past means restoring it first.

Money converts at **today's** rate, not that day's: `AT()` re-reads the past
values, and `FX()` stamps them with the rate the sheet is being read at. A
sheet's FX stamp therefore says what it always says — the rate used now.

Cost: the repository is opened once per prefetch batch and the oldest-snapshot
boundary walked once, but each fact then costs its own path walk back through
the commit graph — N facts, N walks, including two keys on the same note. Only
the snapshots that actually touched a note are read, so a lane never reads a
blob per commit. Answers are cached per (note, key) for as long as the vault
doesn't change; two sheets on one pane share that cache. A dashboard mixing a
chart and an embedded sheet currently prefetches through two separate paths
(the pane's history store and the dashboard's own sheet cache), so those two
do *not* share a batch — same answers, fetched twice.
`AT(date, Sheet.member)` walks whole sheet trees at those days instead, one
walk per day.

Charts plot a fact's whole history with a `history:` fence rather than a chain
of `AT()` cells — `docs/dashboards.md` → `charts`.

## Notifications — date columns that fire

A sheet's date column can raise the same notification a database date prop
does. A sheet has no schema, so the setting lives in the note's own
frontmatter, under a `columns:` map keyed by header name — the on-disk shape,
folding rules and notification-state key grammar are specified in
`docs/vault-format.md` §5.1 and `.vault/notifications.json`; don't duplicate
them here. What matters at sheet level:

- **Per column, not per cell.** Turning `Renewal` on means every dated cell in
  that column fires; cells that aren't dates are ignored, so a mixed column is
  fine. `notify: true` fires on the day, `notifyBefore: n` fires `n` days ahead
  as well, and the two are independent alerts of one date.
- **A row is its first cell.** The alert names the row by its label (the
  leftmost column's value) and the notification state keys on it, so sorting,
  inserting and deleting rows never mis-fires; renaming a label reads as a new
  row. A row with a blank label stays quiet — it has nothing to be called.
- **The column menu** (header ▾ → Notify…) writes the setting: off, on the day,
  N days before, or both. It only offers the drill-in when the column looks
  dated or is already firing, so the menu stays short on a sheet of text.
- **Clicking the notification opens the sheet at that cell** — the app resolves
  the row by its label at click time and scrolls the cell into view; if the row
  or column is gone by then, the note still opens and nothing is selected.

## UI

- Sheet notes open as a grid (like the DB list pane but real columns): editable data
  cells, computed columns read-only (dimmed), summary bar pinned below with the named
  aggregates. Tab/arrow navigation, Enter to edit. Add row/column inline.
- **The summary bar is ranked, not a wrap.** Three rules, all of them
  hierarchy through size, weight and spacing — the bar adds no color of its own:
  - **Two tiers.** The headline block (above) renders larger; `show all (N)`
    opens a second, quieter row with everything else. The toggle only exists
    when something is actually hidden.
  - **One chip per shared cause.** Summaries that failed carrying the *same*
    engine message came from one root cause — a name collision, a broken
    upstream ref — so the bar says it once: the message, then `broke N
    summaries`, expanding to the individual chips on click. That message
    already names the culprit, which is the attribution; when failures share
    nothing but failing, two or more of them collapse into one untargeted
    `N summaries failed` chip instead. A lone failure stays a normal chip in
    place, where its own name is the useful part.
  - **The `USD→EUR …` stamp renders only on sheets that call `FX()`**, asked of
    the sheet's own formula lines. A cross-sheet total converted elsewhere
    carries its rate on the sheet that did the converting, next to the line
    that did it.
- **Totals row**: a row pinned under the data rows, one cell per
  column. The pin is conditional: a row taller than a third of the
  scrollport lets go and becomes the table's last row again, so totals can
  never hide the data rows they summarize. A named summary whose formula's row-shaped references resolve to
  exactly one data or computed column renders in that column's cell — muted
  name over value — so `monthly_total = SUM(monthly_eur)` sits under
  `monthly_eur`. A filtered sum describes the column it *sums*, not the column
  it filters on: `open_eur = SUMIF(status, "open", value_eur)` sits
  under `value_eur`, because the criteria are a modifier on the number rather
  than what the number is about. `COUNTIF` counts rows, so it keeps sitting
  under the column it filters. Everything the rule can't place (several
  columns, a cross-sheet total, a bare constant, an ambiguous name) stays in
  the footer. Several summaries over one column stack in that cell in fence
  order, up to three per column — past the cap the rest join the footer
  chips, so the footer holds both the unplaceable and the overflow.
  Clicking an empty cell opens a `name = formula` editor with Sum/Avg/Min/Max/
  Count quick-picks. Sum/Avg/Min/Max prefill `name = FN(column)`. Count is
  value-aware: a column with non-blank, non-error values but no numeric cells
  prefills `name = COUNTIF(column, "*")`; numeric, mixed, empty, and error-only
  columns keep `name = COUNT(column)`. The input still accepts the whole language
  (SUMIF, arithmetic, other summaries, cross-sheet refs) — the picks are
  accelerators, not a ceiling. Clicking a filled cell edits that line in place,
  right-click deletes it. Footer chips behave identically, and a "+ summary"
  affordance appends a line. Every write is the same
  `name = expression` line in the ```formulas fence: nothing about the file
  format changes, and a sheet edited in-app stays a plain markdown note.
- **Selection readout**: shift+arrow or shift+click extends a range
  in the grid; its sum, average and count show next to the row/FX meta while
  the range is held. Display only — never written to the note. Blank cells are
  skipped, error cells count as cells but contribute no number, and a range
  with no numbers reports the count alone.
- Computed column headers edit the formula: double-click opens the line in fence form
  (`name = formula`); Enter applies, Esc cancels. A rename rewrites references on
  every other formula line (string literals, function names, and other sheets'
  members stay untouched); name collisions with data columns or other formulas are
  rejected. Writes back to the ```formulas fence like any other edit.
- The source note stays one click away (same pattern as dashboards): the toolbar's
  note icon, **View note source**, swaps the grid for the normal editor over the
  same file, and **← grid** returns. This is the escape hatch out of the grid for
  hand-fixing the ```csv fence or writing body text — it is the only way to reach
  a sheet's text, so it is documented for users in
  [`docs/user/files-and-settings.md`](user/files-and-settings.md). A view fence
  rendered in source mode stays read-only on purpose.

## Dashboards reading sheets

- Metric binding syntax in dashboard notes: `{{Holdings.total}}`, `{{Holdings.crypto}}`.
- A generic `metrics` dashboard renderer: frontmatter lists cards, each bound to a
  sheet summary → the portfolio dashboard becomes: sheet holds rows, dashboard shows
  totals/deltas.
- Charts bind summaries too: a ` ```chart ` fence with
  `series: etf, crypto, cash` instead of `x`/`y` plots those named summaries as
  single-value points, one per name in fence order. So a per-bucket COUNTIF/SUMIF
  set charts as-is — no bucket rows have to be materialized in the sheet to give
  the chart something row-shaped to group. Row binding (`x`/`y`) and summary
  binding (`series`) are exclusive; a name that isn't a numeric summary on that
  sheet errors the chart by name rather than dropping a point. Details in
  `docs/dashboards.md` → `charts`.

## Prose reading sheets — live values

An inline code span of the exact form `` `= expr` `` (`=`, one space, then the
expression) in any note body is a sheet formula, evaluated against the sheets it
names and rendered in the span's place:
`` The label has `= Masters.count` releases. `` Anything else — no space, extra
space, or text that doesn't parse as a formula — stays the literal code span it
is, so prose about spreadsheets is never swallowed. The engine is this one,
unchanged — `parseFormula`/`evaluate` over a scope holding the expression's own
cross-sheet references, loaded through the same `dashboardSheets` cache and
invalidated by the same vault epoch the dashboards use, so a note and a
dashboard reading one sheet share a single evaluation pass. Formatting is
`formatValue`, so a number reads in a sentence exactly as it does in the grid.

Read-only and volatile: an expression never writes, and no answer is ever
persisted. Module: `src/lib/livevalues.ts`; editor decoration in
`src/components/Editor.tsx`. On-disk contract: `docs/vault-format.md` §5.10.

## Build order

1. Formula parser + evaluator (pure TS, tested against a spreadsheet portfolio tracker's semantics).
2. Grid view for `type: sheet` notes (read + cell edit + row add).
3. Summary bar + computed columns.
4. `metrics` dashboard renderer with `{{sheet.name}}` bindings.
