# Contributing

Thanks for looking. Two things are worth knowing before you spend time.

## This repository is a mirror

Canonical development happens in a private upstream repository. What you see
here is a one-way mirror: sanitized snapshots of that repo's `main`, published
as fresh commits. Nothing pushed here flows back automatically, and the mirror's
history is snapshots rather than the real commit history — so a `git log` here
tells you what shipped, not how it was built.

Practically:

- **Issues are welcome and are read.** Bug reports, questions, and feature
  ideas all belong here. Include your OS, the app version, and — if a specific
  note or vault triggers it — the smallest file that reproduces it.
- **Pull requests are welcome too, with a caveat.** They cannot be merged here,
  because merging into a mirror would be overwritten by the next snapshot.
  Instead a maintainer applies the change upstream, with attribution, and it
  appears in a later snapshot. Your PR is then closed with a pointer to the
  commit that carries it. This is slower than a normal merge — if you are
  planning something large, open an issue first so it isn't wasted work.
- **Security issues do not go here at all.** Use GitHub's private vulnerability
  reporting: the **Security** tab → **Report a vulnerability**. See
  [SECURITY.md](SECURITY.md).

## Style and tests

If you don't know which part of the tree your change belongs in,
[docs/architecture.md](docs/architecture.md) is the map — front end vs engine,
the IPC boundary between them, and what the mock/e2e lane can and cannot prove.

Match the code around what you touch — the codebase is fairly uniform, and the
existing patterns are the style guide. Beyond that:

Use Node.js 22.6 or newer and install the lockfile exactly with `npm ci`. Before
the first browser test, install its browser with `npx playwright install chromium`.

- Typecheck must be clean: `npx tsc --noEmit`.
- The node suite must pass: `npm test` (covers `src/lib/*.test.ts` and the
  `scripts/` suites).
- The Rust engine tests must pass: `cd src-tauri && cargo test`.
- Lint is errors-only: `npm run lint`.
- If you touched UI, exercise it: `npm run dev` serves the front end against a
  deterministic mock backend in a plain browser — no Tauri build needed. The
  Playwright smoke (`npm run e2e`) runs against that same mock.

New behavior wants a test at the level it lives at: a pure function gets a node
test, a vault/engine change gets a Rust test, a user-visible flow gets an e2e
spec. A change to the on-disk vault format also updates
[docs/vault-format.md](docs/vault-format.md) in the same change — that file is
the format's contract, not a description of it.

## Licensing

Substrate is AGPL-3.0-only ([LICENSE](LICENSE)). By contributing you agree your
contribution ships under that license.

The webfonts bundled with the landing page are third-party and stay under their
own terms — all three are SIL Open Font License 1.1, reproduced with their
copyright lines in [site/FONT-LICENSES.md](site/FONT-LICENSES.md).
