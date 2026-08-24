import { defineConfig, searchForWorkspaceRoot, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname } from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/* Scroll-anchoring canary. Chrome silently keeps the content under
   the viewport still when rows are inserted or removed above it — which means
   a pane whose "the selected row stays painted across a view switch" is really
   the browser's doing can pass its spec anyway, until an unrelated change to
   the row set moves the delta and the guarantee evaporates.
   Turning anchoring off makes every reveal the pane's own responsibility: a
   deterministic reveal survives it, an accidental one fails. playwright.config
   sets this for the whole e2e suite, so the gate is anchor-free by default —
   which also matches the WKWebView the app ships in, where anchoring does not
   exist. `SUBSTRATE_NO_SCROLL_ANCHOR=0 npm run e2e` restores Chrome's default
   for a comparison run. Dev server only — it never touches a build. */
// @ts-expect-error process is a nodejs global
const noScrollAnchor = process.env.SUBSTRATE_NO_SCROLL_ANCHOR === "1";
const noScrollAnchorPlugin = (): Plugin => ({
  name: "substrate-no-scroll-anchor",
  apply: "serve",
  transformIndexHtml: (html) =>
    html.replace(
      "</head>",
      "<style>*, *::before, *::after { overflow-anchor: none !important; }</style></head>",
    ),
});

/* The mock fixture is a dev-only demo vault (~1500 lines of seed notes) that
   the packaged app can never reach: there, `isTauri` is true, so mockDispatch
   and the `window.__mock*` seam never run. It shipped anyway, because
   tauri.ts imports it plainly — and it has to keep importing it plainly, since
   the dev server, `node --test` and the e2e harness all read the fixtures
   synchronously. So the swap happens at the module level instead of the call
   level: a BUILD resolves ./mockseeds.ts to mockseeds.stub.ts, which exports
   the same names as empty collections. Dev and test resolve the real file.

   The swap is asserted, not hoped for: if a build ever finishes without one,
   the plugin fails the build rather than let the fixture creep back in. */
const stripMockSeedsPlugin = (): Plugin => {
  const real = fileURLToPath(new URL("./src/lib/mockseeds.ts", import.meta.url));
  const stub = fileURLToPath(new URL("./src/lib/mockseeds.stub.ts", import.meta.url));
  let swapped = false;
  return {
    name: "substrate-strip-mock-seeds",
    apply: "build",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (importer === undefined || !source.includes("mockseeds")) return null;
      const resolved = await this.resolve(source, importer, options);
      if (!resolved || resolved.id !== real) return null;
      swapped = true;
      return stub;
    },
    buildEnd(err) {
      if (err || swapped) return;
      throw new Error(
        "substrate-strip-mock-seeds: nothing imported src/lib/mockseeds.ts — " +
          "if the fixture import moved, point this plugin at it; if it is gone, drop the plugin."
      );
    },
  };
};

const input = (page: string) => fileURLToPath(new URL(page, import.meta.url));

/* Worktrees carry no node_modules of their own — imports (e.g. the Inter
   font) resolve up-tree to the main checkout's, which the default
   server.fs.allow (the workspace root) refuses to serve. Resolve vite's own
   package the way Node does from here and allow what it finds. */
const sharedModules = dirname(
  dirname(createRequire(import.meta.url).resolve("vite/package.json"))
);

/* Tauri wants a fixed dev port, so 1420 stays the default. The real-app smoke
   run (a separate repo) overrides it — several worktrees share this machine and
   a squatting dev server on 1420 would otherwise serve another tree's code.
   It passes the matching devUrl via `tauri dev --config`.

   Coupled to `devCsp` in src-tauri/tauri.conf.json, which whitelists
   ws/http://localhost:1420 for HMR and cannot read this variable (JSON, no
   substitution). Overriding the port therefore costs HMR inside `tauri dev`
   — the page still loads and the smoke run still passes, only live reload
   goes quiet. Change the port here and that CSP entry needs the same value,
   or a `--config` override alongside the devUrl one. */
// @ts-expect-error process is a nodejs global
const port = Number(process.env.SUBSTRATE_DEV_PORT || 1420);

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), stripMockSeedsPlugin(), ...(noScrollAnchor ? [noScrollAnchorPlugin()] : [])],

  // Multi-page: main window + the floating quick-capture, tray-agenda and
  // everywhere-palette windows.
  build: {
    rollupOptions: {
      input: {
        main: input("./index.html"),
        capture: input("./capture.html"),
        agenda: input("./agenda.html"),
        palette: input("./palette.html"),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host: host || false,
    fs: {
      allow: [searchForWorkspaceRoot(fileURLToPath(new URL(".", import.meta.url))), sharedModules],
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
