---
type: dashboard
dashboard: jobs
prefixes: com.example., com.substrate.
control:
  - com.example.digest
  - com.example.verify
freshness:
  - com.example.digest | Dashboards/News.md | curated | 26h
created: 2026-08-15
---
Scheduled jobs on this machine. Nothing here runs on a clock of its own —
launchd owns the schedule and this pane is a window onto it, so each row shows
what one agent is: loaded or paused, its next run, the pid if it is running
now, its last exit, and how its recent runs went.

The freshness probe is the check a green row can still fail: it reads a
timestamp out of another note's frontmatter and says so when what the job is
supposed to keep fresh has gone stale anyway.

Pause, Resume and Run now appear only on the labels listed under `control:`,
and only where this machine actually holds the job's plist — pausing here
pauses it for the whole machine, not just for this app.
