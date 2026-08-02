---
type: dashboard
dashboard: metrics
cards:
- label: Net revenue
  bind: '{{Label Statements.net_total}}'
  format: eur
  digits: 2
- label: Bandcamp
  bind: '{{Label Statements.bandcamp}}'
  format: eur
  digits: 2
- label: Streaming
  bind: '{{Label Statements.streaming}}'
  format: eur
  digits: 2
- label: Owed to artists
  bind: '{{Label Splits.owed_total}}'
  format: eur
  digits: 2
pages:
- label: Statements
  note: Label Statements
- label: Splits
  note: Label Splits
- label: Releases
  view: release
created: 2026-07-25
---
A label-accounting workbook (SUB-464): overview cards over the statement
sheet, with the sheets themselves and the release database one tab away —
the strip at the bottom switches pages, ⌃⇥ / ⌃⇧⇥ cycles them.
