---
type: dashboard
dashboard: tasks
areas:
- Label
- Studio
stale_days: 21
created: 2026-07-23
---
Working board over the `task` notes in `Tasks/`. What is late comes first:
Overdue, then Due today, then the hand-picked Now list, then the rest grouped by
area. Inside every section the order is due bucket, then priority, then age —
rot is the tiebreaker, not the headline. Rows check off, edit inline, and get
added straight from the board. Done tasks stay off it; snoozed ones fall into
their own collapsed section rather than vanishing.

Demo dates are fixed so the test reads the same board every run, which means
they rot against the wall clock: past a few weeks from August 2026 every row
drifts stale against `stale_days: 21`, and once 2027-03-01 passes the snoozed
sleeve brief wakes up and the collapsed-snooze demo goes with it.
