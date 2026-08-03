---
name: setup
description: "Interview the user about their work and write skills fitted to THIS vault into .claude/skills/. Use when the user says /setup, asks to set up or configure their vault's agent, wants a new skill, or asks what this agent can do for them. Safe to run repeatedly — it adds skills without touching existing ones."
---

# /setup — build this vault's skills by asking

Substrate vaults ship with no prebuilt skills on purpose. A triage skill that
doesn't know the user's real types and folders is worse than none: it invents a
schema and files things into folders that don't exist. So this skill looks at
the vault first, asks a few questions, and writes skills grounded in what is
actually there.

Read `AGENTS.md` at the vault root before anything else — it is the format
contract you and the generated skills both depend on.

## 1. Look before you ask

Never propose against an imagined schema. Gather, quietly:

- `.vault/schema.json` — the real databases and their property names, kinds, and
  select options. This is the backbone of everything you generate.
- `.vault/folders.json` — external folders mirrored in (may not exist).
- `.vault/views.json` — sidebar order and saved views; tells you what the user
  actually looks at.
- Top-level folders, and how many notes are in each.
- `Inbox/` — how full is it, and what do captures actually look like?
- A sample of 5–10 real notes across the biggest types. Read the bodies, not
  just frontmatter. You are learning the user's conventions.
- `.claude/skills/` — what already exists, so you don't propose a duplicate.

If the vault is nearly empty (only seeded sample content), say so and shift the
interview toward what the user *plans* to keep, not what's there.

## 2. Interview — few questions, concrete, with defaults

Open with one or two sentences of what you found ("You've got 140 notes,
databases for `trip` / `recipe` / `contact`, and 23 unfiled things in Inbox").
That grounds the conversation and proves you looked.

Then ask **at most three or four questions**, in the user's language, each with
a recommended default so answering is optional:

- What do you capture most, and what happens to it after? (→ triage / filing)
- Is there a routine you do on a schedule — a daily plan, a weekly review, a
  month-end roll-up? (→ review skills)
- Is there something tedious you'd hand off if you could? (→ the interesting one;
  listen for the actual verb)
- Anything the agent should never touch?

Do not produce a form or a wall of options. If the user answers vaguely, pick
the recommended default and move — you can always run again.

## 3. Adapt a shape, don't paste one

You have a small catalog of starting shapes. Each is a skeleton, not a template
to copy — the generated skill must name the user's real types, properties,
option values, and folder paths, or it is worthless.

- **Inbox triage** — read each untyped note in the capture folder, propose a
  `type` + properties from the user's actual schema, move to the type's home
  folder, or discard. Apply only on confirmation.
- **Daily / weekly review** — gather what changed, what's due (using the real
  date properties in the schema), what stalled; write a note or update a
  dashboard.
- **File this note** — take one note and place it: right type, filled
  properties, links to related notes found by searching the vault.
- **Dashboard refresh** — recompute a dashboard or sheet from the notes that
  feed it, appending rather than rewriting.

Beyond these, invent whatever the interview actually asked for. The catalog is a
floor, not a ceiling.

Rules for every skill you write:

- Name the vault's real types and folders in the instructions. If the user's
  database is `track` with a `status` of `sketch|mixing|mastered`, say those
  words — never `type: item` or "the appropriate status".
- Include the format rules that matter for what it does (flat frontmatter,
  unchecked checkbox = key removed, wikilinks are body-only). Cross-reference
  `AGENTS.md` rather than restating all of it.
- Say explicitly what the skill may write and what it must confirm first.
  Destructive or bulk operations always propose before applying.
- Keep it a page. A skill is read under a context budget.

## 4. Write, then show

Write each to `.claude/skills/<kebab-name>/SKILL.md` with frontmatter:

```markdown
---
name: <kebab-name>
description: "What it does and when to use it — this is how it gets discovered, so name the trigger phrases the user would actually say."
---
```

Then tell the user, in plain text, what you created and what each one does — one
line each, plus the command to run it (`/<name>`). Offer to walk through one on
real data right now; a skill that has never run once is a guess.

## 5. Running again

This skill is re-runnable and additive. On a repeat run:

- **Never clobber an existing `SKILL.md`.** If a proposed name is taken, either
  pick a different name or offer to revise the existing one — showing the diff
  and asking first.
- Skip questions the existing skills already answer; ask what's new.
- Mention any existing skill that has drifted from the schema (references a type
  or property that no longer exists) and offer to fix it.

Skills live in the vault, so they sync to the user's other devices and version
with their notes. They belong to the user — say so, and tell them they can edit
any of these files by hand.
