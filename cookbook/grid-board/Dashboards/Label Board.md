---
type: dashboard
dashboard: grid
created: 2026-08-22
---
One board for the label: the money, the release cadence, and what is on the
bench right now. Each fence below is one tile, in the order they render.

```tile
tile: cards
source: {{Holdings}}
cards: Total value = total | usd | emph, ETFs = etf | usd, Crypto = crypto | usd | accent:teal
```

```tile
tile: chart
source: release
x: status
y: count
kind: bar
title: Releases by status
```

```tile
tile: view
type: release
query: status:mastering
sort: released
span: 2
```
