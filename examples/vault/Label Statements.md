---
type: sheet
title: Label Statements
created: 2026-07-25
---
Distributor statement lines — one row per release per store per period. The
[[Label Accounting]] workbook binds its overview cards to the summaries here.

```csv
period,release,store,gross_eur,fee_eur
2026-05,Slow Bloom EP,Bandcamp,412.50,41.25
2026-05,Static Bouquet,Streaming,96.10,14.40
2026-06,Slow Bloom EP,Bandcamp,388.00,38.80
2026-06,Static Bouquet,Streaming,101.30,15.20
2026-06,Glass Havens,Streaming,64.90,9.70
```

```formulas
net_eur = gross_eur - fee_eur

gross_total = SUM(gross_eur)
fees_total  = SUM(fee_eur)
net_total   = SUM(net_eur)
bandcamp    = SUMIF(store, "Bandcamp", net_eur)
streaming   = SUMIF(store, "Streaming", net_eur)
```
