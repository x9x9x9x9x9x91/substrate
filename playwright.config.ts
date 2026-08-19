import { defineConfig } from "@playwright/test";

// Smoke gate: boots the Vite dev server (mock IPC backend, no Tauri, no real
// vault) and runs the flows in e2e/. Keep it fast — this is a merge gate, not
// a coverage project. Port comes from E2E_PORT (default 1429, not Tauri's
// 1420) so parallel checkouts never hijack or fight over one port.
const port = Number(process.env.E2E_PORT || 1429);
// The shared GitLab runner is ~6× slower than the dev Mac (measured on the
// same commit), and its 2 vCPUs oversubscribe at 4 workers. Budgets
// are written for local speed — the merge gate stays fast — and scale up in
// CI instead of per-spec whack-a-mole: every pipeline surfaced a different
// spec clipping a correct run (databasecontrols 2.5m, syncmanager 20.2s).
const ci = !!process.env.CI;
// The local budget has the same starvation class: on a pristine
// clone (cold Vite caches) or a loaded dev box, the first post-goto click of
// a spec's boot helper starves while the app boots — 2 random victims in the
// stranger's 4-worker run, 10 across six unrelated specs at the 64-worker
// repro dial, dbflows itself green and every victim at ms-speed when boot
// isn't contended. Declare the boot cost in the budget;
// assertions keep the tight 5s expect timeout, so real slow paths still fail.
//
// Worker count is a HOST-CLASS decision, not a CI-or-local one. The 2-worker
// cap above belongs to that 2-vCPU runner; the Linux gate runner that replaced
// it has 16 threads and runs the whole suite at 8 workers with exactly the same
// failures — no new flakes, 3.5m instead of 9.7m (measured 2026-08-18 on that
// runner). Rather than re-tune a constant every time the fleet changes
// shape, the host that knows its own budget declares it: E2E_WORKERS overrides,
// scripts/rig-gates-runner.sh sets it per host class, and a dev Mac or a plain
// CI run that sets nothing keeps exactly the numbers it had.
const workerEnv = process.env.E2E_WORKERS?.trim();
if (workerEnv && !/^[1-9][0-9]*$/.test(workerEnv)) {
  throw new Error(
    `E2E_WORKERS must be a positive whole number, got ${JSON.stringify(workerEnv)}`,
  );
}
export default defineConfig({
  testDir: "./e2e",
  // Visual-regression baselines are keyed by PLATFORM, and only the Linux set
  // is committed. macOS and Linux disagree on font hinting and subpixel
  // geometry by more than any real regression costs, so one shared baseline
  // would either fail on every host or be loosened until it proves nothing.
  // e2e/visualbaselines.spec.ts skips itself off Linux for the same reason;
  // the template is what keeps a stray capture elsewhere from landing on top
  // of the Linux PNGs. docs/visual-tiers.md says which tier proves what.
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}",
  timeout: ci ? 120_000 : 60_000,
  expect: { timeout: ci ? 15_000 : 5_000 },
  fullyParallel: true,
  workers: workerEnv ? Number(workerEnv) : ci ? 2 : 4,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
    viewport: { width: 1280, height: 800 },
    // Keep e2e browsers off the real audio hardware. Chromium's audio service
    // opens the physical output device even under --mute-audio, and on macOS
    // Tahoe 26.6 every device open/close audibly pops the dev Mac's built-in
    // speakers (CoreAudio regression; log-verified 2026-08-17). With this flag
    // AudioContext still works against a fake sink, so specs are unaffected.
    launchOptions: { args: ["--disable-audio-output"] },
  },
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    // never adopt a squatting server — a stale dev process on 1429 once served
    // old code mid-suite; --strictPort makes the collision fail loudly
    reuseExistingServer: false,
    timeout: 30_000,
    // Run every spec with scroll anchoring off. Chrome silently holds
    // the content under the viewport still when rows move above it, so a pane
    // whose "the selection stays painted" is really the browser's doing passes
    // its spec anyway — until an unrelated change to the row set shifts the
    // delta. Anchoring is also absent from the WKWebView the
    // app actually ships in (WebKit only added it in Safari 27), so anchor-free
    // is the truthful configuration, not a stricter one. SUBSTRATE_NO_SCROLL_
    // ANCHOR=0 restores Chrome's default for a one-off comparison.
    env: { SUBSTRATE_NO_SCROLL_ANCHOR: process.env.SUBSTRATE_NO_SCROLL_ANCHOR ?? "1" },
  },
});
