#!/usr/bin/env node
/**
 * THIRD-PARTY-LICENSES.md generator and staleness gate.
 *
 * The app ships other people's code: the vite-compiled npm bundle (the
 * production `dependencies` closure) and the compiled Rust engine (every crate
 * in src-tauri/Cargo.lock). MIT, BSD and Apache all condition redistribution on
 * carrying the notice along, and a DMG or updater tarball is redistribution, so
 * the notice file has to be IN the bundle — same reasoning as
 * THIRD-PARTY-FONTS.md, which this file sits beside in `bundle.resources`.
 *
 * Shape, and why the two halves differ:
 *
 *   npm   — each package ships its own LICENSE file with its own copyright
 *           line, and node_modules is already on disk after `npm ci`. So every
 *           package gets its full license text reproduced verbatim. That is the
 *           notice-retention point, done properly.
 *   crate — Cargo.lock has no license field and `cargo metadata` exposes only
 *           the SPDX expression, never the copyright holder. There is no
 *           per-crate notice to reproduce without vendoring 570 crate sources,
 *           so crates are listed (name, version, license, source) and each
 *           distinct license is reproduced ONCE from scripts/lib/license-texts.ts.
 *           The generated file says this plainly rather than implying coverage
 *           it doesn't have.
 *
 * Two modes, mirroring scripts/gen-changelog.ts:
 *   (default)  render to stdout
 *   --write    rewrite THIRD-PARTY-LICENSES.md at the repo root
 *
 * Deterministic by construction: stable sort by name, no timestamps, no version
 * of our own in the output — so a regeneration that changes nothing produces a
 * byte-identical file and the drift gate stays quiet. Every sort is by CODEPOINT
 * (`byCodepoint` below) rather than `localeCompare`: locale collation is ICU
 * data, which differs across Node builds and platforms, and the committed bytes
 * of a gated file must not depend on which machine ran the generator.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LICENSE_TEXTS } from "./lib/license-texts.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the rendered notice lives. */
export const LICENSES_MD = resolve(ROOT, "THIRD-PARTY-LICENSES.md");

/** The command the gate tells a human to run. Kept in one place so the test,
 *  the error message and the file's own banner cannot drift apart. */
export const REGEN_COMMAND = "node scripts/gen-third-party-licenses.ts --write";

/**
 * Codepoint ordering, the one comparison that is the same everywhere.
 *
 * `String.prototype.localeCompare` sorts by ICU collation, which ignores
 * punctuation differences that codepoint order does not (`serde-untagged` vs
 * `serde_core` land in different orders under the two rules) and which is not
 * pinned across Node builds. Since the rendered file is byte-compared by the
 * gate, the ordering has to be a property of the data and not of the runtime.
 */
export function byCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ── npm side ───────────────────────────────────────────────────────────── */

export interface NpmPackage {
  /** Package name as published, e.g. `@codemirror/view`. */
  name: string;
  version: string;
  /** SPDX id from the package's own package.json, or null when it declares none. */
  license: string | null;
  /** Verbatim LICENSE/LICENCE/COPYING text, or null when the package ships none. */
  text: string | null;
  /** Which file the text came from, for the per-package attribution line. */
  textFile: string | null;
}

/** package-lock v3 shape, narrowed to the fields this script reads. */
interface LockEntry {
  version?: string;
  license?: string;
  dev?: boolean;
  devOptional?: boolean;
}

/**
 * The PRODUCTION closure out of package-lock.json.
 *
 * npm already solved this: lockfileVersion 3 marks every entry reachable only
 * through devDependencies with `dev: true` (and `devOptional: true` for one
 * reachable both ways but optional in prod), so the closure is a filter rather
 * than a graph walk we'd have to keep correct ourselves. The root entry (key
 * "") is Substrate itself and is skipped — the app's own AGPL license is in
 * LICENSE, not in a third-party notice.
 */
export function productionPackagePaths(lock: {
  packages?: Record<string, LockEntry>;
}): string[] {
  const packages = lock.packages ?? {};
  return Object.entries(packages)
    .filter(([path, entry]) => path !== "" && !entry.dev && !entry.devOptional)
    .map(([path]) => path)
    .sort();
}

/**
 * LICENSE / LICENCE / COPYING, in the spelling the package happened to pick:
 * bare, with a text extension, or suffixed with the SPDX id (`LICENSE-MIT`,
 * `LICENSE_APACHE-2.0`). Anchored, and source-code extensions excluded, so a
 * script that merely starts with the word — `LICENSE-check.js` — is not
 * reproduced into the notice as if it were a license.
 */
