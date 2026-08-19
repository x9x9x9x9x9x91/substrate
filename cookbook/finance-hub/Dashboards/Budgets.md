---
type: dashboard
dashboard: hub
created: 2026-08-18
---
This month's spending against the limits you set in [[Budget Limits]]. The
limits are yours; the spent column is refreshed nightly, so the bars move on
their own.

```cards
- label: Spent
  bind: "{{Budget Limits.spent_total}}"
  format: eur
  emph: true
- label: Budget
  bind: "{{Budget Limits.budget_total}}"
  format: eur
- label: Left
  bind: "{{Budget Limits.left_total}}"
  format: eur
  emph: true
- label: Over budget
  bind: "{{Budget Limits.over_count}}"
  format: number
```

## Where it went

```progress
label: Groceries
value: {{Budget Limits.spent_groceries}}
target: {{Budget Limits.limit_groceries}}
format: eur
```

```progress
label: Eating out
value: {{Budget Limits.spent_dining}}
target: {{Budget Limits.limit_dining}}
format: eur
```

```progress
label: Transport
value: {{Budget Limits.spent_transport}}
target: {{Budget Limits.limit_transport}}
format: eur
```

```progress
label: Music and gear
value: {{Budget Limits.spent_gear}}
target: {{Budget Limits.limit_gear}}
format: eur
```

```progress
label: Household
value: {{Budget Limits.spent_household}}
target: {{Budget Limits.limit_household}}
format: eur
```

A bar past 100 % keeps counting — the fill clamps, the percentage doesn't — so
an overspent category says how far over rather than sitting quietly at full.
