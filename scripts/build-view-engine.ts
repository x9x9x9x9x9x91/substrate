#!/usr/bin/env node
/**
 * Bundle the view evaluator into the app, for the MCP door to run.
 *
 * What a view SHOWS — which notes are members, which rows survive its filter,
 * what order they land in, what each cell reads as — is decided in TypeScript,
 * in the same functions the database pane and the note widget paint from. The
 * MCP door is a Rust sidecar. Rather than spell those rules a second time in
 * Rust, where they would drift from the screen the first time either side
 * gains a step, the door runs `scripts/view-read/viewengine.ts` with Node and
 * reads its answer back.
 *
 * That entry imports a good part of `src/lib/`, and none of `src/lib/` exists
 * inside a packaged .app — the frontend ships as compiled assets, not as its
 * modules. So the engine is BUILT into one self-contained file rather than
 * copied: one file is what survives packaging, and what
 * `src-tauri/src/mcpdoor/viewengine.rs` looks for beside the binary.
 *
 * Two choices worth stating, because both are load-bearing rather than taste:
 *
 *   ESM, with a `package.json` marking the folder a module. The entry — and
 *   the shared modules under it — read `import.meta.url` to tell being run
 *   from being imported, which a CommonJS build has no answer for; the main
 *   block would simply never run, and the door would hang on a script that
 *   read its request and printed nothing.
 *
 *   The extension stays `.js` rather than `.mjs`, so the fenced-artifact scan
 *   reads the built file like every other text resource. A bundle is exactly
 *   where a stray marker from some module's comments would land unnoticed, so
 *   it should be scanned, not skipped for its name.
 *
 * Output lands under the same staged-resources directory the prune step
 * writes into, which is a build artifact `.gitignore` covers.
 *
 *   node scripts/build-view-engine.ts
 *
 * Exit 0 clean, 1 if the bundle could not be built.
 */
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The entry bundled, repo-relative. */
export const VIEW_ENGINE_ENTRY = "scripts/view-read/viewengine.ts";

/**
 * The `bundle.resources` target the engine lands under, and the folder name
 * `src-tauri/src/mcpdoor/viewengine.rs` resolves beside the binary. The two
 * names move together.
 */
export const VIEW_ENGINE_TARGET = "viewengine";

/** The built file's name, which that same resolver spells. */
export const VIEW_ENGINE_FILE = "viewengine.js";

/** Where the built copy is staged, relative to the repo root. */
export const VIEW_ENGINE_STAGE = `src-tauri/gen/bundle-resources/${VIEW_ENGINE_TARGET}`;

/**
 * Build the engine into `dest`, replacing whatever was there.
 *
 * The directory is emptied first: a rebuild that produced fewer files should
 * not leave the old ones beside the new, because the door resolves by name
 * and a stale file with the right name is the one it would find.
 */
export async function buildViewEngine(root: string, dest: string): Promise<string> {
  const { build } = await import("esbuild");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const outfile = join(dest, VIEW_ENGINE_FILE);
  await build({
    entryPoints: [join(root, VIEW_ENGINE_ENTRY)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
  });
  writeFileSync(join(dest, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
  return outfile;
}

/** Run, as opposed to imported by a test. `realpathSync` because a caller
    hands over the path it was given while `import.meta.url` is the resolved
    one — under a symlinked checkout the two spellings differ, this file reads
    as merely imported, and the build quietly produces nothing while the app
    build around it still succeeds. Same guard the engine it bundles keeps. */
function isEntryPoint(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    await buildViewEngine(ROOT, join(ROOT, VIEW_ENGINE_STAGE));
    console.log(`build-view-engine: ${VIEW_ENGINE_ENTRY} → ${VIEW_ENGINE_STAGE}/${VIEW_ENGINE_FILE}`);
  } catch (error) {
    console.error(`build-view-engine: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
