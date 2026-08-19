---
type: sheet
title: Expenses
created: 2026-08-18
---
Yours to edit. The costs that arrive whether or not you do anything — rent,
insurance, the standing subscriptions. Day-to-day spending is not here; that
lives in [[Budget Limits]], because it is the part you steer.

The one line that isn't a cost is `income_monthly`: what actually lands in the
account each month, after tax. It sits here so the plan — income, minus fixed
costs, minus the spending budget — is one sheet's arithmetic rather than a
number typed into a dashboard. `net_monthly_plan` is what the plan says is
left over, and the refresh script uses it as the monthly contribution when it
regenerates [[Forecast Net Worth]].

`due_day` is the sweep rule, and it is opt-in. A row with a day of the month in
it gets swept into [[Upcoming]] at its next occurrence of that day; a row with
`due_day` blank is never swept, no matter how regular it is. That is the whole
distinction between a bill you want warned about and a direct debit you have
stopped thinking about. The sample fills every row, so the sweep below covers
all eight — blank it on the ones you would rather not hear about. Nothing here
does arithmetic on `due_day` — a blank cell has to stay legal — so it is a
column the script reads and the formulas ignore.

```csv
item,category,monthly_eur,due_day
Rent,Home,980,1
Electricity and heating,Home,145,8
Phone and internet,Home,55,12
Health insurance,Insurance,238,3
Liability insurance,Insurance,12,15
Transit pass,Transport,49,5
Gym,Health,29,20
Streaming and software,Subscriptions,34,25
```

```formulas
fixed_monthly    = SUM(monthly_eur)
income_monthly   = 3450
net_monthly_plan = income_monthly - fixed_monthly - "Budget Limits".budget_total

fixed_annual      = fixed_monthly * 12
home_monthly      = SUMIF(category, "Home", monthly_eur)
insurance_monthly = SUMIF(category, "Insurance", monthly_eur)
line_items        = COUNT(monthly_eur)
```
