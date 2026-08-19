---
type: sheet
title: Forecast Net Worth
exported: 2026-08-18T06:10:00Z
created: 2026-08-18
---
> [!warn] Machine-written
> Never edit here. The scheduled refresh regenerates the whole curve from
> [[Accounts]], [[Expected Returns]] and [[Expenses]]; hand edits are
> overwritten. `exported:` is the stamp each run rewrites, so a freshness probe
> can tell whether this curve is today's.

Ten years, one row per quarter, off three numbers and nothing else. The script
starts from `total_eur` on [[Accounts]] (69608). It compounds monthly at the
rate [[Expected Returns]] models as compounding — `growth_annual` plus
`accumulating`, the price growth plus the income an accumulating fund keeps
inside itself — over that same balance: (2176.8 + 741.6) / 69608 = 4.1926 % a
year, applied as a twelfth of that each month. Spendable income is deliberately
not in the rate; it is spent, not reinvested. Each month it then adds
`net_monthly_plan` from [[Expenses]] (1238) as a contribution, and every third
month it writes a row — forty of them.

None of that could be a formula. The language has no exponentiation and no way
for a row to read the row above it, which is exactly what compounding needs — so
compounding happens in the script and the sheet keeps only what it is good at:
totals and endpoints over rows that already exist.

```csv
quarter,net_worth_eur
2026-Q4,69608
2027-Q1,74067
2027-Q2,78573
2027-Q3,83127
2027-Q4,87728
2028-Q1,92378
2028-Q2,97076
2028-Q3,101824
2028-Q4,106622
2029-Q1,111471
2029-Q2,116370
2029-Q3,121321
2029-Q4,126324
2030-Q1,131380
2030-Q2,136489
2030-Q3,141652
2030-Q4,146869
2031-Q1,152140
2031-Q2,157468
2031-Q3,162851
2031-Q4,168291
2032-Q1,173788
2032-Q2,179343
2032-Q3,184956
2032-Q4,190628
2033-Q1,196361
2033-Q2,202153
2033-Q3,208006
2033-Q4,213921
2034-Q1,219898
2034-Q2,225938
2034-Q3,232041
2034-Q4,238209
2035-Q1,244442
2035-Q2,250740
2035-Q3,257104
2035-Q4,263535
2036-Q1,270034
2036-Q2,276602
2036-Q3,283238
```

```formulas
start_eur   = MIN(net_worth_eur)
end_eur     = LAST(net_worth_eur)
peak_eur    = MAX(net_worth_eur)
quarters    = COUNT(net_worth_eur)
gain_eur    = end_eur - start_eur
```
