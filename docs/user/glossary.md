# Glossary — the words that mean more than one thing

Substrate re-uses a small number of ordinary words, and a few of them mean
different things in different corners of the app. That is mostly harmless
until you read two of them on one screen. This page is the reference for
those words: what each meaning is, where you meet it, and which meaning the
rest of the documentation uses when it says the word without qualifying it.

Nothing here is a feature description. Each entry links to the page that
explains the thing properly.

## view

Five different things wear this word.

**1. A saved view — the one the docs mean by default.** A named cut of one
database: its filter query, its sort, its layout, and which columns show,
saved together under a name you choose. You make one with **Save view**
beside a database's filter bar. It then appears twice — as a tab across the
top of that database, and as a row in the sidebar nested under the database
it belongs to. `⌘5`–`⌘9` open the first five in sidebar order. On disk it
lives in `.vault/views.json` under `$views`. A saved view is also called a
**pin** in places (see *pin*, below) — same object, older name.

**2. A layout.** List, table, board, or gallery — the four ways the same
database entries can be drawn. In the app this control is always labelled
**Layout**, and the docs always call it a layout. It is worth knowing that on
disk it is stored under a key spelled `view`: `"view": "board"` in
`.vault/views.json`, and a `view:` line inside a ` ```view ` fence. That key
name is history. Read it as "layout".

**3. A ` ```view ` fence.** A block you put in a note's body that renders a
live, editable table of a database inside the note — prose with a real cut of
your data in the middle of it. Its own `view:` line is meaning 2 again, not
meaning 1; the line that names a saved view is `saved:`.

**4. The screen you are on.** Loose English, used in shortcut descriptions
and hover help: "walk back through view history", "the shortcuts that apply
to the view you are currently using". The notes list, the calendar, a
database, a dashboard, the Drive Shelf — each is a view in this sense. A
dashboard's own description ("a purpose-built view assembled from live vault
data") is this meaning too.

**5. The info view.** The panel docked in the lower-left that explains
whichever control the pointer is over. It is named after the Ableton Live
panel it borrows from, and it has nothing to do with the other four.

One more sighting, outside the app: a saved view can be exported as a folder
of links, and that folder carries a `.substrate-view` marker file. See
[export and uninstall](export-and-uninstall.md).

**Reading rule.** In these docs, an unqualified "view" is meaning 1. Meaning
2 is always written "layout". Meanings 3–5 are always named in full — "a
`view` fence", "the info view", or the surface itself.

## pin

**1. A saved view.** The **Save view** button's own tooltip reads "Pin this
filter to the sidebar", the `⌘5`–`⌘9` shortcuts are described as pin order,
and the vault format calls a saved view a pin throughout. If something talks
about a pin's query, columns, sort, menu, or exported folder, it means a
saved view.

**2. A pinned note.** Any note can be pinned to the sidebar from its row menu
(**Pin to sidebar**, and **Remove pin** to undo). This is a separate list —
`pins` in `.vault/views.json` — and it holds note paths, not views. Pinning
and unpinning never touch the note file. A pinned note's row appears under
its home folder in the Folders tree, or in a flat **Pinned** section when it
has no folder row to sit under.

So the sidebar can show you two kinds of pin at once: saved views under their
databases, and pinned notes under their folders.

**3. Picked for today.** On the tasks board, a task you have picked for today
carries `today:` with that date — the same mark the Today pane's Pick verb
writes — and shows a **Picked for today** marker. It is about attention, not
about the sidebar.

**4. Pin as a plain verb** — fixing something in place. A custom kind's
consent is *pinned* to exact files, so changed code stops running until you
look again. A database's grid-line choice, once set, *pins* that database to
its own answer instead of following the global setting. These are English,
not a Substrate object.

## database, type, collection, kind

These four circle the same idea and none of them is a synonym for another.

**type** — the note property. A note joins a database by carrying a `type:`
line in its frontmatter; nothing moves and no file is created. On disk the key
is always `type:`. The app's own interface presents that property to you as
**Database**, so the same fact has one name in your files and another on
screen.

**database** — every note sharing a `type` value, plus its entry in
`.vault/schema.json` (icon, home folder, property definitions). A type
registered in the schema is a database even with zero notes in it, which is
what **New database** creates. This is the user-facing word; prefer it to
"type" everywhere except when talking about the frontmatter line itself.

**collection** — not a Substrate object at all. It appears in the app's own
help text as plain English for a database ("a typed collection of notes").
It also describes **a tag's collection**: every note carrying a given `#tag`,
which you can open like a list but which has no schema, no columns, and is
not a database. If you read "collection", check which of those two is meant;
the docs avoid the word for that reason.

**kind** — two unrelated on-disk meanings, and neither is `type`.

- In `.vault/schema.json`, a property's `kind` is its **field type** — `text`,
  `date`, `number`, `checkbox`, `select`, `multi`, `relation`, `file`, `url`,
  `email`, `phone`. The inversion worth committing to memory: on a relation
  property, `kind` says "this is a relation" and `type` says **which database
  it points at**. So within one property definition, `type` means database and
  `kind` means field type — the exact opposite pairing you might guess.
- A dashboard note's `dashboard:` line names its **kind** — which renderer
  draws the page. A **custom kind** is a renderer you install into
  `.vault/kinds/` yourself; see [files and settings](files-and-settings.md)
  for what the app asks before running one.

## mount, drive, shelf

All three are about content that lives outside the vault folder.

**mount** — a real folder somewhere else on your disk, shown as a database.
Every matching file is a row; nothing is imported and nothing is copied, and
the folder is strictly read-only. No note is written until you say something
about a row, at which point one sidecar note is created for that one file. A
mount is split in two on purpose: its identity, name and file patterns sync
with the vault, while the local path it points at is remembered per machine
and never syncs. Full explanation in
[files and settings](files-and-settings.md).

**drive** — an external volume Substrate has cataloged. Mechanically it is a
mount the app made for a whole disk, so it inherits everything a mount has: a
last-known index that syncs, sidecar notes bound to files, a place in search.
What makes it a drive is that it stands for a removable disk, so the catalog
is built to be read with the disk unplugged, and every number it shows comes
with the date that number was last true. Cataloging is read-only: nothing is
ever written to a disk Substrate catalogs.

**shelf** — the **Drive Shelf**: the pane listing every drive this vault has
cataloged, online ones first, reachable from the sidebar's **Drives** section
via **All drives**. It is a place to browse and search catalogs, including
catalogs of disks that are in a drawer. "Shelf" never means a mounted folder,
and never means a folder inside your vault.

Not in this family, despite sounding like it: a **folder** is an ordinary
folder inside the vault, and a **tag folder** is a saved tag query that gets
a folder-shaped row in the sidebar. Neither reaches outside the vault.

## See also

- [Files, settings, and views](files-and-settings.md) — mounts, per-database
  layout preferences, and what a custom kind asks before it runs.
- [Bring your data in](import.md) — what `.vault/` holds, and importing a CSV
  as a database.
- [Export and uninstall](export-and-uninstall.md) — exporting a saved view as
  a folder of links.
