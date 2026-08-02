import { defineConfig } from "@playwright/test";

// Smoke gate: boots the Vite dev server (mock IPC backend, no Tauri, no real
// vault) and runs the flows in e2e/. Keep it fast — this is a merge gate, not
// a coverage project. Port comes from E2E_PORT (default 1429, not Tauri's
// 1420) so parallel worktree lanes never hijack or fight over one port.
const port = Number(process.env.E2E_PORT || 1429);
// The shared GitLab runner is ~6× slower than the dev Mac (measured on the
// same commit, SUB-600), and its 2 vCPUs oversubscribe at 4 workers. Budgets
// are written for local speed — the merge gate stays fast — and scale up in
// CI instead of per-spec whack-a-mole: every pipeline surfaced a different
// spec clipping a correct run (databasecontrols 2.5m, syncmanager 20.2s).
const ci = !!process.env.CI;
export default defineConfig({
  testDir: "./e2e",
  timeout: ci ? 120_000 : 20_000,
  expect: { timeout: ci ? 15_000 : 5_000 },
  fullyParallel: true,
  workers: ci ? 2 : 4,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    // never adopt a squatting server — a stale dev process on 1429 once served
    // old code mid-suite (SUB-57); --strictPort makes the collision fail loudly
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
