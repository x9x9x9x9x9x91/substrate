---
type: sheet
title: Forecast Cashflow
exported: 2026-08-18T06:10:00Z
created: 2026-08-18
---
> [!warn] Machine-written
> Never edit here. The scheduled refresh regenerates every row from
> [[Expenses]] and [[Budget Limits]]; hand edits are overwritten. `exported:`
> is the stamp each run rewrites, so a freshness probe can tell whether these
> rows are today's.

Twelve months ahead, in long form: one row per month per series, so a single
chart fence on [[Forecast]] splits it into four lines with `by: series`. The
shape is deliberate — the sheet engine has no way to generate rows, so a
projection has to arrive as rows somebody wrote.

`income` and `fixed` are flat — they come straight off [[Expenses]]. `spending`
is the series that moves: the script varies it around the `budget_total` on
[[Budget Limits]] (670), running a little over it in an ordinary month and
spiking in the months that always cost more — December, the April insurance
run, the summer trip. `net` is then just `income − fixed − spending`, row by
row. That is the lesson the sheet exists to teach: the plan says 1238 a month
is left over, and once real spending is shaped like real spending the median
month produces 1164.

`net_median` is the clearest case. There is no median function in the formula
language, so the script computes it over the twelve `net` rows and writes the
answer down as a constant summary. The averages beside it stay live formulas
over these rows, which is the division of labour this whole workbook runs on:
the script materializes what cannot be expressed, the sheet computes what can.

```csv
month,series,amount_eur
2026-09,income,3450
2026-09,fixed,1542
2026-09,spending,726
2026-09,net,1182
2026-10,income,3450
2026-10,fixed,1542
2026-10,spending,705
2026-10,net,1203
2026-11,income,3450
2026-11,fixed,1542
2026-11,spending,762
2026-11,net,1146
2026-12,income,3450
2026-12,fixed,1542
2026-12,spending,1130
2026-12,net,778
2027-01,income,3450
2027-01,fixed,1542
2027-01,spending,692
2027-01,net,1216
2027-02,income,3450
2027-02,fixed,1542
2027-02,spending,718
2027-02,net,1190
2027-03,income,3450
2027-03,fixed,1542
2027-03,spending,740
2027-03,net,1168
2027-04,income,3450
2027-04,fixed,1542
2027-04,spending,985
2027-04,net,923
2027-05,income,3450
2027-05,fixed,1542
2027-05,spending,748
2027-05,net,1160
2027-06,income,3450
2027-06,fixed,1542
2027-06,spending,775
2027-06,net,1133
2027-07,income,3450
2027-07,fixed,1542
2027-07,spending,1065
2027-07,net,843
2027-08,income,3450
2027-08,fixed,1542
2027-08,spending,734
2027-08,net,1174
```

```formulas
income_year   = SUMIF(series, "income", amount_eur)
fixed_year    = SUMIF(series, "fixed", amount_eur)
spending_year = SUMIF(series, "spending", amount_eur)
net_year      = SUMIF(series, "net", amount_eur)
net_avg       = net_year / 12
net_median    = 1164

months_ahead  = COUNTIF(series, "net")
spending_avg  = spending_year / 12
```
