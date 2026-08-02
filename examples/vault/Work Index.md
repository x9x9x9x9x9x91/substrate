---
type: sheet
title: Work Index
created: 2026-07-30
---
The [[Music Work]] dashboard reads this sheet and never writes to it. An
external tree scanner walks the production folders — which are category-first,
`MASTERING/<artist>/<job>` — and writes one row per job. `flags` is the
scanner's own note about a row whose dating it isn't sure of.

```csv
category,client,job,year,last_active,files,size_mb,flags
MASTERING,Ada Voss,Voss Signal,2026,2026-06-13,318,23949,
MASTERING,Mira,mira master v2,2026,2026-03-02,12,340,
MASTERING,Mira,Fern Static,2025,2026-07-29,51,1392,name 2025 vs files 2026
MASTERING,Torv,Slow Bloom,2026,2026-07-23,74,5108,
MIXING,Juno Marek,ep4,2026,2026-07-18,196,14324,
MIXING,Mira,"mira adjust, alt take",2026,2026-01-06,3,0,
MIXING,Halo Ferry,drums session,2025,2025-11-02,88,6210,
MIXING,Ada Voss,live rig stems,2024,2024-09-14,41,2870,
OWN WORK,NIGHT CIRCUIT (2026),night circuit,2026,2026-06-01,10,280,
OWN WORK,COLLABS,Lila,2024,2024-01-23,54,3880,
```
