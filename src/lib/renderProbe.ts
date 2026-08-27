/** Opt-in render counter, for proving a `memo()` boundary actually holds.
 *
 *  A memo on a pane whose props churn every render is a silent no-op: nothing
 *  fails, nothing is slower than before, and the diff *looks* like a win. The
 *  only honest evidence is a count — render the pane, change some state it
 *  does not read, and check the number did not move.
 *
 *  It is opt-in rather than dev-gated so the same seam serves a component test
 *  (`dbPaneMemo.component.test.ts`) and a hand check in the dev console, without a build
 *  flag in between. Nobody installs the object, nobody pays: the cost in a
 *  shipped build is one property read per render of an instrumented component.
 *
 *      window.__RENDER_PROBE = {};   // start counting
 *      // …drive the app…
 *      window.__RENDER_PROBE.DatabasePane;   // → renders since install
 */
export type RenderProbe = Record<string, number>;

type ProbeHost = { __RENDER_PROBE?: RenderProbe };

/** Bump `name`'s count, if someone installed the probe. */
export function countRender(name: string): void {
  const probe = (globalThis as ProbeHost).__RENDER_PROBE;
  if (!probe) return;
  probe[name] = (probe[name] ?? 0) + 1;
}

/** Install a fresh probe and hand it back — the test-side entry point. */
export function installRenderProbe(): RenderProbe {
  const probe: RenderProbe = {};
  (globalThis as ProbeHost).__RENDER_PROBE = probe;
  return probe;
}

/** Uninstall, so a suite that finished counting stops paying for it. */
export function clearRenderProbe(): void {
  delete (globalThis as ProbeHost).__RENDER_PROBE;
}
