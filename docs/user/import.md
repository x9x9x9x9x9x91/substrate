# Bring your data in

Substrate reads plain markdown, so "import" is smaller than it sounds: most
data arrives either by opening a folder you already have or by writing files
into the vault. This page covers the supported paths, from zero-setup to
script-based.

## Already have a folder of Markdown files?

Point Substrate at it. On first run (or whenever no vault is configured) the
app shows a picker — under **Open an existing folder**, browse to your folder
and confirm. The choice is stored per machine and takes effect after a
restart; the app tells you so and offers the restart button.

Your notes are read where they are: **nothing is moved, renamed, or
rewritten**. Folder structure is kept as-is — nested folders stay nested, and
notes are never reorganized into the app's own layout.

### What Substrate adds to your folder

Adoption is not inert. It adds its own files alongside your notes — it never
moves, renames or rewrites the notes themselves:

| Path | What it is |
| --- | --- |
| `.vault/` | Substrate's own state for this folder: database schemas, saved views, templates, folder and tag-folder definitions, mounted external folders, calendar subscriptions. **Not** a cache — deleting it destroys that work, and it cannot be rebuilt from your notes. |
| `.git/` | A git repository, created here if the folder isn't one already, holding your version history. See below. |
| `Inbox/` | Empty folder where new scratch notes land. |
| `Settings.md` | App settings as an ordinary note you can edit. |
| `AGENTS.md` | A format guide for any AI tool you point at the folder. |
| `CLAUDE.md` | A one-line pointer at `AGENTS.md`, for agents that only auto-load that filename. |
| `.claude/skills/setup/SKILL.md` | A `/setup` skill for the built-in terminal's agent. |

The search index is not on disk at all — it is built in memory at startup
from the notes themselves, so nothing here is a search cache.

`Settings.md`, `AGENTS.md`, `CLAUDE.md` and the `/setup` skill are written
only when a file of that name isn't already there — your own `AGENTS.md` or
`Settings.md` is never overwritten. (A file that still byte-matches a version
Substrate itself shipped is refreshed to the current text; anything you've
edited is yours and is left alone.) No sample or starter notes are ever
seeded into a folder you adopt — that only happens for a brand-new, empty
vault.

#### Version history and `git`

Version history is git, in the adopted folder itself. Which way that goes
depends on what you point at:

- **Folder that isn't a git repository** — Substrate runs `git init` in it
  and marks the repository as its own. History is on: you get a snapshot per
  change, and the timeline in the app.
- **Folder that is already your git repository** — Substrate leaves it
  completely alone and **history stays off**. It will not commit into a
  repository you own, so an adopted checkout keeps whatever branch, remote
  and working tree it had.

So adopting an ordinary Obsidian vault does create a `.git/` directory inside
it. If you'd rather not have one, keep the folder under your own git
repository before adopting it.

### What carries over from Obsidian (and what doesn't)

Substrate reads plain Markdown, so an Obsidian vault mostly just works — but
it is a different app, not a compatibility layer.

Carries over:

- **`[[Wikilinks]]`** — resolved by note title or filename, case-insensitively,
  wherever the note lives in the tree. Backlinks work off the same index.
- **Link aliases and heading anchors.** `[[Note|shown text]]` shows the alias
  in place of the target, and `[[Note#Heading]]` opens the note scrolled to
  that heading — `[[Note#^block-id]]` to a block ref. An anchor no heading
  answers to leaves the note at the top rather than jumping somewhere
  arbitrary. Backlinks index on the target alone, so an aliased or anchored
  link counts exactly like a plain `[[Note]]`. The `[[` autocomplete offers
  headings and block refs after a `#`, and label suggestions after a `|`.
- **Embeds** — `![[image.png]]` shows the asset instead of the link text, and
  is not counted as a link.
- **YAML frontmatter** — every key is kept. A `type:` line is the one with
  special meaning: notes sharing a type form a database (table, board, chart)
  automatically. Other props become that database's columns.
- **Tags** — inline `#hashtags` and a `tags:` prop are merged into one tag set.
- **Nested folders**, and any file extension other than `.md` (attachments
  stay where they are and are served as assets).
- **Callouts** in the `> [!note]`, `> [!warn]` and `> [!idea]` shapes.
  Other callout types render as ordinary blockquotes.

Does not carry over:

- **Obsidian's own config.** `.obsidian/` is skipped entirely: not indexed,
  not shown, not modified — and so is every other dot-folder that isn't
  Substrate's (it writes only the `.vault/`, `.git/` and `.claude/` entries
  listed above). Your Obsidian setup survives untouched, so you can keep
  using both apps on the same folder.
