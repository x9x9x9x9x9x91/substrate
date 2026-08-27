import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { sourceFiles } from "../../scripts/live-tree.ts";
import { stylesheetSource } from "../../scripts/styles-source.ts";

/* A `var(--x)` naming a token nothing declares is not a CSS error —
   the declaration is simply dropped, so the rule renders as if the line were
   never written. `.cm-live-value` lost its tint that way (the one mark
   separating a computed value from a typed one) and three `.mount-*` rules
   rendered transparent, invisibly, for as long as the tokens were missing.
   Nothing in the toolchain catches it: tsc doesn't read CSS, ESLint doesn't
   read CSS, and the app looks "fine" because a dropped background is a
   perfectly valid transparent one. This is the check that closes the class. */

/** the stylesheet with `/* … *\/` comments removed — a comment mentioning
    `var(--opt-` + a name is prose, not a reference. */
function cssWithoutComments(): string {
  return stylesheetSource().replace(/\/\*[\s\S]*?\*\//g, "");
}

/** every custom property the stylesheet declares, in any block or media query */
function declaredTokens(css: string): Set<string> {
  return new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
}

/** custom properties the app writes at runtime — `style={{ "--bar": … }}` on a
    component, or `setProperty("--glow", …)`. They are never declared in the
    stylesheet because their value is per-element data (a series colour, a
    column count), but the stylesheet legitimately reads them. Derived from the
    source rather than kept as a hand-maintained list, so adding one doesn't
    mean remembering to teach this test about it. */
function runtimeInjectedTokens(): Set<string> {
  const out = new Set<string>();
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const { text } of sourceFiles(root)) {
    for (const m of text.matchAll(/setProperty\(\s*["'`](--[a-z0-9-]+)/g)) out.add(m[1]);
    for (const m of text.matchAll(/["'](--[a-z0-9-]+)["']\s*:/g)) out.add(m[1]);
  }
  return out;
}

test("every var(--x) in the stylesheet resolves to a token something defines", () => {
  const css = cssWithoutComments();
  const declared = declaredTokens(css);
  const injected = runtimeInjectedTokens();

  const unresolved: string[] = [];
  for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
    const name = m[1];
    if (declared.has(name) || injected.has(name)) continue;
    const line = css.slice(0, m.index).split("\n").length;
    unresolved.push(`${name} (~line ${line} of the comment-stripped stylesheet)`);
  }

  assert.deepEqual(
    unresolved,
    [],
    `undefined CSS tokens — these rules silently drop their declaration:\n  ${unresolved.join("\n  ")}`,
  );
});

test("the ramp the mount banner and live-value tint ride is declared", () => {
  // the four repaired rules, pinned so a later edit can't quietly
  // reintroduce a token that doesn't exist
  const declared = declaredTokens(cssWithoutComments());
  for (const token of ["--bg", "--bg-input", "--bg-panel", "--bg-elevated"]) {
    assert.ok(declared.has(token), `${token} is no longer declared`);
  }
});
