---
type: dashboard
dashboard: metrics
cards:
- label: Income / mo
  bind: '{{Expenses.income_monthly}}'
  format: eur
- label: Fixed costs
  bind: '{{Expenses.fixed_monthly}}'
  format: eur
- label: Spending budget
  bind: '{{Budget Limits.budget_total}}'
  format: eur
- label: Net / mo planned
  bind: '{{Expenses.net_monthly_plan}}'
  format: eur
  emph: true
- label: Net / mo forecast
  bind: '{{Forecast Cashflow.net_avg}}'
  format: eur
- label: Net / mo median
  bind: '{{Forecast Cashflow.net_median}}'
  format: eur
  emph: true
created: 2026-08-18
---
The plan on the left, what the forecast actually produces on the right. The
first four cards are the plan you wrote — income, fixed costs, spending budget,
and what should be left. The last two read [[Forecast Cashflow]]: the average of
the twelve projected months, and their median. Both sit under the plan, and the
average sits under the median — a few spike months drag it down while the
typical month does not move. The median is the honest one to read: when it
lands well below the plan, the plan is the optimistic one.

```chart
source: {{Forecast Cashflow}}
x: month
y: sum:amount_eur
by: series
kind: line
title: Twelve months ahead
```

```chart
source: {{Forecast Net Worth}}
x: quarter
y: sum:net_worth_eur
kind: line
title: Net worth, ten years out
```

Both curves are rows a script wrote, not formulas — see **Making it recurring**
on [[Finance]] for why, and for how to schedule the script that writes them.
