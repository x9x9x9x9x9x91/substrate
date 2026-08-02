---
type: dashboard
dashboard: metrics
cards:
  - label: Releases
    bind: "{{Catalogue.releases}}"
    format: number
    emph: true
  - label: Runtime (min)
    bind: "{{Catalogue.runtime}}"
    format: number
  - label: Tracks
    bind: "{{Catalogue.tracks_total}}"
    format: number
  - label: On vinyl
    bind: "{{Catalogue.vinyl}}"
    format: number
pages:
  - label: Catalogue
    note: Catalogue
  - label: Releases
    view: release
  - label: How this works
    note: Start Here
created: 2026-07-17
---
Sample dashboard. The cards above read named totals from the [[Catalogue]]
sheet, the charts below plot the release notes and that same sheet, and the
tabs at the bottom open the sheet, the release database, and the explanation.
Everything it shows comes from notes in this vault — delete any of them and the
numbers follow.

This note is sample content: move it to the Trash whenever it has served its
purpose (⌘K → Move to Trash, recoverable). Nothing else depends on it.

```chart
source: release
x: status
y: count
kind: bar
title: Releases by status
```

```chart
source: {{Catalogue}}
x: release
y: sum:minutes
kind: bar
title: Runtime per release
```
