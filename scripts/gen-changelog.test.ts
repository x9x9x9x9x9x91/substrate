import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkChangelog,
  parseCargoLockVersion,
  parseCargoVersion,
  readVersions,
  renderChangelog,
  renderRelease,
  versionMismatch,
  wrapBullet,
} from "./gen-changelog.ts";
import { CHANGELOG, type ChangelogRelease } from "../src/lib/changelog.ts";

/* ── the gate itself ────────────────────────────────────────────────────── */

/* This is the staleness gate (SUB-588): it fails the unit suite whenever the
   committed CHANGELOG.md drifts from src/lib/changelog.ts, or whenever the
   five version numbers a release bump must touch disagree. `npm test` already
   globs scripts/*.test.ts, so no CI wiring changes to keep in step. */
test("CHANGELOG.md is current and the five versions agree (staleness gate)", () => {
  const { ok, problems } = checkChangelog();
  assert.ok(ok, problems.join("\n"));
});

/* ── rendering ──────────────────────────────────────────────────────────── */

test("wrapBullet marks the first line and indents continuations", () => {
  assert.equal(wrapBullet("short one"), "- short one");
  const wrapped = wrapBullet("word ".repeat(30).trim());
  const lines = wrapped.split("\n");
  assert.ok(lines.length > 1, "a long bullet should wrap");
  assert.ok(lines[0].startsWith("- "));
  for (const line of lines.slice(1)) {
    assert.ok(line.startsWith("  "), `continuation not indented: ${line}`);
  }
  for (const line of lines) {
    assert.ok(line.length <= 88, `line over budget: ${line.length}`);
  }
  // no word is lost or duplicated by the wrap
  assert.equal(wrapped.replace(/^[-\s]+/gm, "").split(/\s+/).length, 30);
});

test("wrapBullet overhangs rather than breaking an unsplittable word", () => {
  const long = "x".repeat(120);
  assert.equal(wrapBullet(long), `- ${long}`);
});

test("renderRelease writes the titled heading and groups bullets by kind (SUB-817)", () => {
  const release: ChangelogRelease = {
    version: "1.2.3",
    date: "2026-01-02",
    title: "A release name",
    items: [
      { text: "the flagship", kind: "new", headline: true },
      { text: "a fix", kind: "fixed" },
      { text: "did a thing", kind: "new" },
      { text: "kindless defaults to improved" },
    ],
  };
  assert.equal(
    renderRelease(release),
    "## 1.2.3 — 2026-01-02 — A release name\n\n" +
      "### Highlights\n\n- the flagship\n\n" +
      "### New\n\n- did a thing\n\n" +
      "### Improved\n\n- kindless defaults to improved\n\n" +
      "### Fixed\n\n- a fix\n"
  );
});

test("renderRelease skips Highlights and empty groups", () => {
  const release: ChangelogRelease = {
    version: "0.0.1",
    date: "2026-01-02",
    title: "Tiny patch",
    items: [{ text: "a fix", kind: "fixed" }],
  };
  assert.equal(
    renderRelease(release),
    "## 0.0.1 — 2026-01-02 — Tiny patch\n\n### Fixed\n\n- a fix\n"
  );
});

