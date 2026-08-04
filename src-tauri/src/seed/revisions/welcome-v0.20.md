---
created: 2026-07-17
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
- **⌘⇧F** — full-text search with filters (`type:release status:live`, `due < 7d`)
- Link notes with [[Slow Bloom EP]] style wikilinks — backlinks collect at the
  bottom of every note, and following a link to a missing note creates it

## 3 · Organize (when you feel like it)

The property chips under a note's title are its frontmatter. Give notes a
shared `type:` and they become rows in a database — same files, new view:

| release | status |
| --- | --- |
| [[Slow Bloom EP]] | in review |
| [[Static Bouquet]] | live |

The seeded releases and the [[Rondo MX180]] gear note are sample data — open
one, look at its chips, then replace them with your real catalog whenever
you're ready.

- [ ] tasks render as real checkboxes — click this one
- [x] done items get struck through

## 4 · Dashboards and sheets

- [[Start Here]] explains what a dashboard is
- [[Label Overview]] is a live one: cards and charts reading the [[Catalogue]]
  sheet and the release notes — all seeded in this vault, delete freely

## 5 · Make it yours

- **⌘,** — settings (quick-capture hotkey, tray behavior, the works)
- **⌘/** — every keyboard shortcut
- **⌘⇧T** — a built-in terminal over the vault. If you use an AI agent CLI
  (claude, codex…), it starts here with your notes as its working folder. The
  vault ships with orientation files for agents — `AGENTS.md` and `CLAUDE.md`
  at the root. They stay out of your notes and search so this vault reads as
  yours, not the tooling's; they're normal files in Finder, and the
  "Show agent files" switch in settings lists them in-app. The seeded
  `/setup` command interviews you and writes agent skills fitted to your
  actual notes.
