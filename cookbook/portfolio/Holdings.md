---
type: sheet
title: Holdings
created: 2026-07-23
---
A demo portfolio sheet — data rows in the csv fence, computed columns and named
summaries in the formulas fence. [[Label Board]] binds cards to the summaries.

```csv
asset,bucket,units,price_usd
WORLD-ETF,etf,120,98.5
TECH-ETF,etf,40,211.0
BTC,crypto,0.4,64200
CASH,cash,5000,1
```

```formulas
value_usd = units * price_usd

total  = SUM(value_usd)
etf    = SUMIF(bucket, "etf", value_usd)
crypto = SUMIF(bucket, "crypto", value_usd)
```
