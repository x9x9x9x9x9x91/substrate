import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkChangelog,
  parseCargoLockVersion,
  parseCargoVersion,
  privateItemProblems,
  readVersions,
  renderChangelog,
  renderRelease,
  scanFences,
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

/* ── private-item fencing (SUB-985) ─────────────────────────────────────── */

/* Markers are assembled, never written whole, and split before `strip`: this
   file ships in the public mirror, where a literal marker would be read as a
   real fence by the strip pass and the marker's prefix is a denylist entry
   that refuses the file outright. */
const START = `// share-mirror:${"strip"}-start`;
const END = `// share-mirror:${"strip"}-end`;

/** A release block in changelog.ts shape; `fence` wraps the private items. */
function fixture({ fence, fencePartially = false }: { fence: boolean; fencePartially?: boolean }) {
  const item = (text: string) =>
    fencePartially
      ? [`  {`, `    text: "${text}",`, START, `    private: true,`, END, `  },`]
      : [`  {`, `    text: "${text}",`, `    private: true,`, `  },`];
  const items = ["machine-local sync surface", "internal proxy pane", "rig fleet controls"].flatMap(
    item
  );
  return [
    "export const CHANGELOG = [",
    '  { version: "0.22.0", date: "2026-08-03", title: "A release",',
    "    items: [",
    '  { text: "a public thing", kind: "new" },',
    ...(fence && !fencePartially ? [START, ...items, END] : items),
    "    ] },",
    "];",
    "",
  ].join("\n");
}

test("the real changelog.ts fences every private item (SUB-985)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, "../src/lib/changelog.ts"), "utf8");
  /* The guard exists so the scan below can't pass vacuously — but the public
     mirror ships this test and NOT the material it guards: share-mirror.sh
     strips every fenced private item out of changelog.ts, and deletes its own
     tooling on the way past (SUB-1142). So the tooling's absence is the proof
     that the strip ran, and there the guard asserts the stronger thing: the
     strip left neither an item nor a marker behind. On any dev checkout
     share-mirror.sh is present and the original guard is untouched, so a
     private item that vanishes or loses its fence here still reds. */
  if (existsSync(resolve(here, "share-mirror.sh"))) {
    assert.ok(/private:\s*true/.test(source), "fixture guard: the file should have private items");
  } else {
    assert.ok(!/private:\s*true/.test(source), "the strip left a private item in the snapshot");
    assert.ok(
      !source.includes(START) && !source.includes(END),
      "the strip left a fence marker in the snapshot"
    );
  }
  assert.deepEqual(privateItemProblems(source), []);
});

test("an unfenced private item is caught — the v0.22.0 shape (SUB-985)", () => {
  // exactly what slipped past `share-mirror.sh main --check`: three private
  // items added to the bump with no fence at all
  const problems = privateItemProblems(fixture({ fence: false }), "changelog.ts");
  assert.equal(problems.length, 3, problems.join("\n"));
  assert.match(problems[0], /not fully inside a share-mirror strip fence/);
  assert.match(problems[0], /would ship/);
});

test("fencing the private items clears the scan", () => {
  assert.deepEqual(privateItemProblems(fixture({ fence: true }), "changelog.ts"), []);
});

test("a fence around the flag but not the text is still a leak", () => {
  // the `private: true` line strips, the item's prose does not — and the
  // survivor is a syntax error, which only the slow --verify would notice
  const problems = privateItemProblems(fixture({ fence: true, fencePartially: true }), "x.ts");
  assert.equal(problems.length, 3, problems.join("\n"));
  assert.match(problems[0], /would ship/);
});

test("unbalanced markers are reported rather than scanned past", () => {
  const source = [START, '{ text: "x", private: true },'].join("\n");
  const problems = privateItemProblems(source, "x.ts");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unterminated/);

  const orphan = privateItemProblems([END, "const a = 1;"].join("\n"), "x.ts");
  assert.match(orphan[0], /without a start/);
});

test("scanFences marks the marker lines and the region between them", () => {
  const { stripped, error } = scanFences(["keep", START, "gone", END, "keep"].join("\n"));
  assert.equal(error, null);
  assert.deepEqual(stripped, [false, true, true, true, false]);
});

test("a brace inside an item's text does not confuse the item span", () => {
  const source = [
    START,
    "{",
    '  text: "a { brace } in prose",',
    "  private: true,",
    "},",
    END,
  ].join("\n");
  assert.deepEqual(privateItemProblems(source, "x.ts"), []);
});

test("a single-line item is spanned from its own brace, not the release object", () => {
  // the back-walk starts at the `private: true` match, so an item written on
  // one line sees its own `{`; starting at the line's start offset landed on
  // the enclosing release literal and flagged a correct fence as a leak
  const fenced = [
    "export const CHANGELOG = [",
    '  { version: "0.22.0", items: [',
    START,
    '  { text: "secret", kind: "new", private: true },',
    '  { text: "another", kind: "new", private: true },',
    END,
    "  ] },",
    "];",
  ].join("\n");
  assert.deepEqual(privateItemProblems(fenced, "x.ts"), []);

  const unfenced = fenced
    .split("\n")
    .filter((line) => line !== START && line !== END)
    .join("\n");
  const bare = privateItemProblems(unfenced, "x.ts");
  assert.equal(bare.length, 2, bare.join("\n")); // one problem per item, not one merged span
  assert.match(bare[0], /x\.ts:3:/);
  assert.match(bare[1], /x\.ts:4:/);
});

test("`private: true` in prose or a comment is not a private item", () => {
  const prose = [
    "export const CHANGELOG = [",
    '  { text: "the flag private: true now hides items", kind: "new" },',
    "  // items with private: true are stripped from the mirror",
    "];",
  ].join("\n");
  assert.deepEqual(privateItemProblems(prose, "x.ts"), []);
});

test("a quoted `\"private\": true` key is caught too", () => {
  const quoted = ['{ text: "secret", "private": true },'].join("\n");
  const problems = privateItemProblems(quoted, "x.ts");
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /not fully inside a share-mirror strip fence/);
  assert.deepEqual(privateItemProblems([START, quoted, END].join("\n"), "x.ts"), []);
});

test("a regex literal in the scanned file is refused rather than mis-spanned", () => {
  // blankLiterals has no regex handling; changelog.ts is pure data and the
  // scan says so out loud instead of silently skewing spans
  const problems = privateItemProblems('const re = /{/;\n{ private: true },', "x.ts");
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /survives literal-blanking/);
  const real = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/lib/changelog.ts"),
    "utf8"
  );
  assert.deepEqual(
    privateItemProblems(real, "changelog.ts").filter((p) => /literal-blanking/.test(p)),
    []
  );
});

test("the scanner's own sources carry no literal strip marker", () => {
  // Two ways this file can poison the mirror it protects, both real: a whole
  // marker fences the scanner out of the snapshot, and the marker's prefix is
  // a share-denylist entry, so naming it at all makes share-mirror refuse the
  // file — 48 share-mirror tests failed on exactly that before the split.
  const here = dirname(fileURLToPath(import.meta.url));
  const denied = `share-mirror:${"strip"}`;
  for (const file of ["gen-changelog.ts", "gen-changelog.test.ts"]) {
    const source = readFileSync(resolve(here, file), "utf8");
    const { error, stripped } = scanFences(source);
    assert.equal(error, null, `${file}: ${error}`);
    assert.equal(stripped.filter(Boolean).length, 0, `${file} carries a literal strip marker`);
    assert.ok(!source.includes(denied), `${file} names a denylisted marker prefix`);
  }
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
