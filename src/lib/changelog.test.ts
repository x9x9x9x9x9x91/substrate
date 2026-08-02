import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHANGELOG } from "./changelog.ts";

function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

test("the newest entry is the shipped version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(CHANGELOG[0].version, pkg.version);
});

test("versions are strictly descending and well-formed", () => {
  for (const release of CHANGELOG) {
    assert.match(release.version, /^\d+\.\d+\.\d+$/, `bad version ${release.version}`);
  }
  for (let i = 1; i < CHANGELOG.length; i++) {
    assert.ok(
      cmpVersion(CHANGELOG[i - 1].version, CHANGELOG[i].version) > 0,
      `${CHANGELOG[i - 1].version} must sort above ${CHANGELOG[i].version}`
    );
  }
});

test("versions are unique", () => {
  const seen = new Set(CHANGELOG.map((r) => r.version));
  assert.equal(seen.size, CHANGELOG.length);
});

test("dates are real ISO calendar days", () => {
  for (const release of CHANGELOG) {
    assert.match(release.date, /^\d{4}-\d{2}-\d{2}$/, `bad date on ${release.version}`);
    const parsed = new Date(`${release.date}T00:00:00Z`);
    assert.ok(!Number.isNaN(parsed.getTime()), `unparseable date on ${release.version}`);
    // round-trip catches 2026-02-31 style rollover
    assert.equal(parsed.toISOString().slice(0, 10), release.date);
  }
});

test("every release has a title and non-empty items", () => {
  for (const release of CHANGELOG) {
    assert.ok(release.title.trim().length > 0, `${release.version} has no title`);
    assert.ok(release.items.length > 0, `${release.version} has no items`);
    for (const item of release.items) {
      assert.ok(item.text.trim().length > 0, `${release.version} has an empty item`);
      if (item.kind !== undefined) {
        assert.ok(
          ["new", "improved", "fixed"].includes(item.kind),
          `${release.version}: unknown kind ${item.kind}`
        );
      }
    }
  }
});

test("no release buries the reader — at most 10 items", () => {
  for (const release of CHANGELOG) {
    assert.ok(release.items.length <= 10, `${release.version} lists ${release.items.length} items`);
  }
});
