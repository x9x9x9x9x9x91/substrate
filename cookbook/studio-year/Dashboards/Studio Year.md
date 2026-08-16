---
type: dashboard
dashboard: hub
created: 2026-08-16
---
A year of studio days. Both grids read the same sheet — the first asks how
long, the second how often — and the year is derived from the rows rather than
declared, so the fence keeps saying something true as the log moves on.

## Time at the desk

```heatmap
source: {{Studio Log}}
date: logged
value: sum:minutes
```

## Sessions

```heatmap
source: {{Studio Log}}
date: logged
value: count
```
