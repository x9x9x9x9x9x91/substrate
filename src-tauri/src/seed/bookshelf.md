---
type: sheet
title: Bookshelf
created: 2026-08-03
---
Sample sheet. Rows live in the csv fence, and the formulas fence adds a computed
column plus the named totals [[Reading & Travel]] binds its cards to. Edit
either fence — or the grid, which is the same data — and every surface reading
them follows.

```csv
title,author,pages,rating,status,finished
The Hobbit,J.R.R. Tolkien,310,5,finished,2026-02-14
Kafka on the Shore,Haruki Murakami,505,4,finished,2026-03-28
Braiding Sweetgrass,Robin Wall Kimmerer,391,5,finished,2026-06-02
Project Hail Mary,Andy Weir,476,,reading,
Piranesi,Susanna Clarke,245,,next,
```

```formulas
est_hours = pages / 40

finished_count = COUNTIF(status, "finished")
pages_read     = SUMIF(status, "finished", pages)
avg_rating     = AVG(rating)
reading_now    = COUNTIF(status, "reading")
```