const LICENSE_FILE = /^(licen[sc]e|copying)([-_.][\w.+-]*)?$/i;
const CODE_EXTENSION = /\.(js|cjs|mjs|jsx|ts|cts|mts|tsx|json|map|css|html|sh|py|rs)$/i;

/**
 * The license file a package ships, if any. Sorted so a package carrying both
 * `LICENSE_APACHE-2.0` and `LICENSE_MIT` (the @tauri-apps packages do) picks
 * the same one on every run rather than whatever readdir returned first.
 */
export function findLicenseFile(files: readonly string[]): string | null {
  const matches = files
    .filter((file) => LICENSE_FILE.test(file) && !CODE_EXTENSION.test(file))
    .sort(byCodepoint);
  return matches[0] ?? null;
}

/** Thrown when the lock names a package that is not installed. Carries the fix
 *  rather than an ENOENT with a path in it, because that is always the same fix. */
export class MissingPackageError extends Error {
  // a plain field, not a constructor parameter property: Node runs these scripts
  // in type-stripping mode, which cannot desugar one
  readonly path: string;

  constructor(path: string) {
    super(
      `package-lock.json lists ${path}, but it is not installed in node_modules.\n` +
        "  The notice reproduces license files off disk, so the closure has to be present:\n" +
        "  run `npm ci` (a platform-gated optional package can also be missing on this OS)\n" +
        `  and then \`${REGEN_COMMAND}\`.`
    );
    this.name = "MissingPackageError";
    this.path = path;
  }
}

/**
 * Read one installed package off disk. Reads the package's OWN package.json
 * rather than trusting the lock's `license` field: the lock caches what the
 * registry reported, and the installed copy is what actually ships.
 */
export function readNpmPackage(root: string, path: string): NpmPackage {
  const dir = resolve(root, path);
  let manifest: { name?: string; version: string; license?: string | { type?: string } };
  try {
    manifest = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new MissingPackageError(path);
    throw error;
  }
  const license =
    typeof manifest.license === "string"
      ? manifest.license
      : typeof manifest.license?.type === "string"
        ? manifest.license.type
        : null;

  const textFile = findLicenseFile(readdirSync(dir));
  const text = textFile ? readFileSync(resolve(dir, textFile), "utf8").replace(/\s+$/, "") : null;

  return { name: manifest.name ?? path.replace(/^node_modules\//, ""), version: manifest.version, license, text, textFile };
}

/** Every production package, read off disk, sorted by name. */
export function collectNpmPackages(root = ROOT): NpmPackage[] {
  const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
  return productionPackagePaths(lock)
    .map((path) => readNpmPackage(root, path))
    .sort((a, b) => byCodepoint(a.name, b.name));
}

/* ── crate side ─────────────────────────────────────────────────────────── */

export interface Crate {
  name: string;
  version: string;
  /** Raw SPDX expression from cargo metadata, e.g. `MIT OR Apache-2.0`. */
  license: string;
  /** crates.io registry, or a git/path source spelled out. */
  source: string;
}

/**
 * Substrate's own crates, which are not third parties. The hosted-sync blob
 * server is a separate crate because it deploys as its own binary, and it
 * reaches the lockfile as a dev-dependency of the round-trip test; it is still
 * this repository's AGPL code, covered by the `LICENSE` file like the app.
 */
const OWN_CRATES = ["substrate", "substrate-hosted-sync-server"];

/**
 * Every `[[package]]` in Cargo.lock as a name/version pair.
 *
 * Plain text parsing on the same reasoning gen-changelog.ts gives for the same
 * file: a notice gate is not worth a TOML dependency. This is the SET of what
 * ships; licenses come from cargo metadata below.
 */
export function parseCargoLockPackages(lock: string): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = [];
  for (const block of lock.split(/^\[\[package\]\]$/m).slice(1)) {
    const name = block.match(/^\s*name\s*=\s*"([^"]+)"/m);
    const version = block.match(/^\s*version\s*=\s*"([^"]+)"/m);
    if (!name || !version) throw new Error("Cargo.lock has a [[package]] with no name or version");
    if (OWN_CRATES.includes(name[1])) continue;
    out.push({ name: name[1], version: version[1] });
  }
  return out.sort((a, b) => byCodepoint(a.name, b.name) || byCodepoint(a.version, b.version));
}

