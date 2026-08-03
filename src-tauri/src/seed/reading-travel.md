---
type: dashboard
dashboard: metrics
cards:
  - label: Books finished
    bind: "{{Bookshelf.finished_count}}"
    format: number
    emph: true
  - label: Pages read
    bind: "{{Bookshelf.pages_read}}"
    format: number
  - label: Avg rating
    bind: "{{Bookshelf.avg_rating}}"
    format: number
    digits: 1
  - label: Reading now
    bind: "{{Bookshelf.reading_now}}"
    format: number
pages:
  - label: Bookshelf
    note: Bookshelf
  - label: Trips
    view: trip
  - label: How this works
    note: Start Here
created: 2026-08-03
---
Sample dashboard. The cards above read named totals from the [[Bookshelf]]
sheet, the charts below plot the trip notes and that same sheet, and the tabs
at the bottom open the sheet, the trip database, and the explanation.
Everything it shows comes from notes in this vault — delete any of them and the
numbers follow.

This note is sample content: move it to the Trash whenever it has served its
purpose (⌘K → Move to Trash, recoverable). Nothing else depends on it.

```chart
source: trip
x: status
y: count
kind: bar
title: Trips by status
```

```chart
source: {{Bookshelf}}
x: title
y: sum:pages
kind: bar
title: Pages per book
```
