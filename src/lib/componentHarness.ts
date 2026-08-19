/** Component-test harness: renders a real `.tsx` surface under node:test.
 *
 *  WHY THIS EXISTS. Until now nothing in the suite executed a component. A
 *  TSX-touching change was covered by tsc, lint, and whatever e2e happened to
 *  walk past it, so lanes recorded "unverified" for behaviour that is cheap to
 *  pin — the case-fold sweep hit exactly that wall on six dashboards. This is
 *  the missing middle rung: faster and more targeted than a browser spec,
 *  actually executing the render and its effects, unlike tsc.
 *
 *  WHAT IT IS. Three small pieces, no new mock layer:
 *    1. jsdom supplies the DOM globals, installed at module scope. `tauri.ts`
 *       reads `"__TAURI_INTERNALS__" in window` while it evaluates, so the
 *       globals must exist BEFORE anything imports it — which is why every
 *       component is pulled in with a dynamic `import()` from inside the test,
 *       after this module has been imported. (Same idiom as `dom.test.ts`.)
 *    2. A loader hook (esbuild) so node can execute `.tsx` at all: node's own
 *       type-stripping handles `.ts` and refuses `.tsx`. The hook also resolves
 *       the extensionless relative specifiers the app writes (`../lib/types`),
 *       which the bundler allows and node does not, and stubs `.css` imports.
 *    3. `renderComponent`, a React 19 `createRoot` + `act` wrapper, so effects
 *       run and the mock IPC promises settle before assertions.
 *
 *  DATA COMES FROM THE EXISTING MOCK BACKEND — the same fixtures the e2e suite
 *  drives. Stage per-test state through the public `window.__mock*` seams
 *  (`__mockCloneNote`, `__mockEditProp`, `__mockEditNote`, `__mockDeleteNote`);
 *  don't reach into the fixture module, and `__mockHostedVault` for a hosted
 *  sync store that already holds a vault. `mockBackend()` asserts they are all
 *  installed and hands back a window they are non-optional on, so staging is
 *  written WITHOUT `?.` — see `MockWindow`.
 *
 *  THE PATTERN, end to end:
 *
 *      import { createElement as h } from "react";
 *      import { mockBackend, renderComponent } from "./componentHarness.ts";
 *      import type { MockWindow } from "./componentHarness.ts";
 *
 *      let win: MockWindow;
 *      before(async () => {
 *        win = await mockBackend();                          // installs the seams
 *        win.__mockCloneNote("Weight Log.md", "Fixture.md");
 *        win.__mockEditProp("Fixture.md", "type", null);     // drop the seed key
 *        win.__mockEditProp("Fixture.md", "Type", "Sheet");  // cased, on purpose
 *      });
 *      after(() => win.__mockDeleteNote("Fixture.md"));
 *
 *      test("renders", async (t) => {
 *        const { default: Surface } = await import("../components/Surface.tsx");
 *        const r = await renderComponent(t, h(Surface, { ...props }));
 *        assert.match(r.text(), /expected/);
 *      });
 *
 *  The test context is passed in and teardown is automatic — see
 *  `renderComponent`. `unmount()` is there for asserting on what unmounting
 *  itself does, not for cleanup.
 *
 *  Tests live in `src/lib/*.test.ts` (the runner's roots are explicit — see
 *  `scripts/run-node-tests.ts`) and are plain `.ts`: build elements with `h`
 *  rather than JSX so the test file itself needs no transform. Longer prose in
 *  `docs/component-tests.md`.
 */

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { JSDOM } from "jsdom";

const SRC_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

/* Bundler-shaped imports node can't take on its own. The app writes
   `from "../lib/types"` and `from "./DashHead"`; node ESM demands an
   extension. Try the ones the tree actually uses, in the order vite would. */
const CANDIDATE_SUFFIXES = [".ts", ".tsx", "/index.ts", "/index.tsx"];
/* A stylesheet is a bundler artefact with no runtime meaning here — an empty
   module keeps a component that imports one loadable. */