/**
 * The crate graph with licenses attached.
 *
 * `--offline --locked` on purpose: the registry cache is already populated by
 * any build, and the flags turn "would need the network" into a loud failure
 * instead of a silent fetch. `--locked` additionally refuses to run if
 * Cargo.lock would have to change, so a generated file can never describe a
 * graph the lock doesn't pin.
 */
export function collectCrates(root = ROOT): Crate[] {
  const json = execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--offline", "--locked"],
    { cwd: resolve(root, "src-tauri"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const metadata = JSON.parse(json) as {
    packages: { name: string; version: string; license?: string | null; source?: string | null }[];
  };

  return metadata.packages
    .filter((pkg) => !OWN_CRATES.includes(pkg.name))
    .map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? "(no license declared)",
      source: pkg.source ?? "(local path dependency)",
    }))
    .sort((a, b) => byCodepoint(a.name, b.name) || byCodepoint(a.version, b.version));
}

/* ── SPDX expressions ───────────────────────────────────────────────────── */

/**
 * Which alternative to reproduce when a crate offers a choice.
 *
 * `MIT OR Apache-2.0` grants the recipient either; the notice only has to carry
 * the one relied on. Order is by how much text it takes to satisfy the same
 * obligation — MIT before Apache-2.0 keeps the file readable — with the
 * copyleft and data licenses last because nothing picks them over a permissive
 * sibling anyway. Everything a crate offers is still LISTED in its row; this
 * only chooses which full texts the file has to carry.
 *
 * Several ids here have no canonical text in license-texts.ts (BSD-2-Clause,
 * 0BSD, MIT-0, Unlicense, BSL-1.0, LGPL-2.1-or-later): they are ranked so a
 * choice involving them resolves predictably, but resolveLicenseIds prefers an
 * alternative it can actually reproduce over a better-ranked one it cannot —
 * otherwise `BSD-2-Clause OR Zlib` would pick the id with no text and abort a
 * regeneration that had a perfectly good reproducible option beside it.
 */
const PREFERENCE = [
  "MIT",
  "Apache-2.0",
  "ISC",
  "BSD-3-Clause",
  "BSD-2-Clause",
  "Zlib",
  "0BSD",
  "MIT-0",
  "Unlicense",
  "BSL-1.0",
  "CC0-1.0",
  "Unicode-3.0",
  "CDLA-Permissive-2.0",
  "MPL-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "LGPL-2.1-or-later",
];

/**
 * The license ids a crate's expression actually obliges us to reproduce.
 *
 * AND is conjunctive (every term applies), OR is a choice (pick one). Older
 * crates spell the choice `MIT/Apache-2.0` with a slash, which predates SPDX
 * and means OR. Parentheses appear in exactly one expression in the graph
 * (`(MIT OR Apache-2.0) AND Unicode-3.0`) and are stripped rather than parsed:
 * a full SPDX expression parser would be a lot of machinery for one crate, and
 * the flat split lands on the same answer for every shape present.
 *
 * Within a choice, an alternative whose text we carry always beats one we do
 * not, whatever PREFERENCE says — picking an id with no canonical text aborts
 * the whole regeneration, and a choice means we are free to rely on the other.
 */
