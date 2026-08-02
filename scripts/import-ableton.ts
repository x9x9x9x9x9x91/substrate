#!/usr/bin/env node
/**
 * Ableton project pool → Substrate vault importer (SUB-37).
 *
 * Turns a folder of Ableton projects ("the album pool") into a folder-backed
 * database: each immediate subfolder containing a `.als` file becomes one row
 * (a stub note) in the vault, following the SUB-13 folder-sync conventions —
 * `type`/`file`/`modified`/`size` props, dedupe by the `file` prop's path, a
 * `missing` flag for vanished projects — so these rows interoperate with the
 * engine's own folder sync instead of fighting it.
 *
 * READ-ONLY GUARANTEE: the pool is real music work. This script only ever
 * `readdir`s and `stat`s the source tree — it never writes, moves, renames,
 * or deletes anything there, and it NEVER parses `.als` contents (the app
 * doesn't either). Musical metadata (tempo, track/device counts, length,
 * last-touched) comes from an optional als_introspect sidecar JSON; without
 * it those props stay empty and `last_touched` falls back to the `.als`
 * file's mtime. Rows, props, and note bodies live vault-side only.
 *
 * Re-running is the rescan: machine-owned props (`file`, `modified`, `size`,
 * `last_touched`, `missing`, and the musical props when a sidecar is given)
 * refresh in place; everything else on the note — `status`, `vibe`,
 * `next_action`, any other props, and the body — is the user's and is never
 * touched. A project whose folder or `.als` vanished keeps its row, flagged
 * `missing: true` (never deleted); it recovers when the folder comes back.
 *
 * Project folder names become note titles, so they run through the same
 * guards as the engine (SUB-223, mirrored in scripts/vault-title.ts): a name
 * with a leading dot or `[`/`]` is rejected, reported, and never written —
 * the script writes files directly, so the engine's own create-time
 * validation never sees them (SUB-279).
 *
 * If a bounce/preview render sits next to the `.als` (audio file in the
 * project folder), the row's note embeds it by path — `![[~/…]]` (SUB-15,
 * linked in place, never copied) — so you can listen while triaging. On
 * re-import an existing embed pointing into the project folder is left
 * alone; a new one is appended only when none exists yet.
 *
 * Usage:
 *   node scripts/import-ableton.ts <projects-folder> [options]
 *
 * Arguments:
 *   <projects-folder>     REQUIRED. The pool to scan (each immediate
 *                         subfolder with a `.als` = one row). There is no
 *                         default — the machine is never scanned unprompted.
 *
 * Options:
 *   --folder <path>       Vault-relative target folder for the rows
 *                         (default: the pool folder's own name)
 *   --type <value>        Frontmatter `type` / database name
 *                         (default: "ableton-project")
 *   --introspect <json>   als_introspect sidecar: { "<folder name>": {
 *                           tempo, tracks, devices, lengthSeconds,
 *                           lastTouched } } — every field optional
 *   --dry-run             Print what would change, write nothing
 *
 * Environment:
 *   VAULT_DIR  Vault root — REQUIRED, there is no default (SUB-777): an unset
 *              target would silently write into the real ~/Vault. Point at a
 *              scratch dir to test.
 *
 * Also seeds, only when absent (never overwrites): `.vault/schema.json`
 * entries for `status` (sketch/promising/album? options), `file` (kind:
 * file) and `last_touched` (kind: date), and a `.vault/views.json` default
 * of board-by-status for the type. Table/board/filtering are the stock
 * DatabasePane — no app changes are needed.
 */

import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { guardedSlug, sanitizeFilename } from "./vault-title.ts";
import { resolveVault, writeAtomic } from "./vault-target.ts";

// ---------- Shapes ----------

/** als_introspect sidecar entry — every field optional. */
export interface IntrospectEntry {
  tempo?: number;
  tracks?: number;
  devices?: number;
  lengthSeconds?: number;
  lastTouched?: string;
}

