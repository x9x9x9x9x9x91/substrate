# Component tests

Rendering a real `.tsx` surface inside the normal `npm test` run, against the
mock backend the e2e suite already uses.

## Why this rung exists

For a long time nothing in the suite executed a component. A change to a
dashboard was covered by `tsc`, by `npm run lint`, and by whatever e2e spec
happened to walk past the pane — so a lane that touched ten surfaces could
only pin the pure helpers underneath them and write *unverified* against the
rest. The case-fold sweep hit that wall on six dashboards at once — every one
of them read frontmatter it had just been changed to read case-insensitively,
and not one of those reads could be pinned.

A component test is the middle rung:

| | pins | costs |
|---|---|---|
| `tsc` / lint | shapes, not behaviour | seconds |
| **component test** | one surface's render, its effects, its reads | ~0.5 s each |
| e2e (`npm run e2e`) | the whole app, real routing, real chrome | minutes |

Reach for it when the thing worth pinning is *what a surface renders from
given data* — a prop read, a dispatch on note type, an error path, an empty
state. Keep the browser spec for anything that needs the real app around it:
focus, scrolling, keyboard routing, window chrome, multi-pane interaction.

**Mounting `App.tsx` itself is allowed, and is the exception, not the
pattern.** It renders in about half a second here, so the cost is not the
argument against it — the argument is that a test which drives the whole app
through the DOM is an e2e spec with worse tools. Mount it only when the seam
is something the app hands a surface that a browser spec cannot see: a
callback's RETURN value, an ordering between two writes, a promise a pane
awaits. `rowGroupDrop.component.test.ts` does it once, for exactly that —
the promote door's returned promise, which no rendered pixel reveals until
the grouping switch that waits on it silently stops happening. Everything a
screenshot or a click can prove belongs in `e2e/`. A whole-app mount also
writes to the shared mock vault for the rest of that file's run, so put it
last and leave module state as it found it.

## Writing one

Component tests live in `src/lib/*.test.ts` — `scripts/run-node-tests.ts`
takes explicit roots and `src/components` is not one of them. Name the file
`<surface>.component.test.ts`, which is what separates them from the plain
unit tests sharing that directory. They are plain `.ts` and build elements
with `createElement`, so the test file itself needs no JSX transform.

One file on its own runs as:

```sh
VAULT_DIR=/tmp/vault-test node --test src/lib/<file>.component.test.ts
```

`src/lib/workbookPane.component.test.ts` is the worked example. The shape:

```ts
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { NoteMeta } from "./types.ts";

let win: MockWindow;

/** the note the surface is handed — a NoteMeta, not the file on disk */
function fixtureMeta(): NoteMeta {
  return {
    path: "Fixture.md",
    stem: "Fixture",
    title: "Fixture",
    folder: "",
    props: { Type: "Sheet" },
    updated_ms: Date.now(),
    excerpt: "",
    sealed: false,
  };
}

before(async () => {
  win = await mockBackend();
  win.__mockCloneNote("Weight Log.md", "Fixture.md");
  win.__mockEditProp("Fixture.md", "type", null);    // drop the seed's key
  win.__mockEditProp("Fixture.md", "Type", "Sheet"); // cased, on purpose
});

after(() => win.__mockDeleteNote("Fixture.md"));

test("renders the grid for a sheet", async (t) => {
  const { default: Surface } = await import("../components/Surface.tsx");
  const r = await renderComponent(t, h(Surface, { meta: fixtureMeta(), vaultEpoch: 0 }));

  await r.click(".some-tab");
  assert.ok(r.one(".sheet-table"));
  assert.match(r.text(), /expected/);
});
```

Five rules, each of which will bite if broken:

1. **`await mockBackend()` before staging anything.** The `window.__mock*`
   seams are installed by `src/lib/mockBackend.ts` (imported eagerly by `src/lib/tauri.ts`) as it evaluates, so staging
   written before anything imported the bridge would run against a window that
   has none of them. They are declared optional on `Window`, which is what
   makes the `win.__mockCloneNote?.(…)` shape compile — and a seam that is
   renamed or absent then no-ops in silence, leaving the test to assert against
   the unmodified seed. `mockBackend()` therefore checks for the four staging
   seams and throws naming the missing ones, and the `MockWindow` it returns
   has them non-optional: stage without `?.`. Other seams (`__mockSetAsync`,
   `__mockSetLatency`) are not covered by the guard — call those with `?.`, or
   add them to `STAGING_SEAMS`.
2. **Import components with a dynamic `import()` inside the test**, not with a
   top-level static import. `tauri.ts` reads `"__TAURI_INTERNALS__" in window`
   while it evaluates, so the jsdom globals — which the harness installs at its
   own module scope — have to be in place first. Static imports are hoisted
   above that.
3. **Pass the test context `t` to `renderComponent`.** Teardown is registered
   on it before your first assertion. Most dashboards set an interval, which
   holds the event loop open; without that registration a failing assertion
   hangs the whole run instead of reporting the failure.
4. **Stage fixtures through the `__mock*` seams**, not by reaching into
   `src/lib/mockseeds.ts`. Same seams the e2e suite drives, so a fixture reads
   the same in both places — and the seed module stays a single description of
   the mock vault.