- **Community plugins.** Nothing in `.obsidian/plugins/` runs.
- **Dataview queries.** A ```` ```dataview ```` block is displayed as a code
  block, not executed. Substrate's equivalent is a ```` ```view ```` fence —
  a live database table inside a note — or a dashboard, built against the
  same `type:` frontmatter the notes already have.
- **Canvas files.** `.canvas` files are left alone but not rendered.

### The two-file guard

A folder is offered with **Open vault** when it has a `.vault/` marker or at
least two Markdown files at its top level. That guard is what stops a stray
pick of `~/Documents`, or a code checkout with one `README.md`, from becoming
a vault by accident.

A vault whose notes all live in subfolders can therefore fall short of it —
you'll get **Initialize anyway** with a warning that the folder holds other
files. Confirming is safe: it means the same adoption as above, the warning
is about Substrate listing those files as notes, and nothing is moved,
rewritten, or seeded.

## From Logseq, Bear or Apple Notes

In the app: **⌘, → Vault → Import**. Pick the source, choose the folder it
exported to, read the preview, confirm. The import reads a folder on your disk
and writes notes into the vault — nothing leaves this machine.

### Nothing is written until you confirm

Choosing a folder does not import it. It builds the whole run first and shows
you what it would do, on a step that has written nothing:

- **The counts** — notes to create, attachments to copy, how many are already
  imported and will be skipped, how many files were skipped.
- **The folder tree** it would write to, with a note count per folder.
- **Why files were skipped**, one line per reason with a count — a graph with
  400 unsupported files is a number, not 400 lines.
- **Name clashes.** Titles that repeat inside the run, and how many notes land
  in a folder that already holds a note of that name. Those land side by side
  ("Idea", "Idea 2"): nothing is ever merged or overwritten.
- **What does not carry over** for that source, in a line or two.
- **One converted note in full**, for Apple Notes — an HTML export is not
  markdown, and a count cannot tell you whether the conversion came out right.
- Subfolders the import could not open, as a count, so a total you compare
  later isn't a mystery.

Reading a large folder reports progress ("Reading 412 of 4820…") and can be
cancelled; cancelling abandons the read, and either way nothing has been
written yet. Only the **Import N notes** button writes. Import is unavailable
while you are viewing history — the note list there is the historical one, so
the check for what is already imported would be wrong.

### Logseq graph

Pick the graph folder itself. `pages/*.md` land in `Imported/Logseq`, and a
namespaced page becomes folders: `work___clients.md` lands as **clients** in
`Imported/Logseq/work`. `journals/` land in the vault's own `Journal/` folder,
dated for the day they name, so an imported day is the same note the app opens
for that date — a journal file whose name isn't a date is skipped rather than
guessed at.

`key:: value` lines at the top of a page become frontmatter. `title`, `type`
and `created` are the vault's own keys, so a page carrying them keeps them as
`logseq-title`, `logseq-type` and `logseq-created`. Properties written inside a
block stay in the body text.

Outline bullets come across as markdown lists: the text survives exactly, and
the block semantics — references, ids, collapse state — do not. Assets a page
embeds are copied in; an asset nothing embeds is skipped and counted. Org-mode
files, markdown outside `pages/` and `journals/`, and pages over a 2 MiB cap
are skipped with that reason.

### Bear export

Pick the folder Bear exported to. Bear has no folders, so tags are the filing:
the note's **first** tag is its folder path under `Imported/Bear`, nested tags
included — `#field/reeds` lands the note in `Imported/Bear/field/reeds` — and
every other tag becomes an entry in the note's `tags` property. The tag text is
taken out of the body, because a tag in Bear is filing written inline. A note
with no tag lands in `Imported/Bear` itself.

The title is the note's leading `# ` heading, which is dropped from the body
rather than written into the note twice; a note without one is titled with the
filename Bear exported it under. A heading further down is a heading and stays
where it was written.

Both export shapes are read. A `Name.textbundle/` directory brings its
`assets/` in as vault assets and takes `created` from its `info.json`, plus
`bear-modified` for the date Bear last touched the note. A plain `Name.md`
carries no dates at all, so those notes are dated the day they land. Bear's
note identifiers, pinned state and archived flag do not come across. A
`.bear2bk` backup and a `.textpack` are zip files this import cannot open —
each is reported as a skipped file saying to unzip it and pick the folder
inside.

### Apple Notes folder