export function resolveLicenseIds(expression: string): string[] {
  const normalised = expression.replace(/\//g, " OR ").replace(/\s+/g, " ").trim();
  return normalised.split(/\s+AND\s+/).map((term) => {
    const alternatives = term.replace(/[()]/g, "").split(/\s+OR\s+/).map((s) => s.trim());
    const reproducible = alternatives.filter((id) => id in LICENSE_TEXTS);
    const candidates = reproducible.length > 0 ? reproducible : alternatives;

    let best: string | null = null;
    let rank = Number.POSITIVE_INFINITY;
    for (const alternative of candidates) {
      const index = PREFERENCE.indexOf(alternative);
      if (index >= 0 && index < rank) {
        rank = index;
        best = alternative;
      }
    }
    return best ?? candidates[0];
  });
}

/* ── rendering ──────────────────────────────────────────────────────────── */

/** A fenced block that can hold a license text containing its own backticks. */
function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}\n${text}\n${ticks}`;
}

/** Registry URLs are noise in a row; the human-meaningful part is the host. */
function describeSource(source: string): string {
  if (source.startsWith("registry+https://github.com/rust-lang/crates.io-index")) {
    return "crates.io";
  }
  return source;
}

function renderIntro(npm: readonly NpmPackage[], crates: readonly Crate[]): string {
  return [
    "# Third-party licenses in the Substrate desktop app",
    "",
    "Substrate itself is licensed under the GNU Affero General Public License v3.0;",
    "that license text is in the repository's own `LICENSE` file. This file covers",
    "the third-party code the app bundles and ships:",
    "",
    `- the **${npm.length} npm packages** in the production dependency closure, compiled into`,
    "  the app's frontend bundle;",
    `- the **${crates.length} Rust crates** pinned by \`src-tauri/Cargo.lock\`, listed`,
    "  conservatively — the lockfile is the whole pinned set, so build- and test-only",
    "  crates are listed too rather than guessed away.",
    "",
    "MIT, BSD and Apache-style licenses all condition redistribution on the notice",
    "travelling with the software, and an app bundle, DMG or updater tarball is",
    "redistribution — so this file ships inside the app.",
    "",
    "## What is reproduced, and what is not",
    "",
    "The two halves are covered differently, because the two ecosystems expose",
    "different things:",
    "",
    "- **npm packages** ship their own license file, with their own copyright line.",
    "  Each package below therefore carries its license text reproduced in full,",
    "  verbatim from the installed package. Where a package declares a license but",
    "  ships no license file, that is stated in place of the text.",
    "- **Rust crates** are pinned by a lockfile that records no license at all, and",
    "  crate metadata carries only the SPDX expression — never the copyright",
    "  holder. Each crate is therefore listed with its version, license and source,",
    "  and each distinct license is reproduced once, in full, in the",
    "  \"Rust crate license texts\" section. Where a crate offers a choice",
    "  (`MIT OR Apache-2.0`), the row names every option and the reproduced text is",
    "  the one relied on.",
    "",
    "Two related notices live elsewhere:",
    "",
    "- The bundled **Inter** font is under the SIL Open Font License and is covered",
    "  in `THIRD-PARTY-FONTS.md`, which ships beside this file in the app bundle.",
    "- The **landing page's** webfonts are distributed separately with the site and",
    "  are covered in `site/FONT-LICENSES.md` in the source repository.",
    "",
    "This file ships alone inside the app bundle, so it links to nothing relative.",
    "",
  ].join("\n");
}

function renderNpmSection(packages: readonly NpmPackage[]): string {
  const parts = [
    "## npm packages bundled in the app",
    "",
    "The production dependency closure of `package.json` — the direct dependencies",
    "and everything they pull in. Development-only packages (build tooling, test",
    "runners, type definitions) are not shipped and are not listed.",
    "",
  ];

  for (const pkg of packages) {
    parts.push(`### ${pkg.name} ${pkg.version}`, "");
    parts.push(`License: ${pkg.license ?? "not declared in the package"}`, "");
    if (pkg.text) {
      parts.push(`Reproduced from the package's \`${pkg.textFile}\`:`, "", fence(pkg.text), "");
    } else {
      // the license id is already on the line above; all this branch adds is the
      // absence of a text to reproduce
      parts.push("No license file is shipped in the package.", "");
    }
  }

  return parts.join("\n");
}

/**
 * Crate rows grouped by license, each group in a canonical order.
 *
 * The re-sort is what makes the gate's "a reordered row fails too" claim true:
 * the rows are parsed back out of the committed file and re-rendered, so without
 * it a hand-shuffled group would round-trip unchanged and pass. Sorting here
 * means any order but this one renders differently from what is committed.
 */