export interface Options {
  /** Absolute or relative path to the Ableton projects pool (required). */
  pool: string;
  /** Vault-relative target folder for rows (default: pool folder's name). */
  folder?: string;
  /** Database `type` for the rows. */
  type: string;
  /** Path to an als_introspect sidecar JSON. */
  introspect?: string;
  dryRun: boolean;
}

export interface ImportReport {
  /** Vault-relative note paths, per outcome. */
  created: string[];
  updated: string[];
  unchanged: string[];
  missing: string[];
  /** Pool subfolders without a `.als` — not projects. */
  skipped: string[];
  /** Projects whose name the engine's title guards refuse (SUB-223) — never written. */
  rejected: { name: string; reason: string }[];
  dryRun: boolean;
}

interface Project {
  /** Project folder name = row title. */
  name: string;
  /** Canonical absolute path of the project folder. */
  folderAbs: string;
  /** Canonical absolute path of the picked `.als`. */
  alsAbs: string;
  alsMtime: Date;
  alsSize: number;
  /** Canonical absolute path of the picked bounce render, if any. */
  bounceAbs?: string;
}

/** One parsed frontmatter prop; `lines` are the raw source lines (key line
    plus any continuation lines), kept verbatim so user props round-trip
    byte-for-byte. */
interface FmRecord {
  key: string;
  lines: string[];
}

// ---------- Constants ----------

/** Audio extensions the vault renders as an inline player (vault-format §3). */
const AUDIO_EXTS = new Set([".wav", ".aif", ".aiff", ".mp3", ".flac", ".m4a"]);

const DEFAULT_TYPE = "ableton-project";

/** Triage props — seeded empty on create, never touched afterwards. */
const USER_PROPS = ["status", "vibe", "next_action"];

const STATUS_OPTIONS = ["sketch", "promising", "album?"];

/** Musical props fed by the als_introspect sidecar. */
const MUSICAL_PROPS = ["tempo", "tracks", "devices", "length_seconds"] as const;

/** Props refreshed on every import (musical props join only with a sidecar).
    `type`, `title`, and `created` are written once at create and then left
    alone — a rename or a type change is the user's call. */
const REFRESH_PROPS = new Set(["file", "modified", "size", "last_touched", "missing"]);

// ---------- CLI ----------

function parseArgs(argv: string[]): Options {
  const opts: Options = { pool: "", type: DEFAULT_TYPE, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--folder": opts.folder = value().replace(/^\/+|\/+$/g, ""); break;
      case "--type": opts.type = value(); break;
      case "--introspect": opts.introspect = value(); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--help":
      case "-h":
        console.log("See header comment of scripts/import-ableton.ts");
        process.exit(0);
      // eslint-disable-next-line no-fallthrough -- the case above ends in process.exit()
      default:
        if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
        if (opts.pool) throw new Error(`unexpected extra argument: ${arg}`);
        opts.pool = arg;
    }
  }
  if (!opts.pool) {
    throw new Error(
      "missing required <projects-folder> argument — the pool path is always explicit, never scanned by default",
    );
  }
  return opts;
}

// ---------- Path helpers (mirror src-tauri/src/vault.rs) ----------

/** `~/…` → absolute, using HOME like the engine's expand_tilde. */
function expandTilde(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith("~/")) return join(home, p.slice(2));
  if (home && p === "~") return home;
  return p;
}

/** Absolute path → `~/…` when under HOME — the preferred stored form. */
function contractTilde(abs: string): string {
  const home = process.env.HOME;
  if (home && (abs === home || abs.startsWith(home + sep))) {
    return abs === home ? "~" : `~${abs.slice(home.length)}`;
  }
  return abs;
}

/** Canonical form for dedupe: realpath what exists; for a vanished path,
    realpath its parent (mirrors normalize_file_path in vault.rs). */
