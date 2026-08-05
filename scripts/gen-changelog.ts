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
 *   --check    exit 1 when the on-disk file differs from that render, when the
 *              five version numbers disagree, or when a `private: true` item
 *              is not inside a share-mirror strip fence (SUB-985)
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
 * in-app pane renders, so the two surfaces stay one document. `private` items
 * describe machine-local surfaces (SUB-830) and stay out of the rendered
 * file — CHANGELOG.md and release notes describe what a download actually
 * contains.
 */
export function renderRelease(release: ChangelogRelease): string {
  const { headlines, groups } = groupRelease({
    ...release,
    items: release.items.filter((item) => !item.private),
  });
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

/* ── private-item fencing (SUB-985) ─────────────────────────────────────── */

/**
 * `private: true` items are filtered out of the rendered CHANGELOG.md and the
 * stock in-app pane — but changelog.ts itself SHIPS in the public source
 * mirror, so the only thing keeping a private item's prose out of the mirror
 * is a share-mirror strip fence around it. share-mirror.sh's `--check` can
 * validate fences that exist; it is structurally blind to a fence that was
 * never added (v0.22.0 added three unfenced private items and `--check`
 * passed). This scan closes that hole from the other side: it fails the unit
 * suite — a required gate on every branch — when a private item sits outside
 * a fenced region.
 */
/* Assembled rather than written out, and split before `strip` rather than
   after: this file SHIPS in the mirror, so a whole marker on a line would be
   read as a real fence by the strip pass (stripping the scanner out of the
   snapshot it protects), and even the marker's PREFIX is a share-denylist
   entry — the mirror refuses to ship any file that names it. Both traps are
   only avoided if no literal `share-mirror` + `:strip` sits in the source. */
const STRIP_START = `share-mirror:${"strip"}-start`;
const STRIP_END = `share-mirror:${"strip"}-end`;

/**
 * Which lines share-mirror.sh's strip pass would remove, by the same rules its
 * awk uses: marker lines go, so does everything between them, and markers must
 * balance. Returns a per-line flag plus the first structural error, if any.
 */
export function scanFences(source: string): { stripped: boolean[]; error: string | null } {
  const lines = source.split("\n");
  const stripped = lines.map(() => false);
  let depth = 0;
  let error: string | null = null;
  lines.forEach((line, index) => {
    const at = index + 1;
    if (line.includes(STRIP_START)) {
      if (depth && !error) error = `nested ${STRIP_START} at line ${at}`;
      depth = 1;
      stripped[index] = true;
      return;
    }
    if (line.includes(STRIP_END)) {
      if (!depth && !error) error = `${STRIP_END} without a start at line ${at}`;
      depth = 0;
      stripped[index] = true;
      return;
    }
    stripped[index] = depth === 1;
  });
  if (!error && depth) error = `unterminated ${STRIP_START} — the file's markers do not balance`;
  return { stripped, error };
}

/**
 * The source with string, comment and regex-free content blanked out but every
 * offset and newline preserved, so brace matching cannot be fooled by a `{`
 * inside an item's text or a comment.
 */
function blankLiterals(source: string): string {
  let out = "";
  let i = 0;
  const keepNewlines = (text: string) => text.replace(/[^\n]/g, " ");
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          out += quote;
          i += 1;
          break;
        }
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += keepNewlines(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += keepNewlines(source.slice(i, stop));
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * `blankLiterals` plus the one thing the brace walk still needs to read: a
 * QUOTED property key. `{ "private": true }` is truthy at runtime and hidden
 * in-app exactly like the bare form, but blanking wipes the key's characters,
 * so the scan would sail past it. Keys are written back only where the blanked
 * buffer still shows the literal's own quotes at both ends — an escaped
 * `\"private\"` inside an item's prose stays blank, and so does prose that
 * merely says `private: true`.
 */
function blankForScan(source: string): string {
  const blanked = blankLiterals(source).split("");
  const quotedKey = /(["'])([A-Za-z_$][\w$]*)\1(?=\s*:)/g;
  let match: RegExpExecArray | null;
  while ((match = quotedKey.exec(source)) !== null) {
    const end = match.index + match[0].length - 1;
    if (blanked[match.index] !== match[1] || blanked[end] !== match[1]) continue;
    for (let i = 0; i < match[0].length; i += 1) blanked[match.index + i] = match[0][i];
  }
  return blanked.join("");
}

/** A `private: true` property, bare or quoted-key. */
const PRIVATE_TRUE = /(?:\bprivate\b|(["'])private\1)\s*:\s*true\b/;

/** Line number (1-based) for a character offset. */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

/**
 * Every `private: true` item that would survive the mirror's strip pass, in
 * whole: the check spans the item's entire object literal, not just its
 * `private` line, so a fence that covers the flag but leaves the item's `text`
 * behind is caught too (that shape strips into a syntax error, which only the
 * slow `--verify` would otherwise notice).
 */
export function privateItemProblems(source: string, label = "src/lib/changelog.ts"): string[] {
  const { stripped, error } = scanFences(source);
  if (error) return [`${label}: ${error} (share-mirror.sh would refuse this file)`];

  const blanked = blankForScan(source);
  /* blankLiterals understands strings and comments but not regex literals, so
     a `/…/` here would leave stray braces in the blanked buffer and skew every
     span. changelog.ts is pure data and has none; this pins that. */
  if (blanked.includes("/")) {
    return [
      `${label}: a \`/\` survives literal-blanking (line ${lineOf(source, blanked.indexOf("/"))}) — ` +
        `the fence scan only understands strings and comments, so a regex literal ` +
        `would skew item spans. Keep this file pure data.`,
    ];
  }
  const blankedLines = blanked.split("\n");
  const lines = source.split("\n");
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    offsets.push(cursor);
    cursor += line.length + 1;
  }

  const problems: string[] = [];
  const seen = new Set<number>();
  lines.forEach((_line, index) => {
    // match the BLANKED line: the literal phrase in an item's prose or in a
    // comment is not a private item
    const flag = PRIVATE_TRUE.exec(blankedLines[index]);
    if (!flag) return;

    // walk back to the `{` that opens this item, then forward to its match —
    // from the flag itself, not the line start, or a single-line item's own
    // `{` is skipped and the span balloons to the enclosing release object
    let depth = 0;
    let open = -1;
    for (let i = offsets[index] + flag.index - 1; i >= 0; i -= 1) {
      const ch = blanked[i];
      if (ch === "}") depth += 1;
      else if (ch === "{") {
        if (depth === 0) {
          open = i;
          break;
        }
        depth -= 1;
      }
    }
    if (open === -1) {
      problems.push(`${label}:${index + 1}: could not find the item enclosing this \`private: true\``);
      return;
    }
    let close = blanked.length - 1;
    depth = 0;
    for (let i = open + 1; i < blanked.length; i += 1) {
      const ch = blanked[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        if (depth === 0) {
          close = i;
          break;
        }
        depth -= 1;
      }
    }

    const first = lineOf(source, open);
    const last = lineOf(source, close);
    if (seen.has(first)) return;
    seen.add(first);
    const leaked: number[] = [];
    for (let at = first; at <= last; at += 1) if (!stripped[at - 1]) leaked.push(at);
    if (leaked.length === 0) return;
    problems.push(
      `${label}:${first}: a \`private: true\` item is not fully inside a share-mirror strip fence ` +
        `(line${leaked.length > 1 ? "s" : ""} ${leaked.join(", ")} would ship).\n` +
        `  changelog.ts ships in the public mirror, so wrap the item in\n` +
        `  \`// ${STRIP_START}\` / \`// ${STRIP_END}\` or drop the \`private\` flag.`
    );
  });
  return problems;
}

/* ── the gate ───────────────────────────────────────────────────────────── */

export interface CheckResult {
  ok: boolean;
  problems: string[];
}

/**
 * All three halves of `--check`: rendered-vs-on-disk, version agreement, and
 * (SUB-985) every `private: true` item sitting inside a share-mirror fence.
 */
export function checkChangelog(root = ROOT): CheckResult {
  const problems: string[] = [];

  const mismatch = versionMismatch(readVersions(root));
  if (mismatch) problems.push(mismatch);

  const changelogTs = resolve(root, "src/lib/changelog.ts");
  try {
    problems.push(...privateItemProblems(readFileSync(changelogTs, "utf8")));
  } catch {
    problems.push("src/lib/changelog.ts is missing — the private-item fence scan could not run");
  }

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
        "  --check    exit 1 if CHANGELOG.md is stale, the versions disagree, or a\n" +
        "             private item is missing its share-mirror strip fence"
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
