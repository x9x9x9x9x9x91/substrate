---
type: sheet
title: Label Splits
created: 2026-07-25
---
Artist split ledger — what each artist is owed from net revenue and what has
been paid out. A page in the [[Label Accounting]] workbook.

```csv
artist,split_pct,net_eur,paid_eur
chroma weather,50,181.30,100
fern palace,50,55.20,0
```

```formulas
owed_eur = net_eur * split_pct / 100 - paid_eur

owed_total = SUM(owed_eur)
```
