---
type: dashboard
dashboard: hub
created: 2026-08-03
---
How ready the year is to hand over. The totals come from [[Tax 2026]]; the
documents still owed are the checklist below, kept in step with the exported
[[Tax Missing]] snapshot. Both sheets stay canonical — this page only reads
them, and the head's Print action turns it into the page you hand to whoever
does the filing.

## The year so far

```cards
- label: Income YTD
  bind: "{{Tax 2026.income_ytd}}"
  format: eur
  emph: true
- label: Profit YTD
  bind: "{{Tax 2026.profit_ytd}}"
  format: eur
  emph: true
- label: Business expenses
  bind: "{{Tax 2026.expenses_ytd}}"
  format: eur
- label: Equipment
  bind: "{{Tax 2026.equipment_ytd}}"
  format: eur
- label: Home office
  bind: "{{Tax 2026.home_office_ytd}}"
  format: eur
- label: Rental
  bind: "{{Tax 2026.rental_ytd}}"
  format: eur
- label: Partnership
  bind: "{{Tax 2026.partnership_ytd}}"
  format: eur
- label: Threshold headroom
  bind: "{{Tax 2026.threshold_headroom}}"
  format: eur
- label: Documents
  bind: "{{Tax 2026.documents}}"
  format: number
```

## Still owed

- [ ] Studio rent — March · Receipt no.
- [ ] Interface repair · Document Filed; Receipt
- [ ] Domain renewal · Receipt no.
- [ ] Mastering — Fern Static · Invoice PDF
- [ ] Boiler service · Receipt

The board is ordinary fences, so it is yours to reshape: swap the card labels
and binds for whatever your own filing is judged on, mark at most two
`emph: true`, and rewrite the checklist whenever the [[Tax Missing]] export
changes — no kind reads it for you, which is also why nothing here can go stale
behind your back.
