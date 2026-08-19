---
type: sheet
title: Expected Returns
created: 2026-08-18
---
Yours to edit. The model sheet: what you assume each account in [[Accounts]]
earns, split into the two halves that behave differently. `income_pct` is what
the account pays out — interest, distributions — and `price_pct` is what its
price is assumed to do. Splitting them is the whole point: only the first half
can be spent without selling anything.

`kind` says where the income goes. `ACC` is an accumulating fund — it earns
inside the fund and pays you nothing, so its income is real but not spendable.
`cash` is a bank balance, `none` a distributing position; both pay out.

`value_eur` is a row-scoped `LOOKUP` into [[Accounts]], so a balance is written
in one place and read here.

```csv
account,kind,income_pct,price_pct
World ETF,ACC,1.8,5.2
Bond ETF,none,3.1,0.4
Savings account,cash,2.4,0
Current account,cash,0,0
Travel account,cash,0,0
```

```formulas
value_eur  = LOOKUP(account, Accounts.account, Accounts.value_eur)
income_eur = value_eur * income_pct / 100
growth_eur = value_eur * price_pct / 100

income_annual     = SUM(income_eur)
growth_annual     = SUM(growth_eur)
accumulating      = SUMIF(kind, "ACC", income_eur)
spendable_income  = income_annual - accumulating
spendable_monthly = spendable_income / 12
```
