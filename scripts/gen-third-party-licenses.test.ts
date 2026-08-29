import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  REGEN_COMMAND,
  byCodepoint,
  checkLicenseInputs,
  checkLicenses,
  collectNpmPackages,
  findLicenseFile,
  parseCargoLockPackages,
  parseCrateRows,
  productionPackagePaths,
  renderLicenses,
  resolveLicenseIds,
  type Crate,
} from "./gen-third-party-licenses.ts";
import { LICENSE_TEXTS } from "./lib/license-texts.ts";

const ROOT = resolve(import.meta.dirname, "..");
const committed = () => readFileSync(resolve(ROOT, "THIRD-PARTY-LICENSES.md"), "utf8");
const realLock = () => readFileSync(resolve(ROOT, "src-tauri/Cargo.lock"), "utf8");

/* ── the gate itself ────────────────────────────────────────────────────── */

/* The staleness gate, a sibling of gen-changelog.test.ts's: it fails
   the unit suite whenever THIRD-PARTY-LICENSES.md stops describing what the app
   actually ships — a dependency added, removed or bumped, or the file
   hand-edited. `npm test` already globs scripts/*.test.ts, so no CI wiring.

   It does NOT invoke `cargo metadata`, which generation does: the unit suite
   runs where a populated cargo registry is not guaranteed, and --offline
   --locked would fail loudly there. Crate names/versions come from Cargo.lock
   by text parse; crate license strings are trusted from generation time. See
   checkLicenses' comment for the gap that leaves. */
test("THIRD-PARTY-LICENSES.md is current (staleness gate)", () => {
  const { ok, problems } = checkLicenses();
  assert.ok(ok, problems.join("\n"));
});

test("a missing notice fails the gate by naming the one command that fixes it", () => {
  // the gen-changelog staleness-gate UX: whatever drifted, the reader is told
  // the same single command rather than left to reverse-engineer the format
  const { ok, problems } = checkLicenses(resolve(ROOT, "scripts/fixtures"));
  assert.equal(ok, false, "a tree without a notice must not pass");
  assert.ok(
    problems.some((problem) => problem.includes(REGEN_COMMAND)),
    `no problem named the regen command:\n${problems.join("\n")}`
  );
});

test("parseCrateRows refuses a file whose crate section is gone", () => {
  assert.throws(
    () => parseCrateRows("# not the notice\n"),
    /Rust crates linked into the app/,
    "silently returning zero crates would let an emptied file pass"
  );
});

/* ── npm closure ────────────────────────────────────────────────────────── */

test("productionPackagePaths keeps prod deps and drops dev-only ones", () => {
  const paths = productionPackagePaths({
    packages: {
      "": { version: "1.0.0" },
      "node_modules/react": { version: "19.2.7" },
      "node_modules/typescript": { version: "5.8.3", dev: true },
      "node_modules/fsevents": { version: "2.3.3", devOptional: true },
    },
  });
  // the root entry is Substrate itself — its AGPL license is in LICENSE, not here
  assert.deepEqual(paths, ["node_modules/react"]);
});

test("productionPackagePaths drops the per-platform prebuilt binaries", () => {
  // one of these is installed on any given machine and the rest are not, so
  // listing them would make the notice read differently per platform
  const paths = productionPackagePaths({
    packages: {
      "node_modules/@napi-rs/canvas": { version: "1.0.8", optional: true },
      "node_modules/@napi-rs/canvas-darwin-arm64": {
        version: "1.0.8",
        optional: true,
        os: ["darwin"],
        cpu: ["arm64"],
      },
      "node_modules/@napi-rs/canvas-win32-x64-msvc": {
        version: "1.0.8",
        optional: true,
        os: ["win32"],
        cpu: ["x64"],
      },
    },
  });
  assert.deepEqual(paths, ["node_modules/@napi-rs/canvas"]);
});

test("productionPackagePaths returns a stable order", () => {
  const packages = {
    "node_modules/zzz": { version: "1.0.0" },
    "node_modules/aaa": { version: "1.0.0" },
    "node_modules/mmm": { version: "1.0.0" },
  };
  assert.deepEqual(productionPackagePaths({ packages }), [
    "node_modules/aaa",
    "node_modules/mmm",
    "node_modules/zzz",
  ]);
});

