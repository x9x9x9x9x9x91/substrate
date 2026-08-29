# Mock↔engine behavioral parity fixtures

`src/lib/mockBackend.ts` carries a hand-maintained second implementation of the
vault engine — the mock backend every e2e spec runs against, behind the
`src/lib/tauri.ts` transport that loads it. `npm run check:ipc` pins
the command *signatures*; nothing pinned the *behavior*, and the drift has been
found one bug at a time: filename dedupe, rename and delete link/index
mappings, trash and backlink order, control-character refusal, excerpt and
case-collision handling.

A fixture here is one scenario: a sequence of ops with the outcome each op must
produce. Two runners execute the same files:

| backend | runner | command |
| --- | --- | --- |
| mock (`src/lib/mockBackend.ts`) | `src/lib/parity.test.ts` | `npm test` (or `node --test src/lib/parity.test.ts`) |
| engine (`src-tauri` `Engine`) | `src-tauri/src/vault/parity.rs` | `cargo test --lib --manifest-path src-tauri/Cargo.toml parity` |

The comparison is on observable outcomes — returned paths, titles, list orders,
error text — never on internals, so the two runners share nothing but the JSON.

## Adding a pin

Write one file per scenario. Every fixture owns a folder no other fixture
touches; both runners scope every listing, search and trash observation to that
folder, which is why the mock's seeded demo vault and the engine's empty scratch
vault can run the same file.

```json
{
  "name": "create-dedupe",
  "summary": "create dedupes filenames inside the folder",
  "drift": ["filename dedupe"],
  "folder": "ParityCreateDedupe",
  "ops": [
    { "op": "create", "title": "Idea", "expect": { "path": "ParityCreateDedupe/Idea.md", "title": "Idea" } }
  ]
}
```

When a parity bug is fixed, add the case here: the one-off becomes a permanent
pin, and neither runner changes.

## Ops

Every op observes a fixed projection; `expect` is compared to it whole (deep
equality), so an op's expectation names every field of its projection. Any op
may instead expect `{ "error": "<exact message>" }`.

| op | args | observation |
| --- | --- | --- |
| `create` | `title`, `folder?` (defaults to the scenario folder), `type?`, `body?` | `{ path, title }` |
| `rename` | `path`, `title` | `{ path, title, touched }` — `touched` sorted (the engine's own order is hash order) |
| `setProp` | `path`, `key`, `value` (string / number / bool / string list / `null` to remove) | `{ value, prior }` |
| `delete` | `path` | `{ trashed: true }` (the trash id embeds a clock stamp — not comparable) |
| `deleteMany` | `paths` | `{ results: ["ok" \| "<error message>"] }` |
| `list` | — | `{ paths }` — in-folder, sorted by the runners (the SET is the observable, not the order) |
| `trashList` | — | `{ paths }` — in-folder, **in backend order** (`deleted_ms DESC, path ASC`) |
| `search` | `q` | `{ paths }` — in-folder, sorted by the runners (FTS `rank` vs the mock's own ranking is not a shared observable; the hit SET is) |
| `backlinks` | `path` | `{ paths }` — in-folder, **in backend order** (title ASC) |
| `note` | `path` | `{ title, type, excerpt }` |
| `body` | `path` | `{ body }` |

Two of those four list orders are pinned and two are not, which is the
distinction to keep straight when reading a fixture: `trashList` and
`backlinks` compare the backend's own order, so a reordering there is a
divergence. `list` and `search` are sorted by both runners before comparison,
so they pin membership only. `list` sorts because the engine's own order is a
genuine tie here: it returns `updated_ms` descending over a hash map, and a
fixture creates its notes well inside one millisecond, so they share a stamp
and fall back to hash order. There is nothing there to pin — asserting one
would pin whichever order that run happened to produce.

## Fixture-level keys

- `requires: ["case-insensitive-fs"]` — the engine's collision checks go through
  the filesystem, so a case-collision pin describes macOS (and any other
  case-insensitive volume), not Linux. The mock is filesystem-free and always
  runs it. It is the only requirement that exists: the Rust runner panics on an
  unrecognised one, because a misspelling would match no runner's filter and the
  fixture would then run nowhere while both gates stayed green.
- `pendingMock: "<why>"` — the scenario contains a divergence the engine is
  right about and the mock has not been fixed for yet. Say what the mock does
  instead, as behavior, so the note reads without a tracker to hand. The note is
  not a skip: mark the individual diverging ops with `"pendingMock": true` and
  every other op in the scenario still runs against the mock strictly. Use
  sparingly.

### Which leg carries the case pins

`fixtures_match_the_engine` runs every fixture without a `requires`. The
case-folding ones run under their own test, `case_pins_run_where_the_volume_folds_case`,
which passes without them on a case-sensitive volume — failing there would red
every Linux rig forever over a condition the host cannot change.

That skip is invisible in a green run (libtest captures the printed reason), so
the *gate* carries the guarantee instead: `scripts/branch-gates.sh` classifies
`parity/**` as `test cargo macsmoke`, and `macsmoke` is the gate set's only
guaranteed Darwin cargo run. A green battery over a parity change therefore
means the case pins executed. Reading a bare `cargo` leg on its own gives you
no such guarantee — run it with `SUBSTRATE_PARITY_REQUIRE_CASE=1` to turn the
skip into a failure on a host that is supposed to be carrying them.

### An op the mock gets wrong

`"pendingMock": true` on an op inverts the mock-side assertion: the engine's
answer stays in `expect`, and `parity.test.ts` asserts the mock still *diverges*
from it. So the marker expires — the day the mock is fixed, the run goes red
with `divergence resolved — remove the marker` rather than skipping forever.
The Rust runner ignores the key: the engine holds the whole pin either way.

Only mark an op whose wrong answer leaves the rest of the scenario on script —
a read, or a write whose divergence is confined to what a marked read observes.
A fixture may not mark all of its ops; that is the whole-fixture skip again, and
`parity.test.ts` fails it.

# Cross-language lockstep pins

`lockstep/` holds the other kind of shared file: not a scenario, a table of
inputs and the verdict every language that reads them must give. Same bargain
as the fixtures above — one file, two runners, nothing shared but the JSON —
for the pure functions two implementations of the same grammar keep drifting
apart on.

| file | question | runners |
| --- | --- | --- |
| `lockstep/column-markers.json` | is this line a column marker, does it open a fence, does it close one | `src/lib/columnLockstep.test.ts` (`npm test`) · `the_lockstep_fixture_gets_the_same_answers` in `src-tauri/src/vault/mod.rs` (`cargo test`) |

Every file here names its runners in a `runners` key, and each runner fails
rather than skips when the file is missing or unparseable: a pin that quietly
stops running is the drift it exists to catch. A spelling learned on one side
is a row added here, which the other side then answers or goes red on.
