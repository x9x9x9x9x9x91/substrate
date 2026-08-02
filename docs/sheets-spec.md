# Sheets — formula tables

Built in SUB-1: formula engine `src/lib/formula.ts`, sheet model `src/lib/sheet.ts`
(both tested via `npm test`), grid view `src/components/SheetGrid.tsx` (wired into
`NotePane` for `type: sheet` notes), metrics renderer `src/components/MetricsDashboard.tsx`
(dispatched from `DashboardPane` on `dashboard: metrics`).
SUB-44 added v2: cross-sheet references in the engine, and formula rename/edit from
the grid header. SUB-717 added date arithmetic (`date ± days`, `date − date`) and
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
  its line stays a computed column (SUB-748, below).
- A right side referencing nothing row-shaped is a summary too — that includes a
  bare constant (`ceiling = 25000`) or constant arithmetic (`annual = 2500 * 12`):
  one named value in the summary bar, never repeated down the rows (SUB-715).
  Row scope stays data and computed columns only, so a per-row formula can't
  reference a constant by name — inline the literal there.
- Everything greppable, diffable, agent-writable, syncable. The grid UI is a view.

## Formula language v1

- Arithmetic `+ - * / ( )`, comparisons, string literals.
- Row scope: any data or computed column by name.
- **Identifiers are unicode letters (SUB-753)**: a name starts with a letter in
  any script or `_`, then letters, combining marks, digits and `_` — so `Größe`,
  `märz_total` and `价格` are referenceable, not just ASCII. Names still fold
  case-insensitively (`Größe` == `größe`), and a digit still can't start a name
  (a column called `2024` remains unreferenceable).
- **Names fold case-insensitively, and a fold collision is an error (SUB-751)**:
  `price` and `PRICE` are the same name, so a sheet where two *different* names
  fold onto one has no honest answer for what that name means. Before SUB-751
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
    unchanged: it resolves one name across *kinds* on another sheet, and since
    SUB-751 a same-sheet name that holds two kinds is a collision on that
    sheet rather than a silent pick.
- Aggregates: `SUM, AVG, MIN, MAX, COUNT, SUMIF(col, match, valueCol), COUNTIF`,
  `SUMPRODUCT(colA, colB, …)` (SUB-744), `LAST(col)` (SUB-716).
- **`SUMPRODUCT(colA, colB, …)` (SUB-744)** multiplies the argument columns
  row by row and sums the products, so a €-weighted average is one summary line
  instead of a helper column: `avg_price = SUMPRODUCT(price, value_eur) /
  SUMPRODUCT(value_eur)`. Any number of columns compose; a single column is just
  `SUM(col)`. Coercion follows Excel rather than the skip rule the other
  aggregates use: a row whose cells aren't *all* numeric contributes 0 — a blank
  weight means "no weight", and because the row drops out of numerator and
  denominator alike, the weighted-average idiom stays honest. Numeric strings
  parse strictly (SUB-221), so `"1e3"` is text and zeroes its row. Error cells
  propagate like every other aggregate, from any argument and any position.
  Columns must all be the same length — a mismatch is an error, never a silent
  truncation to the shortest column, because money math must not quietly drop
  rows.
- **SUMIF/COUNTIF comparison criteria (SUB-743)**: the match argument may be a
  string starting with `>=`, `<=`, `<>`, `>` or `<` — `COUNTIF(score, ">=1")`,
  `SUMIF(score, "<5", cost)`, `COUNTIF(score, "<>0")` — so a risk bucket is one
  line instead of an enumeration of `score_1 … score_10` (which broke on 0 and
  decimal scores). Excel semantics: `>=`/`<=` include the boundary, `>`/`<`
  don't. A numeric operand (`">=1"`) compares numerically; a non-numeric one
  (`">=delta"`) compares as case-insensitive text. Blank cells never satisfy a
  comparison — including `<>` — matching the ordering-comparison rule elsewhere
  in the language (SUB-238). A numeric comparator over a cell that isn't a
  number is an error, not a silent skip; so is a criteria with no operand
  (`">="`). Any other match value — numbers, booleans, and strings that don't
  start with a comparator — keeps exact-match behaviour unchanged, so a literal
  cell like `"a>b"` still matches exactly.
- **SUMIF/COUNTIF wildcard criteria (SUB-752)**: an exact-match *string* may use
  Excel's wildcards — `*` for any run of characters (including none) and `?` for
  exactly one — so `COUNTIF(type, "ETF*")` counts every `ETF …` row and
  `COUNTIF(code, "a?b")` matches `axb` but neither `ab` nor `aXXb`. `~` escapes:
  `~*`, `~?` and `~~` are a literal star, question mark and tilde. Matching is
  case-insensitive, like every other exact match (`"etf*"` ≡ `"ETF*"`), and blank
  cells never match — not even `"*"` — following the blanks-don't-match rule the
  rest of the language uses (SUB-238). Wildcards live only on the exact-match
  path: comparison criteria (`">=1"`, SUB-743) parse first and are untouched, and
  every added `(column, match)` pair (SUB-742) gets identical treatment.
  A match string with no unescaped `*`/`?` keeps exact-match behaviour verbatim,
  numeric loose equality included. The tradeoff: a match string that *does*
  contain one is now a pattern, so `"a*b"` — which previously matched only the
  literal cell `a*b` — also matches `aXb`. That is Excel's behaviour and is
  intended; write `"a~*b"` when the literal star is what you mean.
