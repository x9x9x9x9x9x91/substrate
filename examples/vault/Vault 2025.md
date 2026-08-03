---
type: sheet
title: Vault 2025
created: 2026-08-03
---
The [[Annual Report]] dashboard reads this sheet and never writes to it. An
agent walks the vault's version history once a year — every edit is already a
snapshot commit — and writes one row per month: notes created, words added,
database rows grown. The summaries below are what the report's cards bind to.

```csv
month,notes_created,words_added,db_rows
Jan,14,4200,21
Feb,19,5100,34
Mar,23,6800,29
Apr,17,4900,40
May,31,9400,52
Jun,26,7300,38
Jul,22,6100,44
Aug,18,5000,27
Sep,28,8200,49
Oct,24,6600,35
Nov,20,5700,31
Dec,12,3800,18
```

```formulas
notes_total = SUM(notes_created)
words_total = SUM(words_added)
rows_total  = SUM(db_rows)
busiest     = LOOKUP(MAX(notes_created), notes_created, month)
```
