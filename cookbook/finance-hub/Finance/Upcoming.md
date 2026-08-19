---
type: sheet
title: Upcoming
columns:
  due: { notify: true, notifyBefore: 3 }
exported: 2026-08-18T06:10:00Z
created: 2026-08-18
---
> [!warn] Machine-written
> Never edit here. The scheduled refresh regenerates this sheet from
> [[Expenses]] and [[Debts]]; anything typed in by hand is gone the next
> morning. `exported:` in the frontmatter is the stamp it rewrites each run —
> that is what a freshness probe reads to tell a live sheet from a stale one.

Everything with a date on it, in one place. The script sweeps the dated open rows
out of [[Debts]] and, from [[Expenses]], exactly the rows that carry a `due_day`
— resolved to the next occurrence of that day of the month. A blank `due_day` is
not swept; the sample fills all eight, so all eight are here. Either way this
sheet has no blank `due` cell by construction, which is what lets `days_left` do
date arithmetic without a single row erroring.

`flow` is the direction, and it is why this sheet does not add money up in one
lump: `out` is money leaving — every bill, plus a debt you owe — and `in` is
money arriving, a debt somebody owes you. Summing the two together would net a
repayment against the rent and call the difference "due". So the outflow
summaries filter on `flow = out`, the inflows get their own, and every card
that binds one says which direction it shows.

The rows below are frozen sample data, written by hand so the workbook renders
on arrival — a snapshot of what a run on 2026-08-18 would have produced. The
first run of the refresh script replaces them wholesale with dates computed from
today.

The `columns:` map in the frontmatter is what turns the `due` column into
notifications: an alert on the day, and another three days ahead. That setting
lives on this sheet and nowhere else, so nothing fires twice.

```csv
what,due,amount_eur,flow,source
Gym,2026-08-20,29,out,Expenses
Streaming and software,2026-08-25,34,out,Expenses
Bike repair loan — Robin,2026-08-28,150,out,Debts
Rent,2026-09-01,980,out,Expenses
Health insurance,2026-09-03,238,out,Expenses
Transit pass,2026-09-05,49,out,Expenses
Electricity and heating,2026-09-08,145,out,Expenses
Phone and internet,2026-09-12,55,out,Expenses
Liability insurance,2026-09-15,12,out,Expenses
Concert tickets — Alex,2026-10-02,84,in,Debts
```

```formulas
days_left = due - TODAY()

due_14d       = SUMIF(days_left, ">=0", amount_eur, days_left, "<=14", flow, "out")
incoming_14d  = SUMIF(days_left, ">=0", amount_eur, days_left, "<=14", flow, "in")
overdue_count = COUNTIF(days_left, "<0", flow, "out")
items         = COUNT(amount_eur)

due_total      = SUMIF(flow, "out", amount_eur)
incoming_total = SUMIF(flow, "in", amount_eur)
from_bills     = SUMIF(source, "Expenses", amount_eur, flow, "out")
from_debts     = SUMIF(source, "Debts", amount_eur, flow, "out")
```
