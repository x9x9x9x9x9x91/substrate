---
type: sheet
title: News Items
created: 2026-07-26
---
The [[News]] dashboard reads this sheet and writes only the `fb` column. Rows
are ordered newest day first, and within a day the row order is the curator's
ranking — the pane never re-sorts it.

```csv
date,topic,title,source,url,blurb,why,fb
2026-07-26,plugins,"Zynaptiq ships Morph 3, with a realtime spectral engine",CDM,https://cdm.link/example/morph3,"Spectral morph between two sources, now low enough latency to play live.","Your spectral chain is all offline right now — this is the first one you could perform with.",up
2026-07-26,hardware,Dirtywave M8 firmware 4.2 adds per-track sends,Dirtywave,https://dirtywave.com/example/m8-42,"Two global send busses, addressable per track from the mixer page.","The M8 sketches lose their space when they land in Ableton; sends travel with the song.",
2026-07-26,scene,"Umbra announces a 2026 label night, four dates",Resident Advisor,https://ra.co/example/umbra-nights,"Four nights across autumn, lineup announced in waves.","chroma weather is on the second date — the mixes went out last month, so this is the first time they play live.",
2026-07-25,ai,"Open-weights stem separator beats Demucs on drums, MIT licence",Hacker News,https://news.ycombinator.com/example/stems,"Runs locally, ~2x realtime on Apple silicon, no cloud step.","Archive salvage: the old masters with no stems could finally get usable ones.",down
2026-07-25,local,The Turbine Rooms open a residency for electronic composers,City Beats,https://citybeats.example/turbine-residency,"Three months of studio time, applications close in September.","fern palace has been asking about a room away from home — this closes before the next Umbra deadline.",
2026-07-24,wild,A granular synth built entirely inside a spreadsheet,lines,https://llllllll.co/example/sheet-granular,"12,000 formula cells scheduling grains at 30fps. Genuinely audible.","Filed purely because it is a good trick — no deadline attached.",
```
