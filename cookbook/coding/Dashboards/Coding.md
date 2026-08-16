---
type: dashboard
dashboard: coding
root: ~/Coding
created: 2026-08-15
---
Per-repo git health for every project under `root:` — one row each: dirty
files, unmerged local branches with the oldest one's age, extra worktrees, and
ahead/behind against the integration branch's `origin/…` ref. Repos that need
attention sort to the top; quiet ones dim below. Folders that aren't git repos
are listed at the foot with their size and last touch.

Point `root:` at any folder of projects — `~/Coding` is only the default, and
the credential stores the app never opens (`~/.ssh` and the rest of the deny
list) are not scannable here either. The scan is read-only and never networked
(git read verbs only, with the locking and config-execution doors shut), so an
ahead/behind count is measured against whatever your last fetch left behind. It
is cached for an hour per root; the head's ↻ rescan forces a fresh walk.

This one is machine-specific in the honest sense: it reads your disk, not the
vault. On a machine without that folder the pane says so calmly instead of
erroring.
