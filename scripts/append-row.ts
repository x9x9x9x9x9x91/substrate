#!/usr/bin/env node
/**
 * Append one database row to a Substrate vault.
 *
 * The smallest useful shape of "external tool writes a file, the watcher does
 * the rest": create ONE new note carrying `type: <type>` plus the props you
 * name, and stop. A note is a row purely by having a `type` prop
 * (docs/vault-format.md §4), so there is nothing else to register — the
 * running app picks the file up ~300ms later and the row appears in the
 * database view. See docs/integrations.md for the pattern and its limits.
 *
 * APPEND-ONLY BY CONSTRUCTION: this script only ever creates a new file. It
 * never reads-then-rewrites an existing note, so it cannot lose a keystroke
 * the user typed while it ran — the one write shape that is safe against an
 * open editor buffer without any locking (docs/vault-format.md §13.1). If the
 * name it picked already exists, it deduplicates the way the engine does
 * (`Idea.md`, `Idea 2.md`, …); the write itself is exclusive, so a racing
 * creator loses the link, never the file.
 *
 * It also never writes `.vault/schema.json`. The schema is read-only input
 * here: when it names the type, unknown props and off-list select values are
 * reported as warnings and the row is still written. (Writing schema from a
 * script is a trap — an entry with `options: []` and no `kind` is the demote
 * form and REMOVES the prop, §6.)
 *
 * Usage:
 *   VAULT_DIR=… node scripts/append-row.ts <type> --title "…" \
 *     [--prop key=value]... [--body "…"] [--dir <vault-subdir>]
 *
 * Arguments:
 *   <type>                REQUIRED. The database this row joins — the note's
 *                         `type:` prop, an exact case-sensitive string (§4).
 *
 * Options:
 *   --title <text>        REQUIRED. Display title; also the filename, sanitized
 *                         (§2). A title the engine would refuse (leading dot,
 *                         `[`/`]`) is refused here too, before any write.
 *   --prop key=value      A frontmatter prop. Repeatable. The value is written
 *                         as a YAML scalar, quoted when it needs to be. Dates
 *                         are plain `YYYY-MM-DD`, optionally ` HH:MM` (§4).
 *   --body <text>         Markdown body below the frontmatter (default: empty).
 *   --dir <path>          Vault-relative folder for the note (default: root).
 *                         Use `/` separators. Created if missing. Hidden,
 *                         escaping, and out-of-vault symlink paths refused.
 *   --dry-run             Print what would be written, write nothing.
 *
 * Environment:
 *   VAULT_DIR  Vault root — REQUIRED, there is no default: an unset
 *              target would silently write into the real ~/Vault.
 */

import { link, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { guardedSlug } from "./vault-title.ts";
import { resolveVault } from "./vault-target.ts";

// ---------- Shapes ----------

export interface Options {
  /** Database `type` for the row (required). */
  type: string;
  /** Display title / filename stem (required). */
  title: string;
  /** Extra frontmatter props, in the order given. */
  props: [string, string][];
  /** Markdown body (default: empty). */
  body: string;
  /** Vault-relative target folder (default: vault root). */
  dir?: string;
  dryRun: boolean;
}

export interface AppendReport {
  /** Vault-relative path of the note that was (or would be) created. */
  path: string;
  /** Full file content as written. */
  content: string;
  /** Schema mismatches — reported, never fatal, never repaired. */
  warnings: string[];
  dryRun: boolean;
}

/** Props the app owns on a create; a `--prop` may still override `created`. */
const RESERVED = new Set(["type", "title", "created"]);

// ---------- CLI ----------

export function parseArgs(argv: string[]): Options {
  const opts: Options = { type: "", title: "", props: [], body: "", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--title": opts.title = value(); break;
      case "--body": opts.body = value(); break;
      case "--dir": opts.dir = value().replace(/^\/+|\/+$/g, ""); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--prop": {
        const raw = value();
        const eq = raw.indexOf("=");
        if (eq <= 0) throw new Error(`--prop needs key=value, got: ${raw}`);
        opts.props.push([raw.slice(0, eq).trim(), raw.slice(eq + 1)]);
        break;
      }
      case "--help":
      case "-h":
        console.log("See header comment of scripts/append-row.ts");
        process.exit(0);
      // eslint-disable-next-line no-fallthrough -- the case above ends in process.exit()
      default:
        if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
        if (opts.type) throw new Error(`unexpected extra argument: ${arg}`);
        opts.type = arg;
    }
  }
  if (!opts.type) throw new Error("missing required <type> argument — a row without a type is not a row (§4)");
  if (!opts.title) throw new Error("missing required --title");
  return opts;
}

