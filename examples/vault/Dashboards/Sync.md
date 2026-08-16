---
type: dashboard
dashboard: sync
state: ~/.config/rclone/sync-state.json
prefix: com.example.sync.
runner: ~/bin/sync-run
stale: offsite=30h, nas=9h
created: 2026-08-15
---
Backup sync for this machine. Nothing here copies files — a runner script on
the schedule does that and writes the state file this pane reads, so what you
see is what that system last did: per-remote freshness and free space, a run
history strip per leg, the schedule's own health, and the recent errors from
its log.

Run starts the runner for one direction or leg; Pause and Resume act on the
schedule for the whole machine, not just for this app. On a machine with no
state file the pane says so and stays empty — it is a window, never a copier.