const EMPTY_MODULE = "data:text/javascript,";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".css")) return { url: EMPTY_MODULE, shortCircuit: true };
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (relative && !/\.[a-z]+$/i.test(specifier)) {
      for (const suffix of CANDIDATE_SUFFIXES) {
        try {
          return nextResolve(specifier + suffix, context);
        } catch {
          /* not this extension — keep trying, then fall through to the error
             node would have raised for the bare specifier */
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith("file:")) return nextLoad(url, context);
    const path = fileURLToPath(url);
    if (!path.startsWith(SRC_DIR) || !/\.tsx?$/.test(path)) return nextLoad(url, context);
    /* `.ts` under src/ goes through esbuild too, not just `.tsx`: node's
       stripper would leave `import.meta.env` (vite's, undefined here) to throw
       at runtime. One transform path, one set of semantics. */
    const { code } = transformSync(readFileSync(path, "utf8"), {
      loader: path.endsWith(".tsx") ? "tsx" : "ts",
      format: "esm",
      target: "es2022",
      jsx: "automatic",
      sourcefile: path,
      sourcemap: "inline",
      define: { "import.meta.env": JSON.stringify({ MODE: "test", DEV: false, PROD: false }) },
    });
    return { format: "module", source: code, shortCircuit: true };
  },
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

/* Copy jsdom's window onto the global object. React, the app's own
   `window.` calls and the mock backend all read these off globalThis. */
const copied = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "sessionStorage",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "SVGElement",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "InputEvent",
  "DOMParser",
  "MutationObserver",
  "DOMRect",
] as const;
const target = globalThis as unknown as Record<string, unknown>;
const source = dom.window as unknown as Record<string, unknown>;
for (const key of copied) {
  const value = key === "window" ? dom.window : source[key];
  if (value === undefined) continue;
  /* `navigator` is a getter-only global in node — assignment silently fails,
     defineProperty doesn't */
  Object.defineProperty(target, key, { value, writable: true, configurable: true });
}

/* jsdom ships neither; components ask for both. Stubs, not implementations:
   layout is not what a component test is checking. */
const win = dom.window as unknown as Record<string, unknown>;
if (typeof win.matchMedia !== "function") {
  const matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
  win.matchMedia = matchMedia;
  target.matchMedia = matchMedia;
}
if (typeof win.ResizeObserver !== "function") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  win.ResizeObserver = ResizeObserverStub;
  target.ResizeObserver = ResizeObserverStub;
}
/* Nor scrollIntoView, which jsdom leaves off Element entirely — any surface
   that keeps a selected row in view (SelectMenu on open, the panes' reveal)
   throws on mount without it. A no-op, for the same reason as the two above:
   scrolling is not what a component test is checking. */
const elementProto = (dom.window as unknown as { Element: { prototype: Record<string, unknown> } })
  .Element.prototype;
if (typeof elementProto.scrollIntoView !== "function") {
  elementProto.scrollIntoView = () => {};
}
/* React 19 refuses to run `act` without this flag and warns without it. */
target.IS_REACT_ACT_ENVIRONMENT = true;

/** The staging seams every component test is expected to have. They are
    declared optional on `Window` (the bridge only installs them in mock
    builds), which is what makes `win.__mockEditProp?.(…)` compile — and a
    renamed or dropped seam then no-ops in silence, leaving the test to assert
    against the unmodified seed. `mockBackend` checks for them instead. */
const STAGING_SEAMS = [
  "__mockCloneNote",
  "__mockEditProp",
  "__mockEditNote",
  "__mockDeleteNote",
  "__mockHostedVault",
] as const;
type StagingSeam = (typeof STAGING_SEAMS)[number];

/** A window with the staging seams present, not merely declared. Typing them
    non-optional is the point of the guard below: staging is written without
    `?.`, so a seam that disappears is a type error at build time and a loud
    throw at run time, never a silent no-op. */
export type MockWindow = Omit<Window & typeof globalThis, StagingSeam> &
  Required<Pick<Window, StagingSeam>>;

/** The window the app sees, with the mock backend installed on it.
 *
 *  AWAIT THIS BEFORE STAGING FIXTURES. The `__mock*` seams are installed by
 *  `tauri.ts` as it evaluates, so anything written before the bridge is
 *  imported would be staging against a window that has none of them. Importing
 *  it here makes the order explicit — and the check below makes a seam that
 *  didn't arrive fail the run rather than pass a green suite asserting on seed
 *  data. Seams outside `STAGING_SEAMS` (`__mockSetAsync`, `__mockSetLatency`,
 *  …) are not covered: call those with `?.`, or add them here if a test starts
 *  depending on one. */
