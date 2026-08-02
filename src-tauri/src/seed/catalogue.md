---
type: sheet
title: Catalogue
created: 2026-07-17
---
Sample sheet. Rows live in the csv fence, and the formulas fence adds a computed
column plus the named totals [[Label Overview]] binds its cards to. Edit either
fence — or the grid, which is the same data — and every surface reading them
follows.

```csv
release,format,tracks,minutes
Slow Bloom EP,Vinyl,8,28
Vessel Songs,Digital,11,41
Static Bouquet,Vinyl,9,33
```

```formulas
avg_track_min = minutes / tracks

releases     = COUNT(minutes)
tracks_total = SUM(tracks)
runtime      = SUM(minutes)
vinyl        = COUNTIF(format, "Vinyl")
digital      = COUNTIF(format, "Digital")
```
