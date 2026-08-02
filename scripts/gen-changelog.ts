#!/usr/bin/env node
/**
 * CHANGELOG.md generator and staleness gate (SUB-588).
 *
 * Substrate had two changelogs that drifted apart: `src/lib/changelog.ts` (the
 * in-app pane, kept current because a human sees it) and `CHANGELOG.md` (the
 * repo-root file, last touched at 0.2.0 while the app reached 0.15.0). A beta
 * tester asking "which version am I on and what changed" deserves one answer,
 * so changelog.ts is now the single source and this script renders the Markdown.
 *
 * Two modes:
 *   (default)  rewrite CHANGELOG.md from CHANGELOG[]
 *   --check    exit 1 when the on-disk file differs from that render, or when
 *              the four version numbers disagree
 *
 * The version check covers changelog.ts's newest entry, package.json,
 * src-tauri/tauri.conf.json, src-tauri/Cargo.toml and the `substrate` entry in
 * src-tauri/Cargo.lock — the five places a release bump has to touch, and which
 * a hand-edited release routinely misses (SUB-620: a 0.15.0 lock survived the
 * 0.16.0 bump because only the first four were cross-checked).
 * Cargo.toml, Cargo.lock and tauri.conf.json are read with plain text/JSON
 * parsing on purpose: a changelog gate is not worth a TOML dependency.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CHANGELOG,
  KIND_LABEL,
  groupRelease,
  type ChangelogRelease,
} from "../src/lib/changelog.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the rendered file lives, and where the sources of truth are read from. */
export const CHANGELOG_MD = resolve(ROOT, "CHANGELOG.md");

/* ── rendering ──────────────────────────────────────────────────────────── */

/** Body width for wrapped bullet text, matching the hand-written original. */
const WRAP = 88;

/**
 * Greedy word-wrap for one bullet: first line carries the `- ` marker, the
 * continuation lines indent by two so the text stays in one column. Words
 * longer than the budget (a URL, say) overhang rather than being broken.
 */
export function wrapBullet(text: string, width = WRAP): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "-";
  for (const word of words) {
    if (line !== "-" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = " ";
    }
    line += ` ${word}`;
  }
  lines.push(line);
  return lines.join("\n");
}

/**
 * One release as `## <version> — <date> — <title>` plus its structured body
 * (SUB-817): headline items under `### Highlights`, then the remaining items
 * under `### New` / `### Improved` / `### Fixed` — the same grouping the
 * in-app pane renders, so the two surfaces stay one document.
 */
export function renderRelease(release: ChangelogRelease): string {
  const { headlines, groups } = groupRelease(release);
  const parts: string[] = [`## ${release.version} — ${release.date} — ${release.title}`];
  if (headlines.length > 0) {
    parts.push("### Highlights", headlines.map((item) => wrapBullet(item.text)).join("\n"));
  }
  for (const group of groups) {
    parts.push(`### ${KIND_LABEL[group.kind]}`, group.items.map((item) => wrapBullet(item.text)).join("\n"));
  }
  return `${parts.join("\n\n")}\n`;
}

/**
 * The whole file, newest first. Generated-by banner included so the next
 * person to hand-edit it sees where the content actually lives before they
 * lose their edit to the next run.
 */
export function renderChangelog(releases: readonly ChangelogRelease[] = CHANGELOG): string {
  const head =
    "# Changelog\n\n" +
    "<!-- Generated from src/lib/changelog.ts by scripts/gen-changelog.ts.\n" +
    "     Edit that file, then run `node scripts/gen-changelog.ts`. -->\n";
  return [head, ...releases.map(renderRelease)].join("\n");
}

/* ── version agreement ──────────────────────────────────────────────────── */

export interface VersionSet {
  changelog: string;
  packageJson: string;
  tauriConf: string;
  cargoToml: string;
  cargoLock: string;
}

/**
 * The `[package]` version out of Cargo.toml. Scoped to that table on purpose:
 * a bare `version = "…"` grep would happily return a dependency's pin from
 * whichever table came first.
 */
