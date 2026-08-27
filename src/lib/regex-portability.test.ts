import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sourceFiles, type SourceFile } from "../../scripts/live-tree.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Every .ts/.tsx under src/ except test files — i.e. what ships in the app
    bundle. Rust is deliberately out of scope: the `regex` crate compiles its
    patterns against a fixed, vendored engine, so the syntax it accepts is a
    property of the build, not of whatever browser the user happens to run. */
function shippedSources(): SourceFile[] {
  return [...sourceFiles(join(ROOT, "src"))]
    .filter((f) => !/\.test\.tsx?$/.test(f.name))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The inline-modifier forms — a `(?` followed by flag letters and then either
    a `:` (scoped group, `(?i:…)`, `(?im-s:…)`) or a `)` (the whole-pattern
    form, `(?i)`). ES2025; parses only in WebKit 26.0+. Every other `(?…`
    opener is ES1-era and fine: `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<n>`.
    Written to need real modifier syntax so that spelling one WITHOUT the
    trailing colon — `(?i…)` — is how a comment talks about the thing. */
const MODIFIER_GROUP = /\(\?[a-zA-Z-]+[:)]/;

test("no ES2025 regex pattern modifiers in shipped frontend source (SUB-1104)", () => {
  // A pattern modifier is a PARSE error, not a match failure: a regex built at
  // module load — as MACHINE_FENCE_RE in ./fences.ts is — throws SyntaxError
  // while the module is evaluated, and the app white-screens at boot on any
  // older WKWebView. No gate sees this. tsc does not parse the contents of a
  // regex string; esbuild does not validate `new RegExp(someString)`; the node
  // tests and the Playwright e2e run on engines new enough to accept it. Tauri
  // renders in the SYSTEM webview and no minimumSystemVersion is declared, so
  // "my Mac parses it" says nothing about the machines it ships to.
  //
  // Case-fold a language id per letter instead ([Vv][Ii][Ee][Ww]); that is ES1
  // and every engine parses it. If a whole-regex `i` flag would be correct for
  // the pattern in question, that is fine here too — this guard is about
  // syntax the engine may refuse, not about how case gets folded.
  const offenders: string[] = [];
  for (const file of shippedSources()) {
    file.text.split("\n").forEach((line, i) => {
      if (MODIFIER_GROUP.test(line)) offenders.push(`${relative(ROOT, file.path)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "inline regex modifier groups are ES2025 (WebKit 26.0+) and break boot on older webviews.\n" +
      "If the hit is prose in a comment rather than a real pattern, write it without the colon —\n" +
      "`(?i…)` — so the guard keeps meaning what it says:\n  " +
      offenders.join("\n  ")
  );
});