test("findLicenseFile matches the spellings packages actually use", () => {
  assert.equal(findLicenseFile(["package.json", "LICENSE"]), "LICENSE");
  assert.equal(findLicenseFile(["LICENCE.md", "index.js"]), "LICENCE.md");
  assert.equal(findLicenseFile(["COPYING"]), "COPYING");
  assert.equal(findLicenseFile(["package.json", "README.md"]), null);
  // not a license file just because the name starts the same way
  assert.equal(findLicenseFile(["licensing-faq.txt"]), null);
});

test("findLicenseFile does not mistake a script for the license", () => {
  // the pattern is anchored and code extensions are excluded, so a source file
  // whose name merely begins with the word is not reproduced as a license text
  assert.equal(findLicenseFile(["LICENSE-check.js"]), null);
  assert.equal(findLicenseFile(["license.test.ts", "index.js"]), null);
  // …while the real spellings still match, including alongside such a script
  assert.equal(findLicenseFile(["LICENSE-check.js", "LICENSE"]), "LICENSE");
  assert.equal(findLicenseFile(["LICENSE.md"]), "LICENSE.md");
  assert.equal(findLicenseFile(["LICENSE_APACHE-2.0"]), "LICENSE_APACHE-2.0");
});

test("byCodepoint orders by codepoint, not by locale collation", () => {
  // the real divergence in this graph: ICU collation ignores the punctuation
  // difference and puts serde-untagged after serde_core; codepoints do not
  assert.ok(byCodepoint("serde-untagged", "serde_core") < 0);
  assert.ok(byCodepoint("web-sys", "web_atoms") < 0);
  assert.equal(byCodepoint("serde", "serde"), 0);
  assert.ok(byCodepoint("b", "a") > 0);
});

test("findLicenseFile picks deterministically when a package ships two", () => {
  // @tauri-apps/api ships LICENSE_APACHE-2.0 and LICENSE_MIT; readdir order
  // must not decide which one the generated file reproduces
  const files = ["LICENSE_MIT", "package.json", "LICENSE_APACHE-2.0"];
  assert.equal(findLicenseFile(files), "LICENSE_APACHE-2.0");
  assert.equal(findLicenseFile([...files].reverse()), "LICENSE_APACHE-2.0");
});

test("every production npm package resolves to a real installed package", () => {
  const packages = collectNpmPackages();
  assert.ok(packages.length > 0, "the closure should not be empty");
  for (const pkg of packages) {
    assert.match(pkg.version, /^\d+\.\d+\.\d+/, `${pkg.name} has no version`);
    assert.ok(pkg.license || pkg.text, `${pkg.name} declares no license and ships no text`);
  }
  const names = packages.map((p) => p.name);
  assert.deepEqual(names, [...names].sort(byCodepoint), "sorted by name");
});

/* ── Cargo.lock ─────────────────────────────────────────────────────────── */

const LOCK = [
  "version = 3",
  "",
  "[[package]]",
  'name = "serde"',
  'version = "1.0.219"',
  "",
  "[[package]]",
  'name = "substrate"',
  'version = "0.20.1"',
  "dependencies = [",
  ' "serde",',
  "]",
  "",
  "[[package]]",
  'name = "tauri"',
  'version = "2.9.0"',
].join("\n");

test("parseCargoLockPackages lists dependencies and skips substrate itself", () => {
  assert.deepEqual(parseCargoLockPackages(LOCK), [
    { name: "serde", version: "1.0.219" },
    { name: "tauri", version: "2.9.0" },
  ]);
});

test("parseCargoLockPackages covers the whole real lock", () => {
  const lock = readFileSync(resolve(ROOT, "src-tauri/Cargo.lock"), "utf8");
  const parsed = parseCargoLockPackages(lock);
  // every [[package]] block except this repository's own crates — the app and
  // the hosted-sync server, which the round-trip test pulls into the lock
  const blocks = lock.split(/^\[\[package\]\]$/m).length - 1;
  const own = lock.match(/^name = "substrate(-[a-z-]+)?"$/gm) ?? [];
  assert.equal(parsed.length, blocks - own.length);
});

/* ── SPDX expressions ───────────────────────────────────────────────────── */