// ---------- Frontmatter ----------

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` local — the app's own `created:` form (§2). */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Minimal YAML scalar; the quoted form stays valid for the engine's
    serde_yaml parse. Same rules as scripts/import-ableton.ts. */
export function yamlScalar(v: string): string {
  if (v === "") return '""';
  if (/^(true|false|null|yes|no|on|off)$/i.test(v) || /^-?[\d.]+$/.test(v)) {
    return JSON.stringify(v);
  }
  if (/^[A-Za-z0-9][A-Za-z0-9 .,_&()+/'-]*$/.test(v) && !v.endsWith(":")) return v;
  return JSON.stringify(v);
}

/** Frontmatter must parse to a FLAT mapping (§2), and every prop the app can
    write back is a one-line scalar. A newline inside a value would either
    break the block or need a folded form the engine's write lane can't
    reproduce — refuse it rather than write something the app can't edit. */
function checkPropValue(key: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`prop "${key}" contains a newline — frontmatter values are single-line scalars (use --body for prose)`);
  }
  if (!key || /[:\r\n]/.test(key)) throw new Error(`invalid prop name: ${JSON.stringify(key)}`);
}

// ---------- Schema (READ-ONLY: warnings only, never written) ----------

interface PropSchema { options?: { value: string }[]; kind?: string }
type Schema = Record<string, Record<string, PropSchema | unknown>>;

async function readSchema(vault: string): Promise<Schema | null> {
  try {
    return JSON.parse(await readFile(join(vault, ".vault", "schema.json"), "utf8")) as Schema;
  } catch {
    // absent or corrupt reads as "no schema" — exactly what the app does (§6)
    return null;
  }
}

/** Compare the row against a registered type. Off-schema is legal on disk —
    unknown props are preserved and shown as chips (§2) — so every mismatch is
    a warning, never a refusal. */
function schemaWarnings(schema: Schema | null, type: string, props: [string, string][]): string[] {
  const entry = schema?.[type];
  if (!entry || typeof entry !== "object") return [];
  const warnings: string[] = [];
  for (const [key, value] of props) {
    if (RESERVED.has(key)) continue;
    const ps = (entry as Record<string, PropSchema>)[key];
    if (key === "icon" || key === "home" || ps === undefined || typeof ps !== "object") {
      warnings.push(`prop "${key}" is not in the schema for type "${type}" — it will show as a plain chip`);
      continue;
    }
    const options = Array.isArray(ps.options) ? ps.options : [];
    // only select/multi props carry a value list; the other kinds keep `options: []`
    if (options.length > 0 && value !== "" && !options.some((o) => o?.value === value)) {
      warnings.push(
        `prop "${key}" value ${JSON.stringify(value)} is not one of the schema options ` +
          `(${options.map((o) => o.value).join(", ")}) — it is written as-is and shows without a dot`,
      );
    }
  }
  return warnings;
}

// ---------- Target ----------

/** Vault-relative folder, mirroring the engine's create guards: no escaping,
    no absolute paths, nothing under a `.` component (which would be invisible
    to the index and the watcher, §13 rule 8). */
function checkDir(dir: string): void {
  // `/` is the CLI's one portable separator. Treating `\` as a literal on
  // POSIX but a separator on Windows made `..\outside` pass on macOS and
  // escape when the same script ran on Windows.
  if (dir.includes("\\")) {
    throw new Error(`--dir must use / separators, not \\: ${dir}`);
  }
  if (isAbsolute(dir) || win32.isAbsolute(dir) || /^[A-Za-z]:/.test(dir)) {
    throw new Error(`--dir must be vault-relative: ${dir}`);
  }
  for (const part of dir.split("/")) {
    if (part === "..") throw new Error(`--dir may not escape the vault: ${dir}`);
    if (part.startsWith(".")) throw new Error(`--dir may not point into a hidden folder: ${dir}`);
  }
}

interface CanonicalCandidate {
  path: string;
  exists: boolean;
}

/** Resolve every existing path component, carrying only the missing suffix.
    This catches a symlink in any existing ancestor before mkdir can follow it. */
async function canonicalCandidate(path: string): Promise<CanonicalCandidate> {
  let cursor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      const base = await realpath(cursor);
      return {
        path: missing.reduceRight((current, part) => join(current, part), base),
        exists: missing.length === 0,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function prepareVault(vaultEnv: string | undefined, dryRun: boolean): Promise<string> {
  const candidate = await canonicalCandidate(resolveVault(vaultEnv));
  if (!dryRun) await mkdir(candidate.path, { recursive: true });
  const vault = candidate.exists || !dryRun ? await realpath(candidate.path) : candidate.path;
  if (candidate.exists || !dryRun) {
    const metadata = await stat(vault);
    if (!metadata.isDirectory()) throw new Error(`VAULT_DIR is not a directory: ${vault}`);
  }
  return vault;
}

/** Resolve the requested directory through its nearest existing ancestor and
    prove it stays beneath the canonical vault before creating anything. */
async function prepareTargetDir(
  vault: string,
  dir: string | undefined,
  dryRun: boolean,
): Promise<string> {
  const requested = dir ? join(vault, dir) : vault;
  const candidate = await canonicalCandidate(requested);
  if (!inside(vault, candidate.path)) {
    throw new Error(`--dir escapes the vault through an existing symlink: ${dir ?? ""}`);
  }
  if (dryRun) return candidate.path;
  await mkdir(candidate.path, { recursive: true });
  const canonical = await realpath(candidate.path);
  if (!inside(vault, canonical)) {
    throw new Error(`--dir escapes the vault through an existing symlink: ${dir ?? ""}`);
  }
  return canonical;
}

/**
 * Create `path` with `content`, failing if it already exists.
 *
 * Not `writeAtomic` from vault-target.ts: rename(2) replaces the target
 * silently, and an append-row that clobbers an existing note is the one thing
 * this script must never do. `link(2)` is the exclusive-and-atomic pair —
 * the content is complete in the temp file before the name appears, and the
 * link fails EEXIST if some other writer got there first. The dotted temp
 * name keeps it invisible to the indexer and the watcher while it exists (§13).
 */
let tmpSeq = 0;

async function createExclusive(path: string, content: string): Promise<void> {
  // unique per attempt (vault-target.ts keeps the same counter): concurrent
  // runs in one process never share a temp, and a crashed run's leftover can
  // only collide across a pid reuse — which fails hard below, never misfiles
  const tmp = join(resolve(path, ".."), `.${process.pid}-${tmpSeq++}-append-row.tmp`);
  try {
    try {
      await writeFile(tmp, content, { flag: "wx" });
    } catch (e) {
      // EEXIST here is a stale temp in the way, NOT "the target name is
      // taken" — only a failed link() below may bump the dedupe counter
      throw new Error(`temp file in the way: ${tmp} — remove it and re-run (${(e as Error).message})`);
    }
    await link(tmp, path);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// ---------- Append ----------

export async function run(opts: Options, vaultEnv?: string): Promise<AppendReport> {
  const slug = guardedSlug(opts.title);
  for (const [key, value] of opts.props) checkPropValue(key, value);
  if (opts.dir) checkDir(opts.dir);
  const vault = await prepareVault(vaultEnv, opts.dryRun);
  const dirAbs = await prepareTargetDir(vault, opts.dir, opts.dryRun);

  // engine create order: `created`, then the rest, alphabetically. Prop edits
  // re-serialize sorted anyway (§2), so sorted is the shape the app converges
  // on — writing it sorted keeps the first prop edit from reshuffling the file.
  const given = new Map(opts.props);
  // `type` and `title` come from the arguments, never from --prop: two sources
  // for one value is how a row silently joins the wrong database
  if (given.has("type")) throw new Error("--prop type= is not allowed — pass it as the <type> argument");
  if (given.has("title")) throw new Error("--prop title= is not allowed — pass it as --title");

  const records = new Map<string, string>();
  // `created` is the app's, but a backfill legitimately knows the real date
  records.set("created", given.get("created") ?? isoDay(new Date()));
  records.set("type", opts.type);
  // `title:` only when sanitizing was lossy — a lossless slug carries the
  // title in the filename and the app removes a redundant prop anyway (§2)
  if (slug !== opts.title) records.set("title", opts.title);
  for (const [key, value] of given) if (!RESERVED.has(key)) records.set(key, value);

  const yaml = [...records.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}: ${yamlScalar(v)}`)
    .join("\n");
  const body = opts.body === "" ? "" : opts.body.endsWith("\n") ? opts.body : `${opts.body}\n`;
  const content = `---\n${yaml}\n---\n${body}`;

  const warnings = schemaWarnings(await readSchema(vault), opts.type, [...records.entries()]);

  // creates dedupe: Idea.md, Idea 2.md, Idea 3.md… (§2). The exclusive create
  // is what actually decides — the loop only finds the first free candidate,
  // and retries when a concurrent writer took it between the two.
  for (let n = 1; n <= 10000; n++) {
    const stem = n === 1 ? slug : `${slug} ${n}`;
    const rel = opts.dir ? `${opts.dir}/${stem}.md` : `${stem}.md`;
    if (opts.dryRun) {
      // a dry run must not touch the disk, so it reports the first candidate
      // without probing for collisions
      return { path: rel, content, warnings, dryRun: true };
    }
    try {
      await createExclusive(join(dirAbs, `${stem}.md`), content);
      return { path: rel, content, warnings, dryRun: false };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error(`gave up finding a free name for "${slug}" after 10000 tries`);
}

// ---------- Main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = await run(opts);
  for (const w of report.warnings) console.log(`  ! ${w}`);
  console.log(`${report.dryRun ? "[dry-run] " : ""}${report.path}`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`append-row failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
