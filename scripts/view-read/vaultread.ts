/** A vault on disk, read into the shapes the view evaluator takes.
 *
 *  The app gets its notes from the Rust indexer over IPC; a headless reader
 *  has neither. So this walks the folder the way the indexer walks it —
 *  hidden paths skipped, sealed files kept as name-only rows, frontmatter
 *  split at byte 0 — and projects each file into the same `NoteMeta` the
 *  pane is handed. Nothing here decides what a view SHOWS: that is the
 *  evaluator's job, and it is the whole point that this module cannot
 *  influence it.
 *
 *  The one place a headless read can honestly differ from the app is
 *  frontmatter typing: the engine parses YAML with serde_yaml, and matching
 *  a full YAML implementation with no dependencies is not a promise worth
 *  making. So the parser here covers the flat-mapping subset real notes use
 *  — scalars, block lists, flow lists — and reports what it did not read.
 *  Two different reports, because they mean different things:
 *
 *  - A line OUTSIDE the subset but inside YAML — a nested mapping, say —
 *    leaves the note in the payload with the props that did parse, and every
 *    such line is named in a warning. The app has those props; this reader
 *    does not, and says which note to distrust.
 *  - A block strict YAML would REJECT — an unquoted colon in a value, a
 *    leading `@`, an alias or anchor, a tab indent, an undecodable escape —
 *    means the app's parser fails the whole block and the note reaches no
 *    database at all. So this reader SKIPS the note too, with a warning
 *    naming the shape. Printing it would be inventing a row the app does
 *    not have, silently.
 *
 *  What that buys is narrower than "no warnings means the same props", and
 *  the narrower claim is the true one: **a note that is warned about is not
 *  in the payload or is only partly read; a note that is not warned about
 *  was read with this subset's typing rules**, which follow YAML 1.2's core
 *  schema for scalars but are not a YAML implementation. Sort collation and
 *  cell display then come from the shared evaluator either way.
 *
 *  Dependency-free by design: `node scripts/view-read/view-read.ts` must run
 *  in a checkout with no install and no app.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { NoteMeta, PropSchema, SavedView, ViewPref } from "../../src/lib/types.ts";

/** What a whole-file-encrypted note starts with — the app's own marker
    (`src-tauri/src/vault/sealed.rs`). Such a file has no readable props and
    no body, and is projected name-only, exactly as the index projects it. */
const SEALED_MAGIC = "SUBSTRATE-SEALED-1\n";

export interface VaultWarning {
  path: string;
  reason: string;
}

export interface VaultRead {
  notes: NoteMeta[];
  /** `.vault/schema.json`, the per-type property schemas */
  schema: Record<string, Record<string, PropSchema>>;
  /** the `$views` array of `.vault/views.json` */
  views: SavedView[];
  /** per-database layout preferences from `.vault/views.json` */
  prefs: Record<string, ViewPref>;
  /** the frontmatter of the vault's `Settings.md`, empty when it has none */
  settings: Record<string, unknown>;
  warnings: VaultWarning[];
}

/** Frontmatter split, byte 0 or not at all — the engine's `split_frontmatter`
    rule, including the BOM strip a Windows editor makes necessary. */
export function splitFrontmatter(raw: string): { fm: string; body: string } {
  const text = raw.startsWith("﻿") ? raw.slice(1) : raw;
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!m) return { fm: "", body: text };
  return { fm: m[1], body: m[2] ?? "" };
}

/** A key whose value is YAML's null — `key:`, `~`, `null`. The engine reads
    it as a null and the app's prop lookup then reports the prop ABSENT, not
    present-and-empty; the difference decides an empty-check and where the
    row sorts, so this reader drops the key rather than storing `""`. */
const ABSENT = Symbol("absent");

/** YAML 1.2 core-schema scalars, which is what serde_yaml resolves: decimal,
    hex and octal integers, floats with an optional exponent, the infinities
    and the not-a-number. `1_000` is deliberately absent — the underscore
    grouping is YAML 1.1, and a 1.2 parser reads it as the string it is. */
const INT_RE = /^[-+]?[0-9]+$/;
const HEX_RE = /^[-+]?0x[0-9a-fA-F]+$/;
const OCT_RE = /^[-+]?0o[0-7]+$/;
const FLOAT_RE = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;

/** The escapes a double-quoted YAML scalar may carry. Anything else after a
    backslash is an error in YAML, and is reported rather than passed
    through as itself. */
