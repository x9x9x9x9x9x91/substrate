# The Substrate cookbook

Dashboard recipes as plain files. Each folder here is one surface — the
dashboard note plus every sheet, database note, or contact it binds to, so a
copied recipe renders with numbers the first time you open it.

**Install is copy-paste.** Pick a recipe, copy its files into your vault, done.
Keep the `Dashboards/` nesting or don't — folders never decide what belongs to
a database in Substrate; the `type:` line in each file does.

**Or hand it to your agent.** [`index.json`](index.json) is a machine-readable
index: each entry declares the recipe's files, what it expects to exist
(sheets, database types), and how to adapt the sample data. "Copy the
portfolio recipe into my vault and set it up against my real accounts" is a
one-line prompt.

## The recipes

| recipe | kind | what it does |
| --- | --- | --- |
| [`portfolio/`](portfolio) | metrics | stat cards over a sheet's named summaries |
| [`yield-apr/`](yield-apr) | yield-apr | realized APR + projections from append-only snapshots |
| [`food-log/`](food-log) | food | daily net-kcal tracker with a goal band and autocomplete |
| [`news-feed/`](news-feed) | feed | agent-curated newsfeed; your ↑/↓ feed the curator back |
| [`home-hub/`](home-hub) | hub | a designed home page from ordinary markdown |
| [`release-charts/`](release-charts) | charts | bar charts over a database and a sheet |
| [`label-accounting/`](label-accounting) | metrics + pages | a workbook: cards, sheets, and a database as bottom tabs |
| [`music-work/`](music-work) | music-work | years of work pivoted from one scanner-written sheet |
| [`annual-report/`](annual-report) | metrics | the year in cards + charts, printable as a designed PDF |

Screenshots live in [`shots/`](shots) — each is the recipe's own files
rendered in the app, captured by `e2e/cookbookshots.spec.ts`.

## Guarantees

Every recipe file is byte-identical to its source in
[`examples/vault/`](../examples/vault), and that vault is parsed by the same
library code the app renders with, in CI (`scripts/example-vault.test.ts`,
`scripts/cookbook.test.ts`). A recipe that drifts fails the suite.

## Contributing a recipe

Add the files to `examples/vault/` first (that's what validates them), copy
them into a folder here, add the `index.json` entry, and regenerate the shot
with `SHOTS=1 npx playwright test e2e/cookbookshots.spec.ts`. The bar for
inclusion is a board someone actually lives in — real use, then genericized —
not a demo invented for the gallery.