test("resolveLicenseIds picks one alternative from a choice", () => {
  // OR grants either; the notice only has to carry the one relied on
  assert.deepEqual(resolveLicenseIds("MIT OR Apache-2.0"), ["MIT"]);
  assert.deepEqual(resolveLicenseIds("Apache-2.0 OR MIT"), ["MIT"]);
  assert.deepEqual(resolveLicenseIds("Unlicense OR MIT"), ["MIT"]);
  assert.deepEqual(resolveLicenseIds("Zlib OR Apache-2.0 OR MIT"), ["MIT"]);
});

test("resolveLicenseIds keeps every term of a conjunction", () => {
  // AND means both apply, so both texts have to be carried
  assert.deepEqual(resolveLicenseIds("BSD-3-Clause AND MIT"), ["BSD-3-Clause", "MIT"]);
  assert.deepEqual(resolveLicenseIds("Apache-2.0 AND ISC"), ["Apache-2.0", "ISC"]);
});

test("resolveLicenseIds reads the pre-SPDX slash spelling as a choice", () => {
  // older crates (fnv, and 30-odd others) still write it this way
  assert.deepEqual(resolveLicenseIds("MIT/Apache-2.0"), ["MIT"]);
  assert.deepEqual(resolveLicenseIds("Apache-2.0 / MIT"), ["MIT"]);
});

test("resolveLicenseIds handles the one parenthesised expression in the graph", () => {
  // unicode-ident: a choice AND-ed with a second obligation
  assert.deepEqual(resolveLicenseIds("(MIT OR Apache-2.0) AND Unicode-3.0"), [
    "MIT",
    "Unicode-3.0",
  ]);
});

test("resolveLicenseIds falls back to the first alternative it does not rank", () => {
  assert.deepEqual(resolveLicenseIds("Weird-1.0 OR Weirder-2.0"), ["Weird-1.0"]);
});

test("resolveLicenseIds prefers an alternative it can actually reproduce", () => {
  // BSD-2-Clause outranks Zlib in PREFERENCE but has no canonical text, and
  // picking it would abort a regeneration over a choice we were free to make the
  // other way. Same for a term whose better-ranked options are all text-less.
  assert.ok(!("BSD-2-Clause" in LICENSE_TEXTS), "the premise: BSD-2-Clause carries no text");
  assert.deepEqual(resolveLicenseIds("BSD-2-Clause OR Zlib"), ["Zlib"]);
  assert.deepEqual(resolveLicenseIds("0BSD OR MIT-0 OR MPL-2.0"), ["MPL-2.0"]);
  // with nothing reproducible on offer, ranking still decides and the missing
  // text is reported by renderCrateTexts, which names the id and the fix
  assert.deepEqual(resolveLicenseIds("MIT-0 OR BSL-1.0"), ["MIT-0"]);
  // and the ordinary case is untouched
  assert.deepEqual(resolveLicenseIds("MIT OR Apache-2.0"), ["MIT"]);
});

test("every license the crate graph obliges us to carry has a text", () => {
  // the generator throws on a missing one; this states it as a standing fact so
  // a lock bump that introduces a new SPDX id fails here with a clear name
  const crates = parseCrateRows(committed());
  const needed = new Set(crates.flatMap((crate) => resolveLicenseIds(crate.license)));
  const missing = [...needed].filter((id) => !(id in LICENSE_TEXTS));
  assert.deepEqual(missing, [], "add these to scripts/lib/license-texts.ts");
});

test("the reproduced license texts are non-trivial and carry their own headings", () => {
  assert.match(LICENSE_TEXTS["MIT"], /Permission is hereby granted, free of charge/);
  assert.match(LICENSE_TEXTS["Apache-2.0"], /Apache License\n\s+Version 2\.0/);
  // the Apache appendix is part of what the license asks to be carried
  assert.match(LICENSE_TEXTS["Apache-2.0"], /APPENDIX: How to apply the Apache License/);
  assert.match(LICENSE_TEXTS["BSD-3-Clause"], /Neither the name of the copyright holder/);
  for (const [id, text] of Object.entries(LICENSE_TEXTS)) {
    assert.ok(text.length > 300, `${id} text looks truncated (${text.length} chars)`);
  }
});