async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    try {
      return join(await realpath(dirname(p)), basename(p));
    } catch {
      return resolve(p);
    }
  }
}

// ---------- Date stamps (engine's file_stamp uses local time) ----------

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD HH:MM` local — identical to vault.rs `file_stamp`. */
function stampMinute(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `YYYY-MM-DD` local — date-kind prop value. */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------- Pool scan (READ-ONLY: readdir + stat only) ----------

async function scanPool(poolAbs: string): Promise<{ projects: Project[]; skipped: string[] }> {
  const projects: Project[] = [];
  const skipped: string[] = [];
  for (const entry of await readdir(poolAbs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(poolAbs, entry.name);
    const children = await readdir(dir, { withFileTypes: true });
    const files = children.filter((c) => c.isFile() && !c.name.startsWith("."));
    const als = files.filter((c) => c.name.toLowerCase().endsWith(".als"));
    if (als.length === 0) {
      skipped.push(entry.name);
      continue;
    }
    const withStats = async (name: string) => {
      const s = await stat(join(dir, name));
      return { name, mtime: s.mtime, size: s.size };
    };
    const alsStats = await Promise.all(als.map((c) => withStats(c.name)));
    // several .als in one folder: prefer the one named after the folder,
    // else the most recently touched
    const stem = (n: string) => n.slice(0, -extname(n).length);
    const named = alsStats.find((f) => stem(f.name).toLowerCase() === entry.name.toLowerCase());
    const picked = named ?? alsStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime() || a.name.localeCompare(b.name))[0];
    // bounce/preview render: audio file next to the .als, newest first
    const bounces = await Promise.all(
      files.filter((c) => AUDIO_EXTS.has(extname(c.name).toLowerCase())).map((c) => withStats(c.name)),
    );
    bounces.sort((a, b) => b.mtime.getTime() - a.mtime.getTime() || a.name.localeCompare(b.name));
    projects.push({
      name: entry.name,
      folderAbs: await canonical(dir),
      alsAbs: await canonical(join(dir, picked.name)),
      alsMtime: picked.mtime,
      alsSize: picked.size,
      bounceAbs: bounces[0] ? await canonical(join(dir, bounces[0].name)) : undefined,
    });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return { projects, skipped };
}

// ---------- Note parsing (line-based; user content stays verbatim) ----------

/** Split a note into frontmatter records + body. No frontmatter (or an
    unterminated block) reads as zero records with the whole file as body —
    the same rule as vault.rs `split_frontmatter`. */
function parseNote(raw: string): { records: FmRecord[]; body: string } {
  const open = raw.match(/^---\r?\n/);
  if (!open) return { records: [], body: raw };
  const closeRe = /^---[ \t]*\r?$/gm;
  closeRe.lastIndex = open[0].length;
  const close = closeRe.exec(raw);
  if (!close) return { records: [], body: raw };
  const records: FmRecord[] = [];
  const fmLines = raw.slice(open[0].length, close.index).split(/\r?\n/);
  // the newline that terminates the last prop line shows up as trailing empty
  // entries — they carry no prop data and must not round-trip into the output
  while (fmLines.length > 0 && fmLines[fmLines.length - 1].trim() === "") fmLines.pop();
  for (const line of fmLines) {
    const km = line.match(/^(\S[^:]*):/);
    if (km) records.push({ key: km[1].trim(), lines: [line] });
    else if (records.length > 0) records[records.length - 1].lines.push(line);
  }
  let bodyStart = close.index + close[0].length;
  if (raw[bodyStart] === "\n") bodyStart++;
  return { records, body: raw.slice(bodyStart) };
}

/** Scalar value of a one-line `key: value` record, quotes stripped. */
function scalarValue(record: FmRecord): string {
  const line = record.lines[0];
  const v = line.slice(line.indexOf(":") + 1).trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** Minimal YAML scalar; quoted form stays valid for the engine's serde_yaml
    parse. Same rules as scripts/import-notion.ts. */
function yamlScalar(v: string | number): string {
  if (typeof v === "number") return String(v);
  if (v === "") return '""';
  if (/^(true|false|null|yes|no|on|off)$/i.test(v) || /^-?[\d.]+$/.test(v)) {
    return JSON.stringify(v);
  }
  if (/^[A-Za-z0-9][A-Za-z0-9 .,_&()+/'-]*$/.test(v) && !v.endsWith(":")) return v;
  return JSON.stringify(v);
}

const propLine = (key: string, value: string | number): FmRecord => ({
  key,
  lines: [`${key}: ${yamlScalar(value)}`],
});

function renderNote(records: FmRecord[], body: string): string {
  const yaml = records.map((r) => r.lines.join("\n")).join("\n");
  return `---\n${yaml}\n---\n${body}`;
}

// ---------- Vault scan: find rows this importer manages ----------

/** All vault-relative note paths; dot-prefixed components are invisible
    (vault-format §1). */
async function walkVaultNotes(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkVaultNotes(root, childRel)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(childRel);
  }
  return out;
}

/** Managed rows: notes of our `type` whose `file` prop points into the pool.
    Keyed by the canonical parent folder of that file (= the project folder),
    so a renamed `.als` still matches its row. */
async function managedRows(
  vault: string,
  dbType: string,
  poolAbs: string,
): Promise<Map<string, string>> {
  const managed = new Map<string, string>();
  for (const rel of await walkVaultNotes(vault)) {
    const raw = await readFile(join(vault, rel), "utf8");
    const { records } = parseNote(raw);
    const get = (k: string) => records.find((r) => r.key === k);
    if (get("type") === undefined || scalarValue(get("type")!) !== dbType) continue;
    const fileRec = get("file");
    if (!fileRec) continue;
    const fileAbs = expandTilde(scalarValue(fileRec));
    const parent = await canonical(dirname(fileAbs));
    if (parent === poolAbs || parent.startsWith(poolAbs + sep)) managed.set(parent, rel);
  }
  return managed;
}

// ---------- Body: bounce embed ----------

/** True when the body already embeds something inside the project folder. */
function hasProjectEmbed(body: string, folderAbs: string): boolean {
  for (const m of body.matchAll(/!\[\[([^[\]]+)\]\]/g)) {
    const target = resolve(expandTilde(m[1].trim()));
    if (target === folderAbs || target.startsWith(folderAbs + sep)) return true;
  }
  return false;
}

function appendEmbed(body: string, bounceAbs: string): string {
  const embed = `![[${contractTilde(bounceAbs)}]]`;
  const trimmed = body.trimEnd();
  return trimmed ? `${trimmed}\n\n${embed}\n` : `\n${embed}\n`;
}

// ---------- Schema / views seeding (only ever additive) ----------

/* eslint-disable @typescript-eslint/no-explicit-any */
async function seedJsonFile(
  path: string,
  seed: (data: any) => boolean,
  dryRun: boolean,
): Promise<void> {
  let data: any = {};
  let raw: string | undefined;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    // only a genuinely absent file may be seeded fresh — an EXISTING file we
    // cannot read (EACCES, EIO…) would be rewritten from scratch below,
    // destroying recoverable metadata behind a fail-closed façade
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (raw !== undefined) {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      // seeding rewrites the whole file, so treating an unreadable one as
      // empty would destroy recoverable metadata — stop and let the user move it
      throw new Error(
        `${path} exists but is not valid JSON (${e instanceof Error ? e.message : e}) — ` +
          "move or repair it before importing",
      );
    }
  }
  if (!seed(data) || dryRun) return;
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, JSON.stringify(data, null, 2) + "\n");
}

async function seedSchemaAndViews(vault: string, dbType: string, dryRun: boolean): Promise<void> {
  await seedJsonFile(
    join(vault, ".vault", "schema.json"),
    (schema) => {
      let changed = false;
      const t = (schema[dbType] ??= {});
      if (!t.status) {
        t.status = { options: STATUS_OPTIONS.map((value) => ({ value })) };
        changed = true;
      }
      if (!t.file) {
        t.file = { options: [], kind: "file" };
        changed = true;
      }
      if (!t.last_touched) {
        t.last_touched = { options: [], kind: "date" };
        changed = true;
      }
      return changed;
    },
    dryRun,
  );
  await seedJsonFile(
    join(vault, ".vault", "views.json"),
    (views) => {
      if (views[dbType]) return false;
      views[dbType] = { view: "board", group_by: "status" };
      return true;
    },
    dryRun,
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------- Import ----------

export async function run(opts: Options, vaultEnv?: string): Promise<ImportReport> {
  const vault = resolveVault(vaultEnv);
  const poolAbs = await canonical(resolve(expandTilde(opts.pool)));
  const poolStat = await stat(poolAbs).catch(() => null);
  if (!poolStat?.isDirectory()) throw new Error(`not a folder: ${opts.pool}`);
  const vaultAbs = await canonical(vault);
  if (poolAbs === vaultAbs || poolAbs.startsWith(vaultAbs + sep) || vaultAbs.startsWith(poolAbs + sep)) {
    throw new Error("projects folder overlaps the vault — refusing to import");
  }
  const dbType = opts.type;
  const vaultFolder = opts.folder ?? sanitizeFilename(basename(poolAbs));

  const introspect: Record<string, IntrospectEntry> = opts.introspect
    ? (JSON.parse(await readFile(opts.introspect, "utf8")) as Record<string, IntrospectEntry>)
    : {};

  const { projects, skipped } = await scanPool(poolAbs);
  const managed = await managedRows(vault, dbType, poolAbs);
  const targetAbs = join(vault, ...vaultFolder.split("/"));

  // names already taken in the target folder (case-insensitive, like the engine)
  const usedNames = new Set(
    (await readdir(targetAbs).catch(() => [] as string[]))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.toLowerCase()),
  );

  const report: ImportReport = {
    created: [],
    updated: [],
    unchanged: [],
    missing: [],
    skipped,
    rejected: [],
    dryRun: opts.dryRun,
  };
  const seen = new Set<string>();

  for (const project of projects) {
    seen.add(project.folderAbs);
    const entry = introspect[project.name];

    // machine-owned props for this pass
    const stamps: [string, string | number][] = [
      ["file", contractTilde(project.alsAbs)],
      ["modified", stampMinute(project.alsMtime)],
      ["size", String(project.alsSize)],
      ["last_touched", entry?.lastTouched ? entry.lastTouched.slice(0, 10) : isoDay(project.alsMtime)],
    ];
    const musical: [string, string | number][] = MUSICAL_PROPS.map((key) => {
      const sidecarKey = key === "length_seconds" ? "lengthSeconds" : (key as "tempo" | "tracks" | "devices");
      const v = entry?.[sidecarKey];
      return [key, typeof v === "number" ? v : ""];
    });

    const existingRel = managed.get(project.folderAbs);
    if (existingRel === undefined) {
      // new row — stub note shaped like an engine folder-sync stub.
      // SUB-223 guards, mirrored for direct-to-disk rows (SUB-279): a project
      // name the engine would refuse is reported, never written as an
      // invisible (dot-stem) or link-toxic (brackets) note
      let slug: string;
      try {
        slug = guardedSlug(project.name);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        report.rejected.push({ name: project.name, reason });
        continue;
      }
      let name = slug;
      for (let n = 2; usedNames.has(`${name.toLowerCase()}.md`); n++) name = `${slug} ${n}`;
      usedNames.add(`${name.toLowerCase()}.md`);
      const records: FmRecord[] = [
        propLine("created", isoDay(new Date())),
        ...stamps.map(([k, v]) => propLine(k, v)),
        ...musical.map(([k, v]) => propLine(k, v)),
        ...USER_PROPS.map((k) => propLine(k, "")),
        propLine("type", dbType),
      ];
      if (slug !== project.name) records.push(propLine("title", project.name));
      records.sort((a, b) => a.key.localeCompare(b.key));
      const body = project.bounceAbs ? appendEmbed("", project.bounceAbs) : "";
      const rel = `${vaultFolder}/${name}.md`;
      if (!opts.dryRun) {
        await mkdir(targetAbs, { recursive: true });
        await writeAtomic(join(vault, rel), renderNote(records, body));
      }
      report.created.push(rel);
      continue;
    }

    // existing row — refresh machine props, preserve everything else verbatim.
    // A sidecar entry refreshes only the musical props it actually provides;
    // the rest keep their existing (possibly empty) values.
    const noteAbs = join(vault, existingRel);
    const raw = await readFile(noteAbs, "utf8");
    const { records, body: oldBody } = parseNote(raw);
    const provided = entry ? musical.filter(([, v]) => v !== "") : [];
    const refreshKeys = new Set([...REFRESH_PROPS, ...provided.map(([k]) => k)]);
    const kept = records.filter((r) => !refreshKeys.has(r.key));
    const merged = [...kept, ...stamps.map(([k, v]) => propLine(k, v))];
    merged.push(...provided.map(([k, v]) => propLine(k, v)));
    merged.sort((a, b) => a.key.localeCompare(b.key));
    let body = oldBody;
    if (project.bounceAbs && !hasProjectEmbed(body, project.folderAbs)) {
      body = appendEmbed(body, project.bounceAbs);
    }
    const next = renderNote(merged, body);
    if (next === raw) {
      report.unchanged.push(existingRel);
    } else {
      if (!opts.dryRun) await writeAtomic(noteAbs, next);
      report.updated.push(existingRel);
    }
  }

  // vanished projects: flag, never delete
  for (const [folderAbs, rel] of managed) {
    if (seen.has(folderAbs)) continue;
    const noteAbs = join(vault, rel);
    const raw = await readFile(noteAbs, "utf8");
    const { records, body } = parseNote(raw);
    if (records.some((r) => r.key === "missing" && scalarValue(r) === "true")) {
      report.missing.push(rel);
      continue;
    }
    // keep `file` and the old stamps so the row can recover when the
    // project comes back — only the flag itself is rewritten
    const kept = records.filter((r) => r.key !== "missing");
    const merged = [...kept, propLine("missing", "true")];
    merged.sort((a, b) => a.key.localeCompare(b.key));
    if (!opts.dryRun) await writeAtomic(noteAbs, renderNote(merged, body));
    report.missing.push(rel);
  }

  await seedSchemaAndViews(vault, dbType, opts.dryRun);
  return report;
}

// ---------- Main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = await run(opts);
  const tag = opts.dryRun ? "[dry-run] " : "";
  console.log(
    `${tag}pool "${opts.pool}" → ${report.created.length + report.updated.length + report.unchanged.length} project(s) → ${opts.folder ?? sanitizeFilename(basename(resolve(expandTilde(opts.pool))))}/ (type: ${opts.type})`,
  );
  for (const rel of report.created) console.log(`  created ${rel}`);
  for (const rel of report.updated) console.log(`  updated ${rel}`);
  for (const rel of report.missing) console.log(`  missing ${rel} (folder or .als gone — row kept)`);
  for (const r of report.rejected) console.log(`  ! rejected "${r.name}": ${r.reason}`);
  if (report.skipped.length) console.log(`skipped (no .als): ${report.skipped.join(", ")}`);
  console.log(
    `${tag}${report.created.length} created, ${report.updated.length} updated, ` +
      `${report.unchanged.length} unchanged, ${report.missing.length} missing` +
      (report.rejected.length > 0 ? `, ${report.rejected.length} rejected by the title guard` : ""),
  );
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`import failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
