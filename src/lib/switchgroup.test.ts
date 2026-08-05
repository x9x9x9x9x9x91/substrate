import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// SUB-1054: the segmented switch idiom carried no group role or name anywhere
// — seven hand-rolled `.db-switch` containers, each one announcing a pile of
// unrelated pressed buttons. SwitchGroup now owns the container and requires
// a name, so the semantics cannot be forgotten. This guard keeps the idiom
// from re-diverging the way it did the first time: a new switch written as a
// raw `className="db-switch"` element would silently lose the role again, and
// no rendering test would catch it because nothing about it looks broken.

// This file lives in src/lib/ rather than next to the component because
// `npm test` only collects the roots listed in scripts/run-node-tests.ts, and
// src/components is not one of them — a guard there is never run.
const SRC = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.isFile() && (p.endsWith(".tsx") || p.endsWith(".ts")) ? [p] : [];
  });
}

test("every db-switch container goes through SwitchGroup", () => {
  const offenders = walk(SRC)
    .filter((p) => p.endsWith(".tsx") && !p.endsWith("SwitchGroup.tsx") && p !== SELF)
    // Any `db-switch` inside a string literal, not just the literal form
    // `className="db-switch"`: a dynamic container — className={`db-switch
    // ${cls}`} — is precisely the case this guard exists to catch, and the
    // narrow anchor let it through. Markup-only (.tsx), so a CSS selector
    // string in .ts (infotips) is not an offender.
    .filter((p) => /(["'`])[^"'`]*\bdb-switch\b/.test(readFileSync(p, "utf8")))
    .map((p) => p.slice(SRC.length));
  assert.deepEqual(
    offenders,
    [],
    `raw db-switch markup: use <SwitchGroup label="…"> so the group keeps its role and name`
  );
});

test("SwitchGroup names the group it renders", () => {
  const src = readFileSync(join(SRC, "components/SwitchGroup.tsx"), "utf8");
  assert.match(src, /role="group"/);
  assert.match(src, /aria-label=\{label\}/);
  // label is required, not optional: an unnamed group is the bug this fixes
  assert.match(src, /\n {2}label: string;/);
});

test("every SwitchGroup call site passes a non-empty label", () => {
  const calls: string[] = [];
  for (const p of walk(SRC)) {
    if (p.endsWith("SwitchGroup.tsx") || p === SELF) continue;
    for (const m of readFileSync(p, "utf8").matchAll(/<SwitchGroup\b[^>]*>/g)) {
      calls.push(m[0]);
      const label = /label="([^"]*)"/.exec(m[0]);
      assert.ok(label && label[1].trim().length > 0, `unnamed SwitchGroup in ${p}: ${m[0]}`);
    }
  }
  // the seven switches the sweep converted — a floor, so deleting call sites
  // to make the guard above pass shows up here
  assert.ok(calls.length >= 7, `expected the whole idiom converted, found ${calls.length}`);
});