5. **Never let an absence assertion stand alone.** `assert.equal(r.all(".err").
   length, 0)` and `assert.doesNotMatch(r.text(), /…/)` both pass on an empty
   container — a render that failed, settled late, or never mounted satisfies
   them perfectly. Pair each one with a positive assertion in the same test
   that proves the surface is actually there and is the one you meant
   (`assert.ok(r.one(".sheet-table"))`, a match on content only the staged
   fixture carries). The absence check is then the second half of a claim, not
   the whole of it.

### Frontmatter fixtures

Write fixture frontmatter the way a person types it: `Type: Sheet`,
`PageLabel: Ledger`. The app folds case on both key and value
(`foldedPropKey`, `foldedPropStr`, `foldedTypeName` in `src/lib/types.ts`), and
a lowercase fixture tests none of that. `__mockEditProp` preserves the case you
give it, so the usual move is to delete the seed's lowercase key (`…, "type",
null`) and add the cased one.

### Assert on the thing that discriminates

The trap these tests fall into: a fixture cloned from a seed renders
identically to the seed, so a row count passes just as happily on the fallback
path the feature was supposed to make unnecessary. Assert on something only the
intended path produces — the source name a card carries in its `title`, a
string injected into just the clone's body, the specific error text. The check
is: mutate the behaviour under test away and confirm the suite goes red. When
the fold was stubbed out of `types.ts`, six of these seven tests failed; the
seventh is the one that deliberately exercises the no-props default.

## What the harness gives you

`src/lib/componentHarness.ts`, in full:

- **jsdom globals**, installed at module scope (`window`, `document`,
  `navigator`, the event and element constructors, `localStorage`, plus stubs
  for `matchMedia` and `ResizeObserver`, which jsdom doesn't ship and
  components ask for).
- **an esbuild loader hook**, because node's own type-stripping handles `.ts`
  and refuses `.tsx`. It also resolves the extensionless relative specifiers
  the app writes (`from "../lib/types"`) — legal to a bundler, not to node —
  and stubs `.css` imports to an empty module.
- **`renderComponent(t, element)`**: React 19 `createRoot` inside `act`, then
  two settle turns so mock IPC promises resolve and the state updates they
  schedule land before you assert — plus, for a surface that reaches for
  WebCrypto, however many more turns the `crypto.subtle` calls in flight ask
  for (see the known edge below). Returns `{ container, text(), one(), all(),
  click(), settle(), unmount() }`. `text()` is whitespace-collapsed — assert on
  it rather than on markup. `unmount()` is for asserting on what unmounting
  itself does; cleanup is automatic.

Three devDependencies carry it: `jsdom`, `@types/jsdom`, and `esbuild` (already
in the tree transitively, via vite — this makes it direct). No new mock layer,
no snapshot framework, no second test runner.

## Known edges

- **Teardown is synchronous by design.** Nothing is asserted after a test's
  teardown, so the render an `act`-wrapped `root.unmount()` would flush there
  is a render no assertion can observe: awaiting it buys the run nothing and
  gives it one more promise to hang on. The harness drops out of the act
  environment for the unmount (React warns about updates outside `act`, and
  unmount does update) and detaches the container, which is what makes the DOM
  unreachable. Teardown also only stops the timers the component clears on
  unmount — a surface that leaks an interval holds its test *file* open past
  the per-test timeout, until the suite watchdog in `scripts/run-node-tests.ts`
  ends the run.
- **`queueMicrotask` is deliberately not copied off jsdom's window**; jsdom's
  delegates to the global one and recursed to a stack overflow.
- **Async work outside a promise the render awaits** (a `setTimeout`
  animation, a debounce) won't be flushed by `settle()`. Assert on the state
  before it, or use a real timer only if you must. The trap is that a
  timer-backed promise looks exactly like the covered case at the call site:
  the mock bridge's own `__mockSetAsync` (which resolves IPC calls after a
  short random delay) and `__mockSetLatency` both put a real timer in front of
  a promise, so a surface staged with either can need more than the default
  two turns — and an extra `r.settle()` only covers work already due, so no
  number of zero-length turns reaches a timer that hasn't fired yet. A test
  that stages either seam needs a turn that actually outlasts the timer
  (`await act(async () => new Promise((done) => setTimeout(done, ms)))` with
  `ms` past the configured delay), or it is flaky by construction.
- **WebCrypto is waited on, not guessed at.** Node's `crypto.subtle` resolves
  from the libuv threadpool, not from JS, so an `importKey`/`decrypt` pair can
  land after any number of zero-length turns when the machine is loaded — that
  is what made the lens-reader tests flaky on a busy rig. The harness wraps the
  subtle methods to keep their promises and `settle()`
  awaits the actual work, looping while more is started (import → decrypt →
  state → render). Nothing is needed in a test; a surface that keeps crypto
  permanently in flight falls back to the two-turn guarantee after 20 rounds
  rather than hanging.
- **`click()` is the only interaction the harness synthesizes.** Typing,
  focus, and keyboard events aren't built — a test that needs them belongs in
  the browser spec.