function unescapeDouble(body: string): string | null {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      out += body[i];
      continue;
    }
    const c = body[++i];
    if (c === undefined) return null;
    const simple: Record<string, string> = {
      "0": "\0",
      a: "\x07",
      b: "\b",
      t: "\t",
      "\t": "\t",
      n: "\n",
      v: "\v",
      f: "\f",
      r: "\r",
      e: "\x1b",
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      N: "\x85",
      _: "\xa0",
    };
    if (c in simple) {
      out += simple[c];
      continue;
    }
    const width = c === "x" ? 2 : c === "u" ? 4 : c === "U" ? 8 : 0;
    if (width === 0) return null;
    const digits = body.slice(i + 1, i + 1 + width);
    if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(digits)) return null;
    out += String.fromCodePoint(Number.parseInt(digits, 16));
    i += width;
  }
  return out;
}

/** A scalar, or `ABSENT` for YAML's null, or `null` when the text is a shape
    a strict parser rejects and this one must not guess at. */
function scalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "" || v === "~" || v === "null" || v === "Null" || v === "NULL") return ABSENT;
  const double = /^"([\s\S]*)"$/.exec(v);
  if (double) return unescapeDouble(double[1]);
  const single = /^'([\s\S]*)'$/.exec(v);
  if (single) return single[1].replace(/''/g, "'");
  // an unquoted scalar ends at an inline comment, as YAML reads it
  const bare = v.replace(/\s+#.*$/, "").trim();
  // the shapes a plain scalar may NOT start with, and the one it may not
  // contain: `@` and a backtick are reserved indicators, an alias in a flat
  // block names an anchor nothing defined, and an unquoted colon ends the
  // key. Each is a syntax error, so the app has no such note at all
  if (/^[@`*]/.test(bare) || /:(\s|$)/.test(bare)) return null;
  if (bare === "true" || bare === "True" || bare === "TRUE") return true;
  if (bare === "false" || bare === "False" || bare === "FALSE") return false;
  if (INT_RE.test(bare) || FLOAT_RE.test(bare)) return Number(bare);
  if (HEX_RE.test(bare) || OCT_RE.test(bare)) return Number(bare.replace("+", ""));
  if (/^[-+]?\.(inf|Inf|INF)$/.test(bare)) return bare.startsWith("-") ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(bare)) return NaN;
  return bare;
}

/** A flow sequence's entries, split on the commas that SEPARATE them — a
    comma inside `"…"` or `'…'` belongs to its value. Splitting on every comma
    turned `["Autechre, Sean Booth", Rian]` into three mangled names with
    nothing said about it. `null` when the quoting never closes: an unbalanced
    quote is a syntax error to the engine too, so the caller skips the note. */
function flowParts(inner: string): string[] | null {
  const parts: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      // an escaped quote inside a double-quoted scalar does not close it;
      // `''` inside a single-quoted one is an escaped apostrophe
      if (quote === '"' && ch === "\\" && i + 1 < inner.length) cur += inner[++i];
      else if (ch === quote && !(quote === "'" && inner[i + 1] === "'")) quote = null;
      else if (ch === quote) cur += inner[++i];
      continue;
    }
    // only a quote that OPENS the entry quotes it — an apostrophe inside a
    // plain scalar (`[don't stop, Rian]`) is just a character to YAML, and
    // treating it as an opener would swallow the separator after it
    if ((ch === '"' || ch === "'") && cur.trim() === "") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ",") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quote) return null;
  parts.push(cur);
  return parts;
}

/** `null` when an entry is a shape a strict parser rejects — the caller then
    skips the whole note, as the engine does. */
function flowList(raw: string): string[] | null | undefined {
  const m = /^\[(.*)\]$/.exec(raw.trim());
  if (!m) return undefined;
  if (m[1].trim() === "") return [];
  const parts = flowParts(m[1]);
  if (parts === null) return null;
  const out: string[] = [];
  for (const part of parts) {
    const value = scalar(part);
    if (value === null) return null;
    out.push(value === ABSENT ? "" : String(value));
  }
  return out;
}

/** The flat-mapping subset of YAML that real frontmatter is written in.
 *
 *  Returns the props it understood, EVERY line it could not read, and the
 *  first shape a strict parser would have rejected. The two reports are not
 *  the same failure: an unread line means the app has a prop this reader
 *  does not, a rejected shape means the app has no note here at all and this
 *  reader must produce none either. */
export function parseProps(fm: string): {
  props: Record<string, unknown>;
  unreadable: string[];
  rejected: string | null;
} {
  const props: Record<string, unknown> = {};
  let listKey: string | null = null;
  const unreadable: string[] = [];
  let rejected: string | null = null;
  const excerpt = (line: string) => line.trim().slice(0, 60);
  for (const line of fm.split(/\r?\n/)) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    // YAML forbids a tab in the indentation, and the engine's parser fails
    // the block over one rather than guessing the nesting
    if (/^[ ]*\t/.test(line)) {
      rejected ??= `tab indentation: ${excerpt(line)}`;
      continue;
    }
    const item = /^\s*- (.*)$/.exec(line);
    if (item) {
      if (!listKey) {
        unreadable.push("list item outside a property");
        continue;
      }
      // legal YAML this flat subset does not read, exactly as the key/value
      // branch below reports it: a block scalar, a tag, an anchor, a
      // directive. Read as text, `- !secret foo` became the literal value
      // `!secret foo` and the cell printed a lie with no warning.
      if (/^[|>&!%]/.test(item[1].trim())) {
        unreadable.push(excerpt(line));
        continue;
      }
      const value = scalar(item[1]);
      if (value === null) {
        // a sequence OF MAPPINGS (`- key: value`) is legal YAML the engine
        // reads and this flat subset does not — the same shape as the nested
        // mapping further down, and reported the same way. `scalar` calls its
        // unquoted colon a syntax error, which would skip a note the app HAS
        // and leave this reader short a member the pane still paints.
        if (/^[^\s:'"][^:]*:(\s|$)/.test(item[1].trim())) {
          unreadable.push(excerpt(line));
          continue;
        }
        rejected ??= excerpt(line);
        continue;
      }
      const cur = props[listKey];
      const text = value === ABSENT ? "" : String(value);
      props[listKey] = Array.isArray(cur) ? [...cur, text] : [text];
      continue;
    }
    const kv = /^([^\s:][^:]*):(?:[ \t]+(.*))?$/.exec(line);
    if (!kv) {
      unreadable.push(excerpt(line));
      continue;
    }
    const key = kv[1].trim();
    const rest = (kv[2] ?? "").trim();
    if (rest === "") {
      // an empty value opens a block list; a nested mapping follows the same
      // shape and is exactly what this parser must not guess at, so a nested
      // line lands in the `- ` branch above or reports itself here. The key
      // itself stays UNSET: until an item arrives its value is YAML's null,
      // which the app reads as an absent prop
      listKey = key;
      continue;
    }
    listKey = null;
    // a block scalar (`|`, `>`) and a tagged or anchored value are legal
    // YAML the app reads and this subset does not: the note keeps its other
    // props and the reader is told which key it is missing
    if (/^[|>&!%]/.test(rest)) {
      unreadable.push(excerpt(line));
      continue;
    }
    const flow = flowList(rest);
    if (flow === null) {
      rejected ??= excerpt(line);
      continue;
    }
    if (flow !== undefined) {
      props[key] = flow;
      continue;
    }
    const value = scalar(rest);
    if (value === null) {
      rejected ??= excerpt(line);
      continue;
    }
    if (value !== ABSENT) props[key] = value;
  }
  return { props, unreadable, rejected };
}

/** The list excerpt: the first non-empty body line, markers stripped, capped
    at 120 characters — the engine's `make_excerpt`, which the phrase search
    reads over. */
export function makeExcerpt(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.replace(/^[#>\-* ]+/, "").replace(/\[\[|\]\]/g, "").trim();
    if (t === "") continue;
    const chars = [...t];
    return chars.length > 120 ? `${chars.slice(0, 120).join("")}…` : t;
  }
  return "";
}

const TAG_RE = /#([\p{L}\p{N}_/-]+)/gu;

/** The note's tag set: inline `#hashtags` unioned with the `tags:` prop,
    deduplicated case-insensitively, body spelling first — the engine's
    `note_tags`. Code spans are stripped first, so a `#` inside a fence or a
    URL fragment is not a tag. */
export function noteTags(props: Record<string, unknown>, body: string): string[] {
  const plain = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/https?:\/\/\S+/g, "");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of plain.matchAll(TAG_RE)) {
    const before = plain[m.index - 1];
    if (before !== undefined && !/[\s([{,;:"']/.test(before)) continue;
    const tag = m[1].replace(/[-/_]+$/, "");
    if (tag === "" || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  const key = Object.keys(props).find((k) => k.toLowerCase() === "tags");
  const rawProp = key === undefined ? undefined : props[key];
  const raw = Array.isArray(rawProp)
    ? rawProp.map((v) => String(v))
    : typeof rawProp === "string"
      ? rawProp.split(",")
      : rawProp === undefined || rawProp === null
        ? []
        : [String(rawProp)];
  for (const value of raw) {
    const tag = value.trim().replace(/^#/, "").trim();
    if (tag === "" || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // the engine reads a corrupt config as empty rather than refusing to
    // open the vault; a reader of one view should be no stricter
    return null;
  }
}

function children(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walk(dir: string, rel: string, out: string[]): void {
  for (const entry of children(dir)) {
    // hidden components are outside the index: `.vault`, `.trash`, `.git`
    if (entry.name.startsWith(".")) continue;
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(join(dir, entry.name), childRel, out);
    // the extension folds case, as the engine's own walk does: `NOTE.MD` on
    // a case-insensitive volume is a note on screen and must be one here
    else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(childRel);
  }
}

export function noteFromFile(
  vault: string,
  rel: string
): { note: NoteMeta; unreadable: string[]; rejected: string | null } {
  const abs = join(vault, rel);
  const stem = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  const updated_ms = Math.round(statSync(abs).mtimeMs);
  const raw = readFileSync(abs, "utf8");
  if (raw.startsWith(SEALED_MAGIC)) {
    return {
      note: { path: rel, stem, title: stem, folder, props: {}, updated_ms, excerpt: "", tags: [], sealed: true },
      unreadable: [],
      rejected: null,
    };
  }
  const { fm, body } = splitFrontmatter(raw);
  const { props, unreadable, rejected } = parseProps(fm);
  // the engine's own title rule (`prop_str`): the EXACT key `title`, any
  // value stringified, the file's stem when there is none. A differently
  // cased `Title` is a different prop to the index, and so it is here
  const titleProp = Object.prototype.hasOwnProperty.call(props, "title") ? props.title : undefined;
  const title = titleProp === undefined ? stem : String(titleProp);
  return {
    note: {
      path: rel,
      stem,
      title,
      folder,
      props,
      updated_ms,
      excerpt: makeExcerpt(body),
      tags: noteTags(props, body),
      sealed: false,
    },
    unreadable,
    rejected,
  };
}

/** The whole vault: notes, schema, saved views, per-database prefs, and the
    settings frontmatter the number dialect is read from. */
export function readVault(vault: string): VaultRead {
  const rels: string[] = [];
  walk(vault, "", rels);
  rels.sort();

  const notes: NoteMeta[] = [];
  const warnings: VaultWarning[] = [];
  for (const rel of rels) {
    let read: ReturnType<typeof noteFromFile>;
    try {
      read = noteFromFile(vault, rel);
    } catch (error) {
      warnings.push({ path: rel, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (read.rejected !== null) {
      // the engine's YAML parse is all-or-nothing: a block it rejects leaves
      // the note with no props at all, so it is a member of no database and
      // reaches no view. Printing it here would invent a row the app does
      // not have
      warnings.push({
        path: rel,
        reason: `frontmatter the app's parser rejects, so this note is skipped: ${read.rejected}`,
      });
      continue;
    }
    notes.push(read.note);
    for (const line of read.unreadable) {
      warnings.push({ path: rel, reason: `frontmatter line not understood: ${line}` });
    }
  }

  const schemaRaw = readJson(join(vault, ".vault", "schema.json"));
  const schema: Record<string, Record<string, PropSchema>> = {};
  if (schemaRaw !== null && typeof schemaRaw === "object" && !Array.isArray(schemaRaw)) {
    for (const [type, entry] of Object.entries(schemaRaw as Record<string, unknown>)) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const props: Record<string, PropSchema> = {};
      for (const [prop, ps] of Object.entries(entry as Record<string, unknown>)) {
        // `icon` and `home` are reserved type-entry keys, not properties
        if (prop === "icon" || prop === "home") continue;
        if (ps === null || typeof ps !== "object" || Array.isArray(ps)) continue;
        props[prop] = ps as PropSchema;
      }
      schema[type] = props;
    }
  }

  const viewsRaw = readJson(join(vault, ".vault", "views.json"));
  const views: SavedView[] = [];
  const prefs: Record<string, ViewPref> = {};
  if (viewsRaw !== null && typeof viewsRaw === "object" && !Array.isArray(viewsRaw)) {
    for (const [key, entry] of Object.entries(viewsRaw as Record<string, unknown>)) {
      if (key === "$views") {
        if (Array.isArray(entry)) {
          for (const v of entry) {
            if (v !== null && typeof v === "object" && typeof (v as SavedView).id === "string") {
              views.push(v as SavedView);
            }
          }
        }
        continue;
      }
      if (key.startsWith("$")) continue;
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        prefs[key] = entry as ViewPref;
      }
    }
  }

  let settings: Record<string, unknown> = {};
  try {
    const raw = readFileSync(join(vault, "Settings.md"), "utf8");
    settings = parseProps(splitFrontmatter(raw).fm).props;
  } catch {
    settings = {};
  }

  return { notes, schema, views, prefs, settings, warnings };
}
