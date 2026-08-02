import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname } from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const input = (page: string) => fileURLToPath(new URL(page, import.meta.url));

/* Worktrees carry no node_modules of their own — imports (e.g. the Inter
   font) resolve up-tree to the main checkout's, which the default
   server.fs.allow (the workspace root) refuses to serve. Resolve vite's own
   package the way Node does from here and allow what it finds. */
const sharedModules = dirname(
  dirname(createRequire(import.meta.url).resolve("vite/package.json"))
);

/* Tauri wants a fixed dev port, so 1420 stays the default. The real-app smoke
   lane (private repo) overrides it — several worktrees share this machine and
   a squatting dev server on 1420 would otherwise serve another tree's code.
   The lane passes the matching devUrl via `tauri dev --config`.

   Coupled to `devCsp` in src-tauri/tauri.conf.json, which whitelists
   ws/http://localhost:1420 for HMR and cannot read this variable (JSON, no
   substitution). Overriding the port therefore costs HMR inside `tauri dev`
   — the page still loads and the smoke lane still passes, only live reload
   goes quiet. Change the port here and that CSP entry needs the same value,
   or a `--config` override alongside the devUrl one. */
// @ts-expect-error process is a nodejs global
const port = Number(process.env.SUBSTRATE_DEV_PORT || 1420);

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Multi-page: main window + the floating quick-capture and tray-agenda windows.
  build: {
    rollupOptions: {
      input: {
        main: input("./index.html"),
        capture: input("./capture.html"),
        agenda: input("./agenda.html"),
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