- `COUNTIF(x, "")` returns 0 over blank cells, because blanks never match `""`
  (SUB-238); Excel counts blanks there. Use a comparison criteria or a computed
  flag column when you need a blank count.
- **SUMIF/COUNTIF multiple criteria (SUB-742)**: extra `(column, match)` pairs
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
  no honest row-by-row reading of a short column. Computed columns work as
  criteria columns anywhere, since they are ordinary scope columns.
- `LAST(col)` returns the last non-empty cell in stored row order (not the sorted
  view), as-is — number, string, date, no coercion. Empty follows the cell-typing
  convention: nulls and blank/whitespace-only strings are skipped; error cells
  propagate like every other aggregate; an all-empty column is an error, like MAX
  over an empty set. Works over data and computed columns, so a snapshot sheet
  (rows appended over time) reads its most recent row: `latest = LAST(total)`.
- **`LOOKUP(key, keyColumn, valueColumn)` (SUB-741)**: the first row whose
  `keyColumn` matches `key`, that row's `valueColumn` cell, returned as-is (no
  coercion). Matching is the language's usual loose equality — numeric keys
  compare numerically, text case-insensitively — so `LOOKUP("usd", code, rate)`
  and `LOOKUP(2025, year, budget)` both work. "First" means stored row order,
  not the sorted view; duplicate keys are a data smell in your table, not an
  error — the earliest row simply wins. Either column may be a data or a
  computed column. A blank key cell never matches (the SUB-238 rule), and a
  blank `key` argument is an error. A miss is an **error**, never `0` or blank —
  same for a matched row whose value cell is empty — because a rates table that
  silently reads as zero is a money bug, not a gap. Combined with cross-sheet
  refs this is the FX shape: one `Rates` sheet, and one line pulls its rate —
  `usd_rate = LOOKUP("USD", Rates.code, Rates.rate)` — so an FX change is one
  edit in one table instead of an inlined rate per row.
  **Row scope vs summary scope (SUB-748)**: the *key* argument decides which
  one a LOOKUP line is. A key that reads nothing row-shaped — a constant or an
  earlier summary — keeps the SUB-741 shape: the line is a **summary** and its
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

## v2 — cross-sheet references (SUB-44)

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
  (SUB-715): `ceiling = 25000` is a summary — a single named value, bindable from
  dashboards (`{{Holdings.ceiling}}`) and other sheets, instead of a computed
  column repeating the constant on every row.
- Cycles (A → B → A, or a sheet referencing itself by name) are detected per
  evaluation network and become scoped errors (`circular sheet reference: a → b → a`)
  that propagate through dependent formulas Excel-style — no hangs.
- Missing sheets/members resolve to error values the same way.
- The grid and metrics dashboards load referenced sheets lazily by name
  (dashboards load the transitive closure) and re-load on vault changes.

## Dates and TODAY() (SUB-717)

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

## UI

- Sheet notes open as a grid (like the DB list pane but real columns): editable data
  cells, computed columns read-only (dimmed), summary bar pinned below with the named
  aggregates. Tab/arrow navigation, Enter to edit. Add row/column inline.
- Computed column headers edit the formula: double-click opens the line in fence form
  (`name = formula`); Enter applies, Esc cancels. A rename rewrites references on
  every other formula line (string literals, function names, and other sheets'
  members stay untouched); name collisions with data columns or other formulas are
  rejected. Writes back to the ```formulas fence like any other edit.
- The source note stays one click away (same pattern as dashboards).

## Dashboards reading sheets

- Metric binding syntax in dashboard notes: `{{Holdings.total}}`, `{{Holdings.crypto}}`.
- A generic `metrics` dashboard renderer: frontmatter lists cards, each bound to a
  sheet summary → the portfolio dashboard becomes: sheet holds rows, dashboard shows
  totals/deltas.
- Charts bind summaries too (SUB-745): a ` ```chart ` fence with
  `series: etf, crypto, cash` instead of `x`/`y` plots those named summaries as
  single-value points, one per name in fence order. So a per-bucket COUNTIF/SUMIF
  set charts as-is — no bucket rows have to be materialized in the sheet to give
  the chart something row-shaped to group. Row binding (`x`/`y`) and summary
  binding (`series`) are exclusive; a name that isn't a numeric summary on that
  sheet errors the chart by name rather than dropping a point. Details in
  `docs/dashboards.md` → `charts`.

## Build order

1. Formula parser + evaluator (pure TS, tested against a spreadsheet portfolio tracker's semantics).
2. Grid view for `type: sheet` notes (read + cell edit + row add).
3. Summary bar + computed columns.
4. `metrics` dashboard renderer with `{{sheet.name}}` bindings.
