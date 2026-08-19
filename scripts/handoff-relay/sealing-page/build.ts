#!/usr/bin/env node
/** Bundles the sealing page's browser script into the relay source.
 *
 * The relay must stay one dependency-free file at runtime — the deploy recipe
 * is a single esbuild of serve.ts. The sealing page needs a real age
 * implementation (typage), so the dependency is resolved HERE, at build time,
 * and the result is checked in as sealing-page.generated.ts. Regenerate with:
 *
 *   node scripts/handoff-relay/sealing-page/build.ts
 *
 * Run it whenever main.ts or the age dependency changes; the generated file is
 * source-of-record for the relay and is read by nothing else.
 *
 * `--check` rebuilds in memory and exits nonzero when the checked-in file has
 * drifted from the sources, without writing anything: that is the shape a CI
 * gate can run on a clean tree.
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes("--check");

const result = await build({
  entryPoints: [join(here, "main.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  write: false,
});

// `write: false` is what puts the bundle in memory; if esbuild ever hands back
// nothing, say so rather than generating an empty page script.
const bundled = result.outputFiles?.[0];
if (!bundled) throw new Error("esbuild produced no output file");

const script = bundled.text
  // the script is inlined into an HTML <script> element: no substring of the
  // bundle may close it early. Split/join rather than replaceAll — the repo
  // compiles against the ES2020 lib.
  .split("</")
  .join("<\\/");

const out = join(here, "..", "sealing-page.generated.ts");
const generated =
  `// GENERATED FILE — do not edit by hand.\n` +
  `// Rebuild with: node scripts/handoff-relay/sealing-page/build.ts\n` +
  `// Source: sealing-page/main.ts, bundled with its age implementation so the\n` +
  `// relay has no runtime dependencies.\n` +
  `export const SEALING_PAGE_SCRIPT = ${JSON.stringify(script)};\n`;

if (check) {
  const onDisk = readFileSync(out, "utf8");
  if (onDisk !== generated) {
    console.error(
      `sealing page is stale: ${out} does not match a fresh bundle of main.ts.\n` +
        `Rebuild with: node scripts/handoff-relay/sealing-page/build.ts`
    );
    process.exit(1);
  }
  console.log("sealing page is up to date");
} else {
  writeFileSync(out, generated);
  console.log(`sealing page bundled: ${script.length} bytes → ${out}`);
}
