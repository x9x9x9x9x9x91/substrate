---
type: sheet
title: Accounts
created: 2026-08-18
---
Yours to edit. One row per account you hold — broker positions, savings, the
current account, anything with a balance. `value_native` is the balance in the
account's own currency and `fx_to_eur` converts it, so a foreign account stays
readable as what the bank shows you. The [[Finance]] workbook's net-worth card
binds to `total_eur`, and [[Expected Returns]] looks each row up by name.

A refresh script may overwrite `value_native` when it can fetch a price; every
other column stays hand-written.

```csv
account,kind,currency,value_native,fx_to_eur
World ETF,broker,EUR,41200,1
Bond ETF,broker,EUR,8600,1
Savings account,savings,EUR,14500,1
Current account,cash,EUR,3100,1
Travel account,cash,USD,2400,0.92
```

```formulas
value_eur = value_native * fx_to_eur

total_eur    = SUM(value_eur)
invested_eur = SUMIF(kind, "broker", value_eur)
savings_eur  = SUMIF(kind, "savings", value_eur)
cash_eur     = SUMIF(kind, "cash", value_eur)
accounts     = COUNT(value_eur)
```
