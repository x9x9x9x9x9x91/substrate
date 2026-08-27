import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PROBE_SUFFIX, readIfPresent, sourceFiles } from "./live-tree.ts";

function fixture(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "substrate-live-tree-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the walk reads every source file under the root, at any depth", (t) => {
  const dir = fixture(t);
  mkdirSync(join(dir, "nested", "deeper"), { recursive: true });
  writeFileSync(join(dir, "top.ts"), "top");
  writeFileSync(join(dir, "nested", "mid.tsx"), "mid");
  writeFileSync(join(dir, "nested", "deeper", "low.ts"), "low");
  writeFileSync(join(dir, "nested", "notes.md"), "skipped — not a source file");

  const found = [...sourceFiles(dir)].map((f) => `${f.name}=${f.text}`).sort();
  assert.deepEqual(found, ["low.ts=low", "mid.tsx=mid", "top.ts=top"]);
});

test("a file that vanishes between the listing and the read is skipped, not a failure", (t) => {
  const dir = fixture(t);
  // Names chosen so the directory order is stable: the walk lists the whole
  // directory up front and yields lazily, which is what lets this delete land
  // in exactly the window the real race happens in.
  writeFileSync(join(dir, "a.ts"), "first");
  const doomed = join(dir, "b.ts");
  writeFileSync(doomed, "about to go");
  writeFileSync(join(dir, "c.ts"), "third");

  const walk = sourceFiles(dir);
  const first = walk.next().value;
  assert.equal(first?.name, "a.ts", "the listing is taken before anything is deleted");
  rmSync(doomed); // the concurrent test removing its fixture

  const rest = [...walk].map((f) => f.name);
  assert.deepEqual(rest, ["c.ts"], "the vanished entry drops out and the walk carries on");
});

test("a directory that vanishes mid-walk drops out too", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "a.ts"), "first");
  const doomed = join(dir, "zz-transient");
  mkdirSync(doomed);
  writeFileSync(join(doomed, "inside.ts"), "gone before we descend");

  const walk = sourceFiles(dir);
  assert.equal(walk.next().value?.name, "a.ts");
  rmSync(doomed, { recursive: true, force: true });

  assert.deepEqual([...walk].map((f) => f.name), []);
});

test("probe files planted by another test are never walked", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "Real.tsx"), "source");
  writeFileSync(join(dir, `Real.4242${PROBE_SUFFIX}`), "a fixture, not a source file");

  assert.deepEqual([...sourceFiles(dir)].map((f) => f.name), ["Real.tsx"]);
});

test("a real read error is still an error", (t) => {
  const dir = fixture(t);
  // A directory is not a missing file: reading one fails with EISDIR, which
  // the walk must not swallow along with the race it does tolerate.
  assert.equal(readIfPresent(join(dir, "never-existed.ts")), undefined);
  assert.throws(() => readIfPresent(dir), /EISDIR/);
});
