#!/usr/bin/env node
/** Bundles the relay's two browser scripts into the relay source.
 *
 * The relay must stay one dependency-free file at runtime — the deploy recipe
 * is a single esbuild of serve.ts. Both scripts need a real age
 * implementation (typage), so the dependency is resolved HERE, at build time,
 * and the result is checked in as sealing-page.generated.ts: the sender's page
 * for a drop link, and the chips a shared page's question draws for its
 * reader. They are two entry points rather than one because a plain lens — most
 * of them — should not download a sealing library it never calls; the slip
 * script is served on its own route and fetched only by a page that asks
 * something. Regenerate with:
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

async function bundle(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [join(here, entry)],
    bundle: true,
    minify: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  // `write: false` is what puts the bundle in memory; if esbuild ever hands
  // back nothing, say so rather than generating an empty page script.
  const bundled = result.outputFiles?.[0];
  if (!bundled) throw new Error(`esbuild produced no output file for ${entry}`);
  return (
    bundled.text
      // the script is inlined into an HTML <script> element: no substring of
      // the bundle may close it early. Split/join rather than replaceAll — the
      // repo compiles against the ES2020 lib.
      .split("</")
      .join("<\\/")
  );
}

const script = await bundle("main.ts");
const slipScript = await bundle("slip.ts");

const out = join(here, "..", "sealing-page.generated.ts");
const generated =
  `// GENERATED FILE — do not edit by hand.\n` +
  `// Rebuild with: node scripts/handoff-relay/sealing-page/build.ts\n` +
  `// Source: sealing-page/main.ts and sealing-page/slip.ts, each bundled with\n` +
  `// its age implementation so the relay has no runtime dependencies.\n` +
  `export const SEALING_PAGE_SCRIPT = ${JSON.stringify(script)};\n` +
  `export const SLIP_PAGE_SCRIPT = ${JSON.stringify(slipScript)};\n`;

if (check) {
  const onDisk = readFileSync(out, "utf8");
  if (onDisk !== generated) {
    console.error(
      `sealing page is stale: ${out} does not match a fresh bundle of its sources.\n` +
        `Rebuild with: node scripts/handoff-relay/sealing-page/build.ts`
    );
    process.exit(1);
  }
  console.log("sealing page is up to date");
} else {
  writeFileSync(out, generated);
  console.log(
    `pages bundled: ${script.length} + ${slipScript.length} bytes → ${out}`
  );
}