test("renderChangelog is idempotent and newest-first", () => {
  const once = renderChangelog();
  assert.equal(once, renderChangelog());
  assert.ok(once.startsWith("# Changelog\n"));

  const versions = [...once.matchAll(/^## (\S+) —/gm)].map((m) => m[1]);
  assert.ok(versions.length > 1);
  // the ORDERING is what's under test — the head must be the array's own
  // first entry, not a hardcoded version that every release bump has to
  // edit (version agreement across the four files is the staleness gate's
  // job, asserted above)
  assert.equal(versions[0], CHANGELOG[0].version, "newest release leads the file");
  assert.equal(versions[versions.length - 1], "0.1.0", "founding release closes it");
});

test("the founding releases survive regeneration (SUB-588)", () => {
  const rendered = renderChangelog();
  // 0.2.0 and 0.1.0 predate the in-app array; they were carried over from the
  // hand-written CHANGELOG.md and must not be lost to a regeneration.
  assert.match(rendered, /## 0\.2\.0 — 2026-07-17/);
  assert.match(rendered, /## 0\.1\.0 — 2026-07-17/);
  assert.match(rendered, /saved views, richer schemas and select fields/);
  assert.match(rendered, /local-first Markdown vault, SQLite search, backlinks/);
});

test("the auto-focus fix stayed in history when Unreleased dissolved (SUB-455)", () => {
  // it shipped after the 0.15.0 bump commit, so it lived only in CHANGELOG.md's
  // "Unreleased" section until this lane folded it into the 0.15.0 entry
  assert.match(renderChangelog(), /cut mid-word into its title/);
});

/* ── version agreement ──────────────────────────────────────────────────── */

test("parseCargoVersion reads [package], not a dependency's pin", () => {
  const toml = [
    "[build-dependencies]",
    'tauri-build = { version = "9.9.9" }',
    "",
    "[package]",
    'name = "substrate"',
    'version = "0.15.0"',
  ].join("\n");
  assert.equal(parseCargoVersion(toml), "0.15.0");
});

test("parseCargoVersion refuses a file it cannot read a version out of", () => {
  assert.throws(() => parseCargoVersion('[dependencies]\nserde = "1"'), /\[package\]/);
  assert.throws(() => parseCargoVersion('[package]\nname = "x"'), /no version/);
});

/* Cargo.lock joined the cross-check in SUB-620: a 0.15.0 lock entry survived
   the 0.16.0 bump because the gate only looked at the other four sources. The
   lock is a long list of [[package]] blocks, so the parse has to find the one
   named "substrate" rather than the first version line it meets. */
const LOCK = [
  "version = 3",
  "",
  "[[package]]",
  'name = "serde"',
  'version = "1.0.219"',
  "",
  "[[package]]",
  'name = "substrate"',
  'version = "0.17.0"',
  "dependencies = [",
  ' "serde",',
  "]",
  "",
  "[[package]]",
  'name = "tauri"',
  'version = "2.9.0"',
].join("\n");

test("parseCargoLockVersion finds the substrate package, not the first one", () => {
  assert.equal(parseCargoLockVersion(LOCK), "0.17.0");
  assert.equal(parseCargoLockVersion(LOCK, "tauri"), "2.9.0");
});

test("parseCargoLockVersion errors clearly when the substrate entry is missing", () => {
  const withoutSubstrate = LOCK.replace('name = "substrate"', 'name = "substrate-core"');
  assert.throws(
    () => parseCargoLockVersion(withoutSubstrate),
    /no \[\[package\]\] named "substrate"/
  );
  assert.throws(
    () => parseCargoLockVersion('[[package]]\nname = "substrate"\n'),
    /package "substrate" has no version/
  );
});

test("versionMismatch is silent on agreement and names every source on drift", () => {
  const agreed = {
    changelog: "1.0.0",
    packageJson: "1.0.0",
    tauriConf: "1.0.0",
    cargoToml: "1.0.0",
    cargoLock: "1.0.0",
  };
  assert.equal(versionMismatch(agreed), null);

  const drifted = versionMismatch({ ...agreed, cargoToml: "0.9.0" });
  assert.ok(drifted);
  assert.match(drifted, /cargoToml: 0\.9\.0/);
  assert.match(drifted, /packageJson: 1\.0\.0/);
});

test("a stale Cargo.lock alone fails the cross-check (SUB-620)", () => {
  const agreed = {
    changelog: "0.16.0",
    packageJson: "0.16.0",
    tauriConf: "0.16.0",
    cargoToml: "0.16.0",
    cargoLock: "0.16.0",
  };
  assert.equal(versionMismatch(agreed), null, "lock in agreement passes");

  // exactly the SUB-620 shape: everything bumped except the lock
  const stale = versionMismatch({ ...agreed, cargoLock: "0.15.0" });
  assert.ok(stale, "a stale lock must be reported");
  assert.match(stale, /cargoLock: 0\.15\.0/);
});

test("readVersions finds all five in the real repo", () => {
  const versions = readVersions();
  for (const [source, version] of Object.entries(versions)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${source} is not a version: ${version}`);
  }
});