This reads a *folder of exported notes*, not the Notes database. `.html` and
`.htm` files are converted, `.txt` files come across as their paragraphs, and
`.md` files pass through untouched. A subfolder in the export becomes a folder
of the same name under `Imported/Apple Notes`, so the way the notes were
organized is the way they land.

The HTML conversion is deliberately partial, which is why the preview shows you
a finished note before you confirm a folder full of them. Paragraphs and line
breaks, bold, italic, strikethrough, inline code, headings, nested ordered and
unordered lists, checklists, links, blockquotes, horizontal rules and `<pre>`
blocks all have a markdown form and get one. Fonts, colours, sizes and table
layout do not — a table arrives as its cells, one row per line. Anything the
converter doesn't know keeps its words and loses its formatting, so nothing is
dropped without appearing somewhere.

An `<img>` pointing at a file the export actually shipped becomes an
attachment, copied into the vault and re-pointed at as `![[name]]`; one that
resolves to nothing keeps the reference it had. A reference that climbs above
the folder you picked resolves to nothing — an import reads the folder it was
given and no other. A `.md` or `.txt` note is passed through as written, so its
own image links are kept exactly as they are and the files behind them are not
copied in. Apple's export carries no reliable creation date, so these notes are
dated the day they landed.

### What a finished run leaves behind

Notes land under `Imported/<source>` as above, and every run also writes one
record note in `Imported/Logs`: what ran, when, the source folder, the counts,
the skipped files by reason, and a link to every note written. A note that
fails to write does not abort the run — the rest still land, and the log names
the ones that didn't.

### Running it again is safe

Every imported note carries two properties naming where it came from —
`import-source` (the app) and `import-id` (what the note was there). Before an
import writes anything it reads those off the notes already in the vault and
drops from the run everything already carrying a matching pair, which is the
**already imported, will be skipped** line in the preview.

So the right thing to do with an import that was interrupted, or a source
folder that has grown since, is simply to run it again. Two things break the
match, and both write a second copy rather than an error:

- **Renaming the folder you picked.** The folder's own name leads every
  `import-id` — that is what stops two graphs each holding a `pages/Reeds.md`
  from reading as one another's re-runs — so a renamed source is a new source.
- **Losing the stamp on a note.** Deleting those two properties is allowed and
  does nothing else, but a later import no longer recognizes the note. Sealing
  an imported note has the same effect without looking like it: a sealed note's
  properties aren't in the index the import matches against. Unseal or delete
  the note first if a re-run is what you want.

The full contract, including how the stamp resists a source page that carries
an `import-id` of its own, is in
[vault-format §2b](../vault-format.md#2b-import-stamps--where-a-note-came-from).

## Import CSV as a database

In the app: **⌘K → "Import CSV as database…"**, pick a `.csv` file, choose
which columns to keep — the first kept column becomes each note's title, the
rest become properties. Each row becomes one note, and the rows form a
database like any other, so a spreadsheet exported from another tool becomes
tables, boards, and charts without a script.

## From Notion

`scripts/import-notion.ts` pulls one Notion database through Notion's public
API and writes one note per row: properties become frontmatter (names
lowercased), page bodies become note bodies. It runs from a checkout of this
repository, not from the app:

```sh
NOTION_TOKEN=secret_… VAULT_DIR=~/Vault \
  npm run import:notion -- --database "Reading List" --folder "Import/Reading" --type reading
```

Worth knowing:

- You need a [Notion internal integration](https://www.notion.so/my-integrations)
  token, with the database shared to that integration. The token is used for
  the run and never stored.
- `--dry-run` prints what would be written without touching the vault.
- Re-running is safe: rows already imported (matched by their `notion_id`
  prop) are skipped, and existing files are never overwritten.
- One database per run; run it once per database you want.

The full option list (property renaming, fixtures) is in the header of
[`scripts/import-notion.ts`](../../scripts/import-notion.ts).

## From an Ableton project pool

`scripts/import-ableton.ts` turns a folder of Ableton projects into a
folder-backed database — one row per project, with the source tree strictly
read-only (it never parses or touches your `.als` files):

```sh
VAULT_DIR=~/Vault node scripts/import-ableton.ts ~/Music/Projects --type ableton-project
```

Re-running is the rescan: machine-owned props refresh, your own props and
note bodies are never touched, and a vanished project keeps its row flagged
`missing` instead of being deleted. Details in the script's header.

## Everything else

Any tool that can write a markdown file can import into Substrate — the vault
folder is the integration surface, and the running app picks changes up within
about a second. The rules for doing that safely (atomic writes, frontmatter
shape, the one helper script worth copying) are in
[Integrating external tools](../integrations.md).
