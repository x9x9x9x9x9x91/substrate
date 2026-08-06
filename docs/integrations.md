# Integrating external tools

```sh
VAULT_DIR=~/Vault node scripts/append-row.ts reading --title "Seeing Like a State" --prop status=reading
```

**Files are the API.** There is no plugin system, no HTTP endpoint, and no
daemon to register with — an external tool writes plain markdown into the vault
and the running app picks it up within about 300ms. That is the whole
integration surface, and it is deliberate: anything built on it keeps working
when Substrate is closed, when it is uninstalled, and when the vault is opened
in another editor. A note becomes a database row purely by carrying a `type:`
prop ([vault-format §4](vault-format.md#4-databases-and-prop-values)); nothing
registers it.

This guide is the practical version. The contract itself lives in
[vault-format.md §13 (rules for external writers)](vault-format.md#13-rules-for-well-behaved-external-writers)
and [§13.1 (concurrency)](vault-format.md#131-concurrency-contract) — deep-link
there rather than trusting a summary.

## What the watcher guarantees

The app watches the vault root recursively (FSEvents via `notify` v8) with a
300ms debounce (`src-tauri/src/vault/watch.rs:151`). When the vault goes quiet,
the engine applies the changed paths and emits `vault:changed`
(`src-tauri/src/lib.rs:689`); the UI listens in `src/hooks/useVaultEvents.ts:68`
and refreshes. No restart, no manual refresh, no "rescan" button.

- **Bursts collapse.** More than 500 changed paths in one batch escalates to a
  full rescan instead of per-path work (`RESCAN_THRESHOLD`,
  `src-tauri/src/vault/mod.rs:892`) — a bulk import lands as one refresh.
- **Failure is bounded, not silent.** If the watcher can't be constructed, the
  app falls back to a 45s poll (`watch.rs:52`) and tells the UI via
  `vault:watch-degraded`. Worst-case staleness is 45 seconds, never forever.
- **Bodies are never cached.** Opening a note always hits disk; only the
  metadata, link, and search indexes lag, and only for that window.
- **Hidden paths are invisible.** Nothing under a `.`-prefixed component is
  indexed, searched, or watched — with one exception: `.vault/schema.json`,
  `.vault/views.json`, and `.vault/folders.json` are watched and surface as a
  separate `vault:config-changed` event.

The app can't tell your write apart from its own by looking at the event — every
app write comes back through the same watcher, so it attributes its own echo by
path and time window (`src/lib/ownwrites.ts`). You don't have to do
anything about this; it's just why there is no "who wrote this" field.

## The one rule that matters: shape your writes as appends

**A direct file write has no concurrency guard. Last writer wins on disk**
([§13.1](vault-format.md#131-concurrency-contract)). There is no lock you can
take, no advisory file, and no transaction spanning two files. So the safety of
an integration is decided entirely by the *shape* of its writes:

1. **Create new files.** A script that only ever creates notes cannot lose a
   keystroke, because it never reads a body it might write back stale. This is
   what `scripts/append-row.ts` does and why it is the blessed shape.
2. **Append to files no human edits.** Log files, scraper output, generated
   sheets — read-modify-write is fine when you're the only writer.
3. **Write atomically.** Temp file in the *same directory*, then rename. A torn
   write can otherwise be indexed mid-state. (Same directory because rename is
   only atomic within one filesystem — `/tmp` usually isn't.)
4. **Never rewrite a note wholesale that a human might have open.** If you must
   modify an existing note the user edits, prefer the app's IPC
   `vault_write_body`, which carries an `expected_body` compare-and-swap
   (`src-tauri/src/commands/notes.rs:34`) and fails instead of clobbering.

Rule 4 is the one that bites. A script that reads a note, waits, and writes it
back will silently discard everything the user typed in between — the app's
guard protects the *app's* writes, not yours.

## What actually happens when you race an open editor

Verified against the code, not aspirational:

**The note is open and clean (no unsaved edits).** Your write is adopted in
place, silently. The pane sees `vault:changed`, re-reads, and replaces the
editor document (`src/components/NotePane.tsx:575-584`); the pane never
remounts, and the caret is kept where it was (clamped to the new length rather
than remapped, `Editor.tsx:1811-1825`). Nothing is lost and no banner appears —
this is the good case, and the common one. The adopt is deliberately kept out of
the undo history, so the user's next ⌘Z doesn't revert your change and autosave
the stale body back over it.

**The note is open and dirty (unsaved edits in the buffer).** Your write lands
on disk immediately — nothing stops it. The app then **refuses its own next
save**: it passes the body it last read as `expected_body`
(`NotePane.tsx:435-439`), the engine compares it against disk and returns
`conflict: file changed on disk` *before* writing
(`src-tauri/src/vault/mod.rs:1190-1193`, the `write_atomic` call is at `:1200`).
The user gets a banner offering **Reload** or **Overwrite**
(`NotePane.tsx:1378-1386`); their pending text is held in the buffer, not
discarded, and further auto-saves are suppressed until they choose.

So the app never clobbers you. **You can still clobber the user** — the
compare-and-swap is on the app's write path only. Your `open()`/`write()` has no
equivalent, which is why rules 1–4 above are about write shape rather than
locking.

Regression coverage for the guard: `write_body_expected_body_guard`
(`src-tauri/src/vault/mod.rs:2370`) and step 7 of the real-app smoke run
(`src/lib/smoke.ts:226-239`).

## Writing a row

Frontmatter is a flat YAML mapping starting at byte 0
([§2](vault-format.md#2-notes)). Values are plain YAML scalars
([§4](vault-format.md#4-databases-and-prop-values)):

```markdown
---
type: gear
category: mixer
status: in studio
released: 2026-08-02
price: 1299.50
tags: [vinyl, promo]
---
```

Things worth knowing before you generate one:

- **Dates are `YYYY-MM-DD` strings**, optionally a space and 24h `HH:MM`
  (`2026-08-02 14:30`). `T` as separator is tolerated on read; the space form is
  canonical on write. A range is two of those joined by `/`.
- **Filenames follow titles.** Create the file at the sanitized title:
  `/ \ : * ? " < > |` become spaces, whitespace collapses. When sanitizing was
  lossy, add the exact title as a `title:` prop. A stem starting with `.` or a
  title containing `[` or `]` is **rejected by the engine** — don't write one.
- **Quote defensively.** `Vessel: Songs` unquoted parses as a nested mapping;
  `true` and `4` become a bool and a number. A double-quoted JSON string is
  always a valid YAML scalar, which is the easy way out.
- **Don't depend on key order or your own quoting.** The app re-serializes the
  whole frontmatter alphabetically the first time a prop is edited.
- **Don't write `.vault/schema.json`.** Option lists live there
  ([§6](vault-format.md#6-vaultschemajson--database-schema)), but an entry with
  `options: []` and no `kind` is the *demote* form and removes the prop
  entirely. Off-schema props are legal on disk — they render as plain chips.
  Leave the file alone and let the user register props in the UI.
- **Don't bump `.vault/format.json`**
  ([§5b](vault-format.md#5b-vaultformatjson--config-format-versions-covers-68)).
  A version above the app's makes that config read-only until it updates.

## Snippet: the helper

`scripts/append-row.ts` creates exactly one note and stops. It handles the
title sanitizing, the YAML quoting, filename dedupe, and an exclusive atomic
create that refuses to overwrite an existing file.

```sh
VAULT_DIR=/tmp/vault-demo node scripts/append-row.ts reading \
  --title "Seeing Like a State" \
  --prop author="James C. Scott" \
  --prop status=reading \
  --prop started=2026-08-03 \
  --body "Picked up after the vault-format rabbit hole."
```

```markdown
---
author: James C. Scott
created: 2026-08-03
started: 2026-08-03
status: reading
type: reading
---
Picked up after the vault-format rabbit hole.
```

`--dir <subfolder>` files it somewhere other than the vault root; use `/` as
the separator on every OS. Traversal, hidden folders, and any existing symlink
that resolves outside the canonical vault are refused before a directory or
file is created. `--dry-run` prints without writing. If `.vault/schema.json`
registers the type, unknown props and off-list select values print as warnings
— the row is still written, and the schema is never touched. `VAULT_DIR` is
required and has no default, on purpose: an unset target would mean the real
vault.

Its deliberate limits: one note per run, scalar props only (a `[a, b]` list
needs a raw write), and it will not overwrite. When the filename is taken it
files `Title 2.md`, `Title 3.md`, and so on rather than merging into an
existing note — the caller decides what to do about the duplicate. **This CLI
surface is frozen**: documenting it is the commitment, so new needs get a new
flag at most, never a changed meaning for an existing one.

## Snippet: raw markdown, no dependencies

A heredoc is a legitimate integration. Any language that can write a file can
write a row:

```sh
cat > "$VAULT_DIR/Kraftwerk - Autobahn.md" <<'EOF'
---
artist: Kraftwerk
created: 2026-08-03
rating: 5
type: listening
---

Side A is the whole record.
EOF
```

This is not atomic — fine for a one-off, wrong for a script that runs
unattended. The atomic version, in Python, with the quoting and title rules
inline:

```python
#!/usr/bin/env python3
"""Write one Substrate row with no dependencies: temp file + atomic rename."""
import json, os, pathlib, re, sys, tempfile

VAULT = os.environ.get("VAULT_DIR")
if not VAULT:
    sys.exit("VAULT_DIR is not set — name the vault explicitly, never default to ~/Vault")

BARE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 .,_&()+/'-]*$")
WORDY = re.compile(r"^(true|false|null|yes|no|on|off)$", re.I)

def scalar(v):
    """Bare when YAML would read it back as this exact string, else quoted."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return str(v)
    s = str(v)
    if s and BARE.match(s) and not WORDY.match(s) and not s.endswith(":"):
        return s
    return json.dumps(s)   # JSON strings are valid YAML double-quoted scalars

def write_row(title, props, body=""):
    stem = " ".join("".join(" " if c in '/\\:*?"<>|' else c for c in title).split())
    if not stem or stem.startswith(".") or "[" in title or "]" in title:
        raise ValueError("Substrate refuses this title (empty, leading dot, or [ ])")
    fm = "\n".join(f"{k}: {scalar(v)}" for k, v in sorted(props.items()))
    path = pathlib.Path(VAULT) / f"{stem}.md"
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(f"---\n{fm}\n---\n{body}")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)     # atomic: readers see the old note or the new one
    return path

print(write_row(
    "Ableton Session 2026-08-03",
    {"type": "session", "created": "2026-08-03", "bpm": 138, "mood": "spectral, low-slung"},
    "Bounced two takes. The second one keeps the tail.\n",
))
```

The dotted temp name keeps the half-written file invisible to the indexer and
the watcher while it exists. `os.replace` is atomic within a filesystem, which
is why the temp file is created in the note's own directory.

## Checking your work

**Vault doctor** is the read-only integrity report: ⌘K → "Vault doctor"
(`src-tauri/src/vault/doctor.rs`, IPC `vault_doctor`, `src/lib/ipc.ts:204`). It
reports, never repairs. For a script that just wrote rows, the finding to look
for is `invalid-prop` — a `date` or `number` prop whose value doesn't parse
under the schema's kind, reported and never rewritten
([§15](vault-format.md#15-vault_doctor--the-read-only-integrity-report),
`vault-format.md:2212`). `broken-link` and `broken-embed` catch wikilinks and
embeds pointing at nothing.

A prop that parses but isn't in the schema won't be flagged at all — that's
legal, not broken. If a row doesn't appear in a database view, the cause is
almost always the `type:` string: matching is exact and case-sensitive.

## Linking into the app: `substrate://`

Files are how you get data in; `substrate://` links are how you point a human
at it. Anything that can open a URL — a shell script, a note in another app, an
HTML page, a calendar invite — can hand Substrate one of two:

```sh
open "substrate://note/Inbox/Some%20note.md"   # bring the app up on that note
open "substrate://capture"                     # the ⌥Space capture box
open "substrate://capture?text=call%20the%20studio"   # …prefilled
```

The note path is **vault-relative and percent-encoded**, ends in `.md`, and is
resolved against the vault index — not the filesystem. The rules, in full:

- Relative only. A leading `/`, a `..` segment in any spelling (literal,
  `%2e%2e`), or a separator smuggled inside a segment (`%2f`, `\`) is refused.
  Nothing outside the vault is reachable, by construction.
- The app must be pointed at the vault that contains the note. A link is a
  location within *the open vault*, not a way to switch vaults.
- **A link that resolves to nothing still opens the app and says so.** A miss
  is a message, never silence — so a stale link in somebody's notes reads as a
  stale link, not as a broken app.
- Unknown routes (`substrate://something-else`) are refused the same way. The
  two above are the whole surface.

Cold start is handled: a link that arrives while the app is launching queues
until the vault is loaded, then opens. Scheme registration comes from the
packaged app, so `substrate://` works once Substrate has been installed and
launched at least once (not from a dev build).

## Existing integrations to read

Two importers in this repo follow the pattern at real scale, and both are worth
copying from rather than inventing against:

- **`scripts/import-ableton.ts`** — a folder of Ableton projects becomes a
  folder-backed database. Re-running is the rescan: machine-owned props refresh
  in place, user props and bodies are never touched, and a vanished project
  keeps its row flagged `missing: true` instead of being deleted. The source
  tree is strictly read-only.
- **`scripts/import-notion.ts`** — one Notion database over the public API
  becomes one note per row: properties are lowercased into frontmatter, `type`
  is forced so the rows form a Substrate database, and page bodies become note
  bodies. The remote side is read-only; nothing is written back to Notion.

Both share `scripts/vault-title.ts` (the engine's title and filename rules,
mirrored and tested) and `scripts/vault-target.ts` (`VAULT_DIR` resolution and
atomic write). Use those two modules instead of re-deriving the rules.

## What this is not

There is no HTTP endpoint, no webhook, and no plugin lifecycle — none of these
are planned, because each one is a second API that can disagree with the files.

Two doors do exist beside the files, and neither is an exception to that rule:
the MCP door for AI clients and the CLI door for scripts are the *same*
sidecar, spawned per call, speaking to the same scoped operation layer.
They add a permission boundary — a folder is invisible until you grant it in
Settings — rather than a second definition of what a note is, and every write
lands as an ordinary file with a git receipt. One contract, not two: the CLI
door has no permission logic of its own to drift from the MCP door's. Nothing
listens on a port and nothing runs between calls.

When the app is *running* and you want the engine's
own guarantees — link rewriting on rename, snapshot batching, the
compare-and-swap — the IPC surface
([§14](vault-format.md#14-the-ipc-surface-preferred-operations)) is the better
door. When it isn't running, or the work is bulk, files are not the fallback:
they're the design.
