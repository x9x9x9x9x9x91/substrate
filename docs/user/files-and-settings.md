# Files, settings, and views

Substrate is a window onto a folder of plain files. Almost everything it shows
you is a file you could open in any other editor, and almost every preference is
a line of text in a note. That is the point — but it means the app sometimes
shows you less than the folder contains, or renders a note as something other
than text. This page explains the places that surprise people.

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
was deleted. Turn on **Settings (⌘,) → General → Show app files** and it appears again,
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

## A folder shown as a database, without importing it

A **mount** points the app at a real folder somewhere else on your disk — an
Ableton project pool, a scan archive, a photo tree — and shows it as a
database. Every file that matches is a row. Nothing is imported and nothing is
copied: the files are read for their name, size and modified date, and the
folder is strictly read-only. Substrate never writes, moves, renames or
deletes anything inside it.

Mount one from the sidebar's Folders **+** menu → **Mount a folder…**: pick the
folder, name the database, and optionally give file-name patterns (`*.als`) so
only the files you mean become rows. The first scan runs on the spot.

No note is written until you say something about a row. Annotate one — add a
prop, write in it — and a single sidecar note is created for that one file.
Everything else stays a row in an index.

Where the folder lives is remembered **per machine, outside the vault**. That
is deliberate: the same folder sits at a different path on every Mac, and on
some it isn't there at all. So a synced vault carries the mount and its rows,
but not your paths. On a machine that has no binding, the board still shows the
last-known rows, marked missing, with a **Locate folder…** button. That is a
normal state, not a broken vault. **Unmount** drops the mount and its index and
leaves your sidecar notes as ordinary notes; the mounted folder is untouched
either way.

## When a dashboard asks to run code

Most dashboards are plain markdown. A few are a **custom kind** — real
JavaScript in `.vault/kinds/`, which you may have written, been handed in a
shared folder, or installed with a cookbook recipe.

That code never runs on arrival. Open the dashboard and you get a review
instead of a rendered pane: the kind's title and description, its author when
it names one, the file it runs, how many files the bundle has, and an **Open
the code** button that shows you those files in Finder before you decide (it
reveals them — it never opens them). Under that are the three terms, in full:

- Custom kinds run with the same access as Substrate itself — your whole vault,
  read and write.
- Enabling applies to this vault on this device only. Other devices ask again,
  even after a sync.
- Consent is pinned to those exact files. If the code changes, it stops running
  until you look again.

Nothing is pre-ticked and nothing enables itself. Not deciding leaves the kind
not running. Consent lives on the machine, never in the vault, and you can take
it back at any time under **Settings (⌘,) → Vault → Kinds**, which lists every
kind installed in this vault and what this machine said to each. That section
is absent in a vault that has never installed one.

## See also

- [Sync and security](sync-and-security.md) — what leaves your Mac, and what a
  share relay token in `Settings.md` means for a synced vault.
- [Troubleshooting](troubleshooting.md) — the short version of the surprises
  above.
