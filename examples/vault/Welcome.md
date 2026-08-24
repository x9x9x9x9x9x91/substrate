---
created: 2026-07-23
---
# Example vault

A tiny, fully fictional vault showing Substrate's moving parts. Copy it out of the
repo and open it:

```sh
cp -r examples/vault ~/SubstrateDemo
VAULT_DIR=~/SubstrateDemo npm run tauri dev
```

What's inside:

- **A database** — the notes in `Releases/` share `type: release`, so the sidebar
  shows a "release" database with select colors and a relation to `contact` notes
  (schema in `.vault/schema.json`).
- **A sheet** — [[Holdings]] holds a csv fence plus formulas (computed columns and
  named summaries).
- **Dashboards** — in `Dashboards/`: [[Portfolio]] (metrics cards over the sheet),
  [[Release Charts]] (chart fences over the database), [[Home]] (a hub page with
  callout cards and an embedded live view), [[Food]] (net-kcal tracker reading
  [[Food Log]]), [[News]] (a curated feed reading [[News Items]]), [[Tasks]] (a
  working board over the `task` notes in `Tasks/` — late work first, with
  checkoff, inline edits and quick-add).
- **Links** — wikilinks like [[Holdings]] connect notes; backlinks render at the
  bottom of each note. Follow a link to a missing note and it's created.

Everything is a plain markdown file — open any of them in another editor and the
app picks up the change live. The full on-disk contract is
`docs/vault-format.md`; the dashboard guide is `docs/dashboards.md`.
