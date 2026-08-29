import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* The chunk names the config declares, read from the config itself so this
   test cannot drift from it. The import is dynamic and its specifier built
   here on purpose: vite.config.ts belongs to the tsconfig.node.json project,
   which this one only references, so a static import is a cross-project type
   error. The names are wanted at runtime, not for typing. */
const { MANUAL_CHUNK_NAMES } = (await import(
  new URL("../vite.config.ts", import.meta.url).href
)) as { MANUAL_CHUNK_NAMES: string[] };

// The entry chunk's size budget.
//
// The main entry had grown to ~1.7 MB minified with Rollup's own size warning
// firing on every build — which is the shape of a limit nobody enforces: it
// printed, it was scrolled past, and the number went up. vite.config.ts now
// splits the vendor leaves (the CodeMirror stack, React, the Tauri bindings)
// into their own chunks, and this is what keeps the entry from re-absorbing
// them or growing past what the split bought.
//
// It builds rather than reading a `dist/` someone left behind: a stale tree
// from a different branch would pass this happily, and a missing one would
// skip it. Same reasoning, and the same shape, as public-build.test.ts.

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The ceiling, in kB of minified JS. Sits ~8% over the entry as measured on
    the commit that split the vendor chunks out — close enough that a pane
    added to the eager graph shows up here, wide enough that ordinary editing
    does not.

    It is a CEILING, not a target: lower it whenever real work moves code off
    the entry, and never raise it to make a build pass without saying in the
    same change what got bigger and why. `build.chunkSizeWarningLimit` in
    vite.config.ts should move with it. */
const ENTRY_CEILING_KB = 1200;

/** Which built file is the main window's entry. The four HTML inputs each
    produce one, and only this one is the app. */
const ENTRY_PREFIX = "main-";

/** The three floating windows, and the ceiling on what each one loads before
    it can paint. They are small single-purpose surfaces — a capture box, an
    agenda list, a palette — and they carry ~305 kB eager each; nothing about
    them should ever pull the editor stack or the PDF renderer along.

    This exists because the vendor split's first cut did exactly that. Vite's
    preload helper fell through `manualChunks`, Rollup folded it into the
    codemirror chunk, and because every window imports that helper all three
    aux entries suddenly preloaded 591 kB of CodeMirror they never use — a
    tripling (301 → 908 kB) that the entry-chunk ceiling above could not see,
    since it only reads `main-*` and index.html. The ceiling is set ~30% over
    what they measure so ordinary work on those windows does not trip it, and
    far under the ~900 kB that one stray vendor chunk costs. */
const AUX_ENTRIES = ["capture.html", "agenda.html", "palette.html"];
const AUX_EAGER_CEILING_KB = 400;

const kb = (bytes: number) => Math.round((bytes / 1024) * 10) / 10;

test("the main entry chunk stays under its size budget", () => {
  const out = mkdtempSync(join(tmpdir(), "substrate-entry-budget-"));
  try {
    const built = spawnSync("npx", ["vite", "build", "--outDir", out, "--emptyOutDir"], {
      cwd: ROOT,
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(built.status, 0, `build failed:\n${built.stdout}\n${built.stderr}`);

    const assets = join(out, "assets");
    const js = readdirSync(assets)
      .filter((f) => f.endsWith(".js"))
      .map((f) => ({ file: f, bytes: statSync(join(assets, f)).size }));

    const entries = js.filter((c) => c.file.startsWith(ENTRY_PREFIX));
    assert.equal(
      entries.length,
      1,
      `expected exactly one ${ENTRY_PREFIX}* entry chunk, found ${entries.length}: ` +
        `${entries.map((c) => c.file).join(", ")} — the build's input names changed`,
    );
    const entry = entries[0];

    // Everything the entry pulls in eagerly, not just the entry file. A split
    // that moved 600 kB out of the entry and straight into a chunk the entry
    // still imports on line one has bought the parse a little and the network
    // nothing, and this line is what makes that visible in the log.
    const eagerFor = (htmlFile: string) => {
      const html = readFileSync(join(out, htmlFile), "utf8");
      const chunks = js.filter((c) => html.includes(c.file));
      return { chunks, bytes: chunks.reduce((sum, c) => sum + c.bytes, 0) };
    };
    const { chunks: preloaded, bytes: eagerBytes } = eagerFor("index.html");

    // Printed on every run, pass or fail — a budget that only speaks when it
    // breaks teaches nothing about the growth that broke it.
    const shown = js
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 6)
      .map((c) => `${c.file} ${kb(c.bytes)} kB`)
      .join(", ");
    console.log(
      `entry chunk budget — ${entry.file}: ${kb(entry.bytes)} kB (ceiling ${ENTRY_CEILING_KB} kB); ` +
        `preloaded from index.html: ${preloaded.length} chunks, ${kb(eagerBytes)} kB; ` +
        `largest chunks: ${shown}`,
    );

    assert.ok(
      kb(entry.bytes) < ENTRY_CEILING_KB,
      `the main entry chunk is ${kb(entry.bytes)} kB, over its ${ENTRY_CEILING_KB} kB budget. ` +
        "Either a vendor family stopped being split out of it (check manualChunks in " +
        "vite.config.ts), or enough application code was added to the eager graph to " +
        "matter — which is a first-paint question, not a bundler one.",
    );

    // The aux windows, each measured the same way: everything their own HTML
    // preloads. Asserted per window rather than summed, so one window pulling
    // a vendor chunk in cannot hide behind the other two.
    for (const htmlFile of AUX_ENTRIES) {
      const aux = eagerFor(htmlFile);
      console.log(
        `aux entry budget — ${htmlFile}: ${aux.chunks.length} chunks, ${kb(aux.bytes)} kB eager ` +
          `(ceiling ${AUX_EAGER_CEILING_KB} kB)`,
      );
      assert.ok(
        kb(aux.bytes) < AUX_EAGER_CEILING_KB,
        `${htmlFile} preloads ${kb(aux.bytes)} kB of JS, over its ${AUX_EAGER_CEILING_KB} kB ` +
          `budget (${aux.chunks.map((c) => `${c.file} ${kb(c.bytes)} kB`).join(", ")}). ` +
          "A floating window loading this much is almost always one shared module dragging a " +
          "whole vendor chunk onto its preload list — check what manualChunks in vite.config.ts " +
          "does with it.",
      );
    }

    // The split itself, asserted rather than assumed: without this the budget
    // could be met by a manualChunks that silently stopped matching, as long
    // as something else shrank by as much. Every family the config declares,
    // not a sample of them — a package renamed upstream leaves a name in that
    // list matching nothing, its bytes quietly re-merge, and this is the only
    // thing that would say so.
    for (const name of MANUAL_CHUNK_NAMES)
      assert.ok(
        js.some((c) => c.file.startsWith(`${name}-`)),
        `no ${name}-*.js chunk in the build — manualChunks stopped claiming that family, ` +
          "so its bytes are back wherever Rollup put them (check the package names in " +
          "VENDOR_CHUNKS against what is actually installed)",
      );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
