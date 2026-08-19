# Files, settings, and views

Substrate is a window onto a folder of plain files. Almost everything it shows
you is a file you could open in any other editor, and almost every preference is
a line of text in a note. That is the point — but it means the app sometimes
shows you less than the folder contains, or renders a note as something other
than text. This page explains the three places that surprises people.

## Some files are indexed but hidden

A new vault is seeded with a few files the app itself owns at the vault root:

- `Settings.md` — your app settings, as note properties.
- `AGENTS.md` and `CLAUDE.md` — orientation for a command-line assistant run
  from the built-in terminal panel. They describe the vault format, not your
  notes.

By default these do not appear in note lists, search, the command palette,
sidebar counts, or wikilink completion, so a fresh vault reads as your blank
slate rather than as the app's scaffolding.

They are still ordinary files. They are on disk, in Finder, in your backups, in
sync, and in the app's own search index — only the app's note surfaces filter
them out. Wikilinks pointing at them still resolve and open.

The consequence to know: **if you create a file at the vault root with one of
those exact names in another editor, it will not show up in Substrate.** Nothing
was deleted. Turn on **Settings (⌘,) → Show app files** and it appears again,
alongside the seeded ones.

Only those exact root filenames are affected. A note of your own called
`agents notes.md`, or a `CLAUDE.md` inside a subfolder, is normal content and is
never hidden.

## Some notes open as a grid instead of text

A note whose `type:` property is `sheet` is a spreadsheet: the app reads the CSV
and formula blocks in its body and renders an editable grid instead of the text
editor. That is deliberate, and it is why you cannot type prose into it the way
you can in any other note.

The way back is the **note icon** in the sheet's toolbar — **View note source**.
It swaps the grid for the normal editor on the same file, so you can fix the raw
CSV, edit the formulas, or write body text around them by hand. The **← grid**
button returns you to the table.

If you did not mean for a note to be a sheet at all, open its source (or its
properties) and change or remove the `type: sheet` line; it becomes an ordinary
note again.

## Which settings win

App settings live in `Settings.md` at the vault root, as note properties. There
are three ways to change them, and they are not three separate stores:

1. **The Settings sheet (⌘,)** is a typed form over that same note. Editing a
   field writes the matching property into `Settings.md` — nothing is kept
   anywhere else.
2. **Editing `Settings.md` directly** — in Substrate, or in any other editor —
   is equally valid. The app reloads it within about a second of the save, so
   the change takes effect without a restart.
3. **Deleting a line in `Settings.md`** is the way back to stock behaviour for
   every setting: an absent property means "use the default". Clearing a field
   in the form does the same for text fields, with two caveats. Clearing the
   relay URL field does not restore the hosted default — it turns "Send as
   link" off (the form writes `disabled`); delete the `share-relay-url` line in
   the note when you want the default back. And toggles never remove their
   property: switching one off and on leaves an explicit value in the note,
   which behaves like the default but is written out.

So the rule for the first two is simply: **the file is the setting, and the last
write wins.** The form is not a separate copy that can drift; it reads the note
when it opens and writes back to it when you commit a field. If you have the
sheet open and edit the note in another window, close and reopen the sheet to
see the new values.

Per-view preferences are the one place where something can override a setting,
and it is always the narrower scope that wins:

- **A single database's own layout choices** — column widths, sort, and which
  columns show — are stored per database in the vault's view preferences, not
  in `Settings.md`. They never had a global setting to conflict with. The one
  true override is the table's **grid lines**: a database's own grid choice
  wins over the global `db-grid` setting for that database only.
- **A database with no choice of its own follows the global setting.** Toggling
  a database back to what the global says clears its override rather than
  pinning the value, so it goes back to following the setting from then on.

Everything else in `Settings.md` — the hotkey, the terminal panel, appearance,
the network switches — is global and has no per-note override.

One caveat worth knowing if you sync a vault across machines: `Settings.md` is
an ordinary note, so it syncs like any other. Settings that describe *this* Mac —
the capture hotkey, the terminal panel's starting folder — travel with the vault
and land on the other machine too. Adjust them per machine if the paths or key
combinations differ.

The two settings that name a **command to run** — `terminal-command` and the
feed dashboard's `feed-curator` — get one extra guard for exactly that reason:
a synced (or imported, or agent-written) note must not carry code execution.
Each machine asks you to approve the exact command once before it first runs
there; approvals are remembered on the machine, never written into the vault.

## See also

- [Sync and security](sync-and-security.md) — what leaves your Mac, and what a
  share relay token in `Settings.md` means for a synced vault.
- [Troubleshooting](troubleshooting.md) — the short version of the three
  surprises above.