export function parseCargoVersion(toml: string): string {
  const pkg = toml.split(/^\[/m).find((section) => section.startsWith("package]"));
  if (!pkg) throw new Error("Cargo.toml has no [package] table");
  const match = pkg.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("Cargo.toml [package] has no version");
  return match[1];
}

/**
 * The `substrate` package's version out of Cargo.lock. The lock has hundreds of
 * `[[package]]` blocks, so this walks them and matches on `name = "substrate"`
 * rather than grepping for a version line — a bare grep would return whichever
 * dependency happened to come first.
 */
export function parseCargoLockVersion(lock: string, name = "substrate"): string {
  for (const block of lock.split(/^\[\[package\]\]$/m).slice(1)) {
    if (!new RegExp(`^\\s*name\\s*=\\s*"${name}"\\s*$`, "m").test(block)) continue;
    const match = block.match(/^\s*version\s*=\s*"([^"]+)"/m);
    if (!match) throw new Error(`Cargo.lock package "${name}" has no version`);
    return match[1];
  }
  throw new Error(`Cargo.lock has no [[package]] named "${name}"`);
}

/** The five versions a release bump must keep in step. */
export function readVersions(root = ROOT): VersionSet {
  const json = (rel: string) => JSON.parse(readFileSync(resolve(root, rel), "utf8"));
  const tauri = json("src-tauri/tauri.conf.json");
  const tauriVersion = tauri.version ?? tauri.package?.version;
  if (typeof tauriVersion !== "string") {
    throw new Error("tauri.conf.json has no version");
  }
  return {
    changelog: CHANGELOG[0]?.version ?? "(empty changelog)",
    packageJson: json("package.json").version,
    tauriConf: tauriVersion,
    cargoToml: parseCargoVersion(readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8")),
    cargoLock: parseCargoLockVersion(
      readFileSync(resolve(root, "src-tauri/Cargo.lock"), "utf8")
    ),
  };
}

/** Disagreement message, or null when all five match. */
export function versionMismatch(versions: VersionSet): string | null {
  const unique = new Set(Object.values(versions));
  if (unique.size === 1) return null;
  const lines = Object.entries(versions).map(([source, version]) => `  ${source}: ${version}`);
  return `version sources disagree:\n${lines.join("\n")}`;
}

/* ── the gate ───────────────────────────────────────────────────────────── */

export interface CheckResult {
  ok: boolean;
  problems: string[];
}

/** Both halves of `--check`: rendered-vs-on-disk, and version agreement. */
export function checkChangelog(root = ROOT): CheckResult {
  const problems: string[] = [];

  const mismatch = versionMismatch(readVersions(root));
  if (mismatch) problems.push(mismatch);

  const expected = renderChangelog();
  let actual: string | null = null;
  try {
    actual = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
  } catch {
    problems.push("CHANGELOG.md is missing — run `node scripts/gen-changelog.ts`");
  }
  if (actual !== null && actual !== expected) {
    problems.push(
      "CHANGELOG.md is stale — it does not match src/lib/changelog.ts.\n" +
        "  Run `node scripts/gen-changelog.ts` and commit the result."
    );
  }

  return { ok: problems.length === 0, problems };
}

/* ── main ───────────────────────────────────────────────────────────────── */

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "usage: node scripts/gen-changelog.ts [--check]\n\n" +
        "  (no args)  rewrite CHANGELOG.md from src/lib/changelog.ts\n" +
        "  --check    exit 1 if CHANGELOG.md is stale or the versions disagree"
    );
    return 0;
  }

  if (argv.includes("--check")) {
    const { ok, problems } = checkChangelog();
    if (ok) {
      console.log("CHANGELOG.md is current.");
      return 0;
    }
    for (const problem of problems) console.error(problem);
    return 1;
  }

  const rendered = renderChangelog();
  const before = (() => {
    try {
      return readFileSync(CHANGELOG_MD, "utf8");
    } catch {
      return null;
    }
  })();
  if (before === rendered) {
    console.log("CHANGELOG.md already current — nothing written.");
    return 0;
  }
  writeFileSync(CHANGELOG_MD, rendered);
  console.log(`Wrote CHANGELOG.md (${CHANGELOG.length} releases).`);
  return 0;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
