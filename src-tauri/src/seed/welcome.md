---
created: 2026-08-03
---
Welcome. Everything here is a plain markdown file on disk — no database, no
export step, no lock-in. A note becomes a database row by gaining properties;
nothing ever moves. This note is a five-minute tour: work through it, then
delete it.

## 1 · Capture

- **⌘N** — new note, straight into the Inbox, zero filing decisions
- The **quick-capture hotkey** (default `⌥space`) does the same from any app —
  even with Substrate in the background
- **⌘D** — today's journal page

Try it: hit ⌘N, type a thought, come back here with ⌘K.

## 2 · Find

- **⌘K** — the command palette: open anything, create anything, run anything
- **⌘⇧F** — full-text search with filters (`type:trip status:booked`, `due < 7d`)
- Link notes with [[Lisbon]] style wikilinks — backlinks collect at the
  bottom of every note, and following a link to a missing note creates it

## 3 · Organize (when you feel like it)

The property chips under a note's title are its frontmatter. Give notes a
shared `type:` and they become rows in a database — same files, new view:

| trip | status |
| --- | --- |
| [[Lisbon]] | done |
| [[Kyoto]] | booked |

The seeded trips and the [[Weeknight Ramen]] recipe are sample data — open
one, look at its chips, then replace them with your real notes whenever
you're ready.

- [ ] tasks render as real checkboxes — click this one
- [x] done items get struck through

## 4 · Dashboards and sheets

- [[Start Here]] explains what a dashboard is
- [[Reading & Travel]] is a live one: cards and charts reading the
  [[Bookshelf]] sheet and the trip notes — all seeded in this vault, delete
  freely

## 5 · Make it yours

- **⌘,** — settings (quick-capture hotkey, tray behavior, the works)
- **⌘/** — every keyboard shortcut
- **⌘⇧T** — a built-in terminal over the vault. If you use an AI agent CLI
  (claude, codex…), it starts here with your notes as its working folder. The
  vault ships with app files at the root — `Settings.md`, plus `AGENTS.md`
  and `CLAUDE.md` for agent orientation. They stay out of your notes and
  search so this vault reads as yours, not the tooling's; they're normal
  files in Finder, and the "Show app files" switch in settings lists them
  in-app. The seeded `/setup` command interviews you and writes agent skills
  fitted to your actual notes.
