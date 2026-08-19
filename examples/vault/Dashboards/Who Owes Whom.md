---
type: dashboard
dashboard: metrics
cards:
- label: Owed to you
  bind: '{{Debts.owed_to_me}}'
  format: eur
  digits: 2
  emph: true
- label: You owe
  bind: '{{Debts.i_owe}}'
  format: eur
  digits: 2
- label: Net
  bind: '{{Debts.net_eur}}'
  format: eur
  digits: 2
  emph: true
- label: Open items
  bind: '{{Debts.open_items}}'
  format: number
- label: Overdue outgoings
  bind: '{{Upcoming.overdue_count}}'
  format: number
- label: Going out in 14 days
  bind: '{{Upcoming.due_14d}}'
  format: eur
- label: Coming in, dated
  bind: '{{Upcoming.incoming_total}}'
  format: eur
created: 2026-08-18
---
The small money between you and people you know. The first four cards read
[[Debts]] directly, counting only rows still marked open — a settled row stays
in the sheet for the record and out of every total.

The last three read [[Upcoming]] instead, because they are about dates and
[[Debts]] deliberately holds none of that machinery: an undated tab is a real
debt, so the sheet's own formulas never touch its `due` column. The nightly
refresh sweeps the dated rows into [[Upcoming]], where every row has a date and
the arithmetic is safe.

Those three name their direction, because [[Upcoming]] carries both: bills and
debts you owe leave as `flow: out`, a debt somebody owes you arrives as
`flow: in`. **Overdue outgoings** and **Going out in 14 days** count only the
outflows; **Coming in, dated** is the other side — every dated inflow, whatever
its date. Nothing here nets the two against each other, because a repayment
landing in October does not pay next week's rent.