export async function mockBackend(): Promise<MockWindow> {
  await import("./tauri.ts");
  const win = dom.window as unknown as MockWindow;
  const missing = STAGING_SEAMS.filter((seam) => typeof win[seam] !== "function");
  if (missing.length > 0) {
    throw new Error(
      `mockBackend: the mock backend installed no ${missing.join(", ")} — ` +
        `fixture staging would no-op silently and the test would assert against ` +
        `the unmodified seed. Check the __mock* seams in src/lib/tauri.ts.`
    );
  }
  return win;
}

export interface Rendered {
  /** the element the surface rendered into */
  container: HTMLElement;
  /** visible text, whitespace-collapsed — assert on this, not on markup */
  text(): string;
  one(selector: string): Element | null;
  all(selector: string): Element[];
  /** click an element and let the render it causes finish */
  click(target: string | Element): Promise<void>;
  /** let pending mock IPC promises and the state updates they cause settle */
  settle(): Promise<void>;
  unmount(): Promise<void>;
}

type ActLike = (scope: () => Promise<void>) => Promise<void>;

/** node:test's context — only `after` is used, and typing it structurally
    keeps the harness free of a `node:test` import at module scope. */
interface TestLike {
  after(fn: () => void | Promise<void>): void;
}

/** Render a component and flush its effects. Build the element with
    `createElement` so the test file itself stays JSX-free.

    The test context is REQUIRED, and unmount is registered on it before the
    first assertion runs: a surface that sets an interval (most dashboards do)
    holds the event loop open, so a test that fails before an explicit unmount
    would hang the whole run rather than report the failure.

    That guarantee is bounded by the component: unmounting only stops the
    timers the component itself clears on unmount. A surface that leaks an
    interval keeps its test FILE alive past the per-test timeout — nothing here
    can reclaim it, and only the suite watchdog in `scripts/run-node-tests.ts`
    ends the run. */
export async function renderComponent(t: TestLike, element: unknown): Promise<Rendered> {
  const react = await import("react");
  const { createRoot } = await import("react-dom/client");
  const act = react.act as unknown as ActLike;

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);

  const settle = async () => {
    /* TWO MACROTASK GENERATIONS, and that is the whole guarantee. Each turn
       drains the microtask queue behind it, so the DEPTH of an effect's
       promise chain doesn't matter — `.then().then().then()` lands in the same
       turn as a bare `await`. What costs a turn is a macrotask BOUNDARY: a
       read whose result schedules a state update whose effect reads again.
       Two of those are covered; a third goes silently stale — the assertions
       just see the previous render. The delay is 0 because it is the cheapest
       turn marker, and the harness declines to guess how long a component's
       own timers run — a surface that schedules real-delay work needs a turn
       that outlasts the timer, not more zero-length turns. */
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  };

  await act(async () => {
    root.render(element as never);
  });
  await settle();

  const host = container as unknown as HTMLElement;
  /* Teardown is registered on the test, not left to the test body: a surface
     that sets an interval holds the event loop open, so an assertion that
     throws before an explicit unmount would hang the run instead of failing
     it. Synchronous by design, not by workaround: nothing is asserted after
     teardown, so the render it flushes is a render no test can observe, and
     awaiting React's flush would buy the run nothing but another way to hang.
     Detaching the container is enough to make the DOM unreachable. */
  let live = true;
  t.after(() => {
    if (!live) return;
    live = false;
    /* React warns about updates outside `act` while the flag is on, and
       unmount does update. Dropping out of the act environment for the
       teardown itself is the documented way to say "this one is deliberate";
       nothing is asserted after it. */
    target.IS_REACT_ACT_ENVIRONMENT = false;
    root.unmount();
    host.remove();
    target.IS_REACT_ACT_ENVIRONMENT = true;
  });
  return {
    container: host,
    text: () => (host.textContent ?? "").replace(/\s+/g, " ").trim(),
    one: (selector) => host.querySelector(selector),
    all: (selector) => [...host.querySelectorAll(selector)],
    click: async (selector) => {
      const el = typeof selector === "string" ? host.querySelector(selector) : selector;
      if (!el) throw new Error(`click: nothing matched ${String(selector)}`);
      await act(async () => {
        el.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })
        );
      });
      await settle();
    },
    settle,
    /** rarely needed — teardown is automatic; call this only to assert on
        what unmounting itself does (a flush-on-close, say) */
    unmount: async () => {
      if (!live) return;
      live = false;
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}