test("the reproduced texts carry no single crate's copyright line", () => {
  // each body is reproduced ONCE for every crate under that id, and the file's
  // own intro calls them license bodies — so the carrier crate's holder must not
  // ride along as if it covered the others (Dropbox for subtle, Kazlauskas for
  // ring and untrusted, the miniz_oxide holders for foldhash)
  for (const id of ["BSD-3-Clause", "ISC", "Zlib"]) {
    assert.doesNotMatch(
      LICENSE_TEXTS[id],
      /^\s*Copyright/im,
      `${id} still carries a copyright line from whichever crate it was copied out of`
    );
  }
});

/* ── round-trip ─────────────────────────────────────────────────────────── */

test("parseCrateRows reads back exactly what the crate section rendered", () => {
  const crates = parseCrateRows(committed());
  assert.ok(crates.length > 100, "the real graph is hundreds of crates");
  for (const crate of crates) {
    assert.match(crate.version, /^\d+\.\d+\.\d+/, `${crate.name} version`);
    assert.ok(crate.license.length > 0, `${crate.name} license`);
    assert.ok(crate.source.length > 0, `${crate.name} source`);
  }
  // rendering those rows back reproduces the committed file byte for byte —
  // this is the property the gate leans on to skip cargo metadata
  assert.equal(renderLicenses(collectNpmPackages(), crates), committed());
});

test("parseCrateRows stays inside the crate section", () => {
  // the CDLA-Permissive-2.0 text carries `## ` headings of its own, and the
  // MIT/BSD texts carry lines that could pass for rows; a whole-file scan
  // would swallow them
  const crates = parseCrateRows(committed());
  assert.ok(crates.every((crate) => /^[a-zA-Z0-9_.+-]+$/.test(crate.name)), "no prose crate names");
  assert.equal(new Set(crates.map((c) => `${c.name} ${c.version}`)).size, crates.length, "no dupes");
});

/* ── what the gate catches ──────────────────────────────────────────────── */

const CRATES: Crate[] = [
  { name: "serde", version: "1.0.219", license: "MIT OR Apache-2.0", source: "crates.io" },
];

test("renderLicenses is deterministic and free of timestamps", () => {
  const npm = collectNpmPackages();
  const once = renderLicenses(npm, CRATES);
  assert.equal(once, renderLicenses(npm, CRATES), "two renders must agree");
  // a date or a version of our own in the output would make every release a diff
  assert.doesNotMatch(once, /\b20\d{2}-\d{2}-\d{2}\b/, "no ISO date in the generated prose");
});

test("the rendered file states its coverage model and its sibling notices", () => {
  const file = committed();
  assert.match(file, /npm packages\*\* in the production dependency closure/);
  // the conservative claim: the lockfile's whole pinned set, build/test crates
  // included, rather than an unverifiable "what the engine links"
  assert.match(file, /Rust crates\*\* pinned by `src-tauri\/Cargo\.lock`/);
  assert.match(file, /build- and test-only\n {2}crates are listed too/);
  // the honesty clause: crates get one text per license, not one per crate
  assert.match(file, /each distinct license is reproduced once/);
  assert.match(file, /THIRD-PARTY-FONTS\.md/, "the Inter notice is pointed at");
  assert.match(file, /site\/FONT-LICENSES\.md/, "the site webfonts are pointed at");
  assert.match(file, /ships alone inside the app bundle/);
});

test("the rendered file carries no relative repo links (it ships alone)", () => {
  // a [text](../path) link would point at nothing inside Substrate.app
  const links = [...committed().matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
  for (const link of links) {
    assert.match(link, /^(https?|mailto):/, `relative link would dangle in the bundle: ${link}`);
  }
});

test("a crate added to the lock fails the gate, by name", () => {
  // the gate itself, not a render comparison standing in for it: give it a lock
  // carrying one crate the committed notice cannot know about
  const lock = `${realLock()}\n\n[[package]]\nname = "not-in-the-notice"\nversion = "9.9.9"\n`;
  const { ok, problems } = checkLicenseInputs({
    committed: committed(),
    lock,
    npm: collectNpmPackages(),
  });
  assert.equal(ok, false, "a crate in the lock but not in the notice must fail");
  assert.ok(
    problems.some((problem) => problem.includes("+ not-in-the-notice 9.9.9")),
    `no problem named the added crate:\n${problems.join("\n")}`
  );
});

test("a crate dropped from the lock fails the gate, by name", () => {
  // the other direction: the notice claims a crate the lock no longer pins
  const lock = realLock().replace(
    /\[\[package\]\]\nname = "serde"\nversion = "([^"]+)"\n/,
    ""
  );
  const dropped = parseCargoLockPackages(realLock()).find((c) => c.name === "serde");
  assert.ok(dropped, "the real lock is expected to pin serde");
  assert.ok(lock !== realLock(), "the probe must actually remove the block");
  const { ok, problems } = checkLicenseInputs({
    committed: committed(),
    lock,
    npm: collectNpmPackages(),
  });
  assert.equal(ok, false, "a crate in the notice but not in the lock must fail");
  assert.ok(
    problems.some((problem) => problem.includes(`- serde ${dropped.version}`)),
    `no problem named the removed crate:\n${problems.join("\n")}`
  );
});

