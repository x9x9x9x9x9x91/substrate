---
type: sheet
title: Budget Limits
created: 2026-08-18
---
Half yours, half the machine's. `category` and `monthly_limit_eur` are the
budget you set and nobody else writes. `spent_eur` is refreshed by the daily
script from wherever your real spending lives — a bank export, a receipts
folder, whatever you point it at — so the bars on [[Budgets]] move without you
retyping anything.

Each category carries a `spent_*` / `limit_*` pair of summaries. That is what a
progress bar binds to: a bar takes one value and one target, and the pairs let
both of them bind summaries — a literal target works too, but a summary moves
when you edit the sheet, and a bar with a typed-in target quietly stops telling
the truth the first time you raise a limit.

```csv
category,monthly_limit_eur,spent_eur
Groceries,320,287.40
Eating out,90,112.65
Transport,60,44.20
Music and gear,120,96.00
Household,80,51.30
```

```formulas
left_eur = monthly_limit_eur - spent_eur

budget_total = SUM(monthly_limit_eur)
spent_total  = SUM(spent_eur)
left_total   = budget_total - spent_total
over_count   = COUNTIF(left_eur, "<0")

spent_groceries = SUMIF(category, "Groceries", spent_eur)
limit_groceries = SUMIF(category, "Groceries", monthly_limit_eur)
spent_dining    = SUMIF(category, "Eating out", spent_eur)
limit_dining    = SUMIF(category, "Eating out", monthly_limit_eur)
spent_transport = SUMIF(category, "Transport", spent_eur)
limit_transport = SUMIF(category, "Transport", monthly_limit_eur)
spent_gear      = SUMIF(category, "Music and gear", spent_eur)
limit_gear      = SUMIF(category, "Music and gear", monthly_limit_eur)
spent_household = SUMIF(category, "Household", spent_eur)
limit_household = SUMIF(category, "Household", monthly_limit_eur)
```