function renderCrateSection(crates: readonly Crate[]): string {
  const groups = new Map<string, Crate[]>();
  for (const crate of crates) {
    const group = groups.get(crate.license) ?? [];
    group.push(crate);
    groups.set(crate.license, group);
  }

  const parts = [
    "## Rust crates linked into the app",
    "",
    "Every crate in `src-tauri/Cargo.lock`, grouped by the license expression its",
    "own metadata declares. `A OR B` means the crate grants a choice of either.",
    "",
  ];

  for (const license of [...groups.keys()].sort(byCodepoint)) {
    const group = [...groups.get(license)!].sort(
      (a, b) => byCodepoint(a.name, b.name) || byCodepoint(a.version, b.version)
    );
    parts.push(`### ${license}`, "", `${group.length} crate${group.length === 1 ? "" : "s"}:`, "");
    for (const crate of group) {
      parts.push(`- ${crate.name} ${crate.version} — ${describeSource(crate.source)}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

function renderCrateTexts(crates: readonly Crate[]): string {
  const needed = new Set<string>();
  for (const crate of crates) {
    for (const id of resolveLicenseIds(crate.license)) needed.add(id);
  }

  const missing = [...needed].filter((id) => !(id in LICENSE_TEXTS)).sort();
  if (missing.length > 0) {
    throw new Error(
      `no canonical text for SPDX id(s): ${missing.join(", ")}\n` +
        "  Add them to scripts/lib/license-texts.ts, copied verbatim from a crate that carries one."
    );
  }

  const parts = [
    "## Rust crate license texts",
    "",
    "Each license named above, reproduced once in full. Crate metadata carries no",
    "copyright holder, so these are the license bodies; the crates they apply to",
    "are the ones listed under the matching heading above.",
    "",
  ];

  for (const id of [...needed].sort(byCodepoint)) {
    parts.push(`### ${id}`, "", fence(LICENSE_TEXTS[id]), "");
  }

  return parts.join("\n");
}

/**
 * The whole file. Pure function of its inputs — no clock, no environment.
 *
 * Sections are trimmed at their own edges and joined with one blank line, never
 * whitespace-collapsed globally: several of the reproduced license texts (CC0,
 * Apache-2.0) contain runs of blank lines of their own, and "verbatim" has to
 * survive the assembly step.
 */
export function renderLicenses(npm: readonly NpmPackage[], crates: readonly Crate[]): string {
  const banner =
    "<!-- Generated by scripts/gen-third-party-licenses.ts from package-lock.json\n" +
    "     and src-tauri/Cargo.lock. Do not edit by hand: run\n" +
    `     \`${REGEN_COMMAND}\` instead. -->`;

  const sections = [
    renderIntro(npm, crates),
    banner,
    renderNpmSection(npm),
    renderCrateSection(crates),
    renderCrateTexts(crates),
  ];
  return `${sections.map((section) => section.replace(/\s+$/, "")).join("\n\n")}\n`;
}

/** Read both ecosystems off disk and render. */
export function generate(root = ROOT): string {
  return renderLicenses(collectNpmPackages(root), collectCrates(root));
}

/* ── the gate ───────────────────────────────────────────────────────────── */

const CRATE_SECTION_START = "## Rust crates linked into the app";
const CRATE_SECTION_END = "## Rust crate license texts";

/**
 * The crate rows back out of a generated file.
 *
 * This is what lets the drift test skip `cargo metadata` — see checkLicenses
 * below for why that matters. Bounded to the crate section on purpose: license
 * texts elsewhere in the file contain `## ` headings of their own (the CDLA
 * text does), and a whole-file scan would swallow them.
 */
export function parseCrateRows(markdown: string): Crate[] {
  const from = markdown.indexOf(`\n${CRATE_SECTION_START}\n`);
  const to = markdown.indexOf(`\n${CRATE_SECTION_END}\n`, from);
  if (from < 0 || to < 0) {
    throw new Error(`THIRD-PARTY-LICENSES.md has no "${CRATE_SECTION_START}" section`);
  }

  const crates: Crate[] = [];
  let license: string | null = null;
  for (const line of markdown.slice(from, to).split("\n")) {
    const heading = line.match(/^### (.+)$/);
    if (heading) {
      license = heading[1];
      continue;
    }
    const row = line.match(/^- (\S+) (\S+) — (.+)$/);
    if (!row) continue;
    if (!license) throw new Error(`crate row before any license heading: ${line}`);
    crates.push({ name: row[1], version: row[2], license, source: row[3] });
  }
  return crates;
}

export interface CheckResult {
  ok: boolean;
  problems: string[];
}

/**
 * The staleness gate: does the committed file still describe what ships?
 *
 * Deliberately does NOT shell out to `cargo metadata`, even though generation
 * does. The unit suite runs in places a cargo registry cache is not guaranteed
 * (a fresh clone, a frontend-only CI job), and `--offline --locked` is designed
 * to fail loudly there — which would turn a licence gate into a flaky
 * dependency on cargo state rather than a check on the file.
 *
 * The split that buys: crate NAMES and VERSIONS are re-derived from Cargo.lock
 * by plain text parsing, so adding, removing or bumping a crate fails the gate;
 * crate LICENSE STRINGS are read back out of the committed file, trusted from
 * generation time. The npm half needs no such trust — node_modules is on disk
 * after `npm ci`, so it is regenerated in full and byte-compared.
 *
 * With the crate licenses supplied from the file itself, the comparison is over
 * the WHOLE rendered document rather than a set of names, so a hand-edit to any
 * part the file does not itself supply — intro prose, an npm row, a mangled
 * license body, a shuffled crate row — fails. Row order is not free either:
 * renderCrateSection re-sorts each group, so a reordered file renders back
 * differently rather than round-tripping.
 *
 * The gaps this leaves, both of them the same gap, stated plainly: whatever is
 * read back out of the committed file is trusted, so nothing that only changes a
 * crate's LICENSE is caught. That is (1) a crate that changes its license
 * without changing its version — crates.io forbids republishing a version, so
 * this needs a yanked-and-repinned lock entry, which moves the version and IS
 * caught — and (2) a hand-edit that moves a crate row to a different `###`
 * license heading, which re-renders into exactly the edited file and passes.
 * Closing (2) would mean running `cargo metadata` in the gate, which is the
 * dependency this split exists to avoid; `--write` re-derives every license from
 * metadata, so a regeneration corrects it.
 *
 * Split in two so the gate is testable without a disk: this half is a pure
 * function of the three inputs, and checkLicenses below just fetches them.
 */
export function checkLicenseInputs(inputs: {
  /** Contents of the committed THIRD-PARTY-LICENSES.md. */
  committed: string;
  /** Contents of src-tauri/Cargo.lock. */
  lock: string;
  /** The installed production npm closure. */
  npm: readonly NpmPackage[];
}): CheckResult {
  const problems: string[] = [];
  const { committed, lock, npm } = inputs;

  const crates = parseCrateRows(committed);
  const key = (crate: { name: string; version: string }) => `${crate.name} ${crate.version}`;
  const listed = new Set(crates.map(key));
  const locked = new Set(parseCargoLockPackages(lock).map(key));

  const added = [...locked].filter((crate) => !listed.has(crate)).sort();
  const removed = [...listed].filter((crate) => !locked.has(crate)).sort();
  if (added.length > 0 || removed.length > 0) {
    problems.push(
      "THIRD-PARTY-LICENSES.md does not match src-tauri/Cargo.lock:\n" +
        [
          ...added.map((crate) => `  + ${crate} (in the lock, not in the notice)`),
          ...removed.map((crate) => `  - ${crate} (in the notice, not in the lock)`),
        ].join("\n") +
        `\n  Run \`${REGEN_COMMAND}\` and commit the result.`
    );
  }

  const expected = renderLicenses(npm, crates);
  if (committed !== expected) {
    problems.push(
      "THIRD-PARTY-LICENSES.md is stale — it does not match the installed\n" +
        "  production npm closure, or it has been hand-edited.\n" +
        `  Run \`${REGEN_COMMAND}\` and commit the result.`
    );
  }

  return { ok: problems.length === 0, problems };
}

/** The gate against a checkout: read the three inputs off disk and compare. */
export function checkLicenses(root = ROOT): CheckResult {
  let committed: string;
  try {
    committed = readFileSync(resolve(root, "THIRD-PARTY-LICENSES.md"), "utf8");
  } catch {
    return { ok: false, problems: [`THIRD-PARTY-LICENSES.md is missing — run \`${REGEN_COMMAND}\``] };
  }

  const lock = readFileSync(resolve(root, "src-tauri/Cargo.lock"), "utf8");

  let npm: NpmPackage[];
  try {
    npm = collectNpmPackages(root);
  } catch (error) {
    // an uninstalled package is a state of the checkout, not of the notice: say
    // so as a gate problem rather than throwing a bare ENOENT out of the suite
    if (error instanceof MissingPackageError) return { ok: false, problems: [error.message] };
    throw error;
  }

  return checkLicenseInputs({ committed, lock, npm });
}

/* ── main ───────────────────────────────────────────────────────────────── */

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "usage: node scripts/gen-third-party-licenses.ts [--write]\n\n" +
        "  (no args)  render THIRD-PARTY-LICENSES.md to stdout\n" +
        "  --write    rewrite THIRD-PARTY-LICENSES.md at the repo root"
    );
    return 0;
  }

  const rendered = generate();

  if (!argv.includes("--write")) {
    process.stdout.write(rendered);
    return 0;
  }

  const before = (() => {
    try {
      return readFileSync(LICENSES_MD, "utf8");
    } catch {
      return null;
    }
  })();
  if (before === rendered) {
    console.log("THIRD-PARTY-LICENSES.md already current — nothing written.");
    return 0;
  }
  writeFileSync(LICENSES_MD, rendered);
  console.log(`Wrote THIRD-PARTY-LICENSES.md.`);
  return 0;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