test("an unchanged tree passes the gate through the same entry point", () => {
  // the negative control for the two probes above: same function, real inputs
  const { ok, problems } = checkLicenseInputs({
    committed: committed(),
    lock: realLock(),
    npm: collectNpmPackages(),
  });
  assert.ok(ok, problems.join("\n"));
});

test("a hand-reordered crate row fails the gate", () => {
  // rows are parsed back out of the file and re-rendered, so this only fails
  // because renderCrateSection re-sorts each group: a shuffled file renders back
  // into canonical order and stops matching its own bytes
  const file = committed();
  const row = /^- \S+ \S+ — .+$/;
  const lines = file.split("\n");
  const at = lines.findIndex((line, i) => row.test(line) && row.test(lines[i + 1] ?? ""));
  assert.ok(at >= 0, "the crate section is expected to have two adjacent rows");
  const swapped = file.replace(
    `${lines[at]}\n${lines[at + 1]}`,
    `${lines[at + 1]}\n${lines[at]}`
  );
  assert.notEqual(swapped, file, "the probe must actually reorder two adjacent rows");

  const { ok, problems } = checkLicenseInputs({
    committed: swapped,
    lock: realLock(),
    npm: collectNpmPackages(),
  });
  assert.equal(ok, false, "a reordered crate row must not pass");
  assert.ok(
    problems.some((problem) => problem.includes("hand-edited")),
    `no problem named the hand-edit:\n${problems.join("\n")}`
  );
});

test("a mangled license body fails the gate", () => {
  // the comparison is over the whole document, not just a set of names
  const mangled = committed().replace(
    "Permission is hereby granted, free of charge",
    "Permission is hereby REVOKED, free of charge"
  );
  assert.notEqual(mangled, committed(), "the probe must actually change something");
  const { ok, problems } = checkLicenseInputs({
    committed: mangled,
    lock: realLock(),
    npm: collectNpmPackages(),
  });
  assert.equal(ok, false, "a mangled license body must not pass");
  assert.ok(
    problems.some((problem) => problem.includes("hand-edited")),
    `no problem named the hand-edit:\n${problems.join("\n")}`
  );
});

test("a crate row moved to another license heading PASSES — the gate's known gap", () => {
  /* Not a wish: a characterization test, pinning the hole checkLicenses'
     comment describes. Crate license strings are read back out of the committed
     file and trusted, so an edit that only moves a row between two existing
     `### ` headings re-renders into exactly the edited file. Closing it would
     mean running `cargo metadata` in the gate, which is the dependency the
     split exists to avoid; `--write` re-derives licenses from metadata and
     corrects it. If this ever starts failing, the gate got STRONGER — delete
     the test and the caveat in checkLicenseInputs' docstring together. */
  const crates = parseCrateRows(committed());
  const byLicense = new Map<string, Crate[]>();
  for (const crate of crates) byLicense.set(crate.license, [...(byLicense.get(crate.license) ?? []), crate]);
  const [from, to] = [...byLicense.keys()].filter((id) => byLicense.get(id)!.length > 1);
  assert.ok(from && to, "the real graph is expected to have two multi-crate license groups");

  const victim = byLicense.get(from)![0];
  const moved = crates.map((crate) => (crate === victim ? { ...crate, license: to } : crate));
  const edited = renderLicenses(collectNpmPackages(), moved);
  assert.notEqual(edited, committed(), "the probe must actually move a row");

  const { ok } = checkLicenseInputs({ committed: edited, lock: realLock(), npm: collectNpmPackages() });
  assert.equal(ok, true, `${victim.name} moved from ${from} to ${to} is the documented blind spot`);
});
