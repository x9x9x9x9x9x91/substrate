// Tags: inline `#hashtags` in prose, the `tags:` frontmatter prop, and the
// tag-query folders built on both.
//
// The pure half — no React, no CodeMirror — so it runs under `node --test`
// and the editor, sidebar and builder can all share one grammar.
//
// LOCKSTEP TWIN: src-tauri/src/vault/tags.rs. The engine computes every
// note's tags at index time, so the frontend rarely re-extracts; it does so
// for live editor highlighting, where the buffer is ahead of the index.
// The two implementations carry mirrored tests — change one, change both.

import type { NoteMeta, TagFolder } from "./types";

/** Inline tag grammar: `#` then a letter, then letters/digits/`-`/`_`.

    The required leading letter is what keeps `#1` and `#404` out, and why a
    markdown heading can never be a tag: `# Heading` has a space after the
    `#`, `### x` has more `#`. Known edge: a hex colour starting with a
    letter (`#ff00aa`) reads as a tag — carving hex out would also swallow
    real short tags like `#abc`, so the simple grammar wins.

    Lockstep twin: `tag_re` in src-tauri/src/vault/tags.rs. */
export const TAG_RE = /#[A-Za-z][A-Za-z0-9_-]*/g;

/** Spans that swallow a `#`: wikilink and embed targets (`[[Note#heading]]`),
    markdown link destinations (`](…)`), and bare URLs — a fragment is not a
    tag.

    Lockstep twin: `linkish_re` in src-tauri/src/vault/tags.rs. */
export const LINKISH_RE = /!?\[\[[^[\]]*\]\]|\]\([^)\s]*\)|[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+|www\.\S+/g;

/** Fenced blocks and inline code spans — tag-free zones, mirroring the Rust
    `code_ranges` the link scanner already rides. Deliberately not `/m`: the
    closing `$` must mean end-of-input (an unclosed fence runs to EOF), or a
    closed fence would end at its first line break and the fence marker below
    it would open a second, phantom block. */
const CODE_RE = /(?:^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?(?:\n(?:```|~~~)[^\n]*(?=\n|$)|$)|`[^`\n]*`/g;

/** May a tag start at this index? The character before the `#` must not be
    alphanumeric, and not one of the four that mean something else: `&` (HTML
    entities), `#` (`##notatag`), `/` (URL paths), `_` (word-internal).

    Lockstep twin: `boundary_ok` in src-tauri/src/vault/tags.rs. */
export function tagBoundaryOk(body: string, at: number): boolean {
  if (at === 0) return true;
  const prev = body[at - 1];
  if (/[A-Za-z0-9]/.test(prev)) return false;
  return !(prev === "&" || prev === "#" || prev === "/" || prev === "_");
}

/** A tag never ends on a separator — `#demo-` in prose is `demo` plus a dash. */
function trimTail(tag: string): string {
  return tag.replace(/[-_]+$/, "");
}

function spans(body: string, re: RegExp): [number, number][] {
  const out: [number, number][] = [];
  for (const m of body.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

function inSpans(ranges: [number, number][], from: number, to: number): boolean {
  return ranges.some(([s, e]) => from < e && to > s);
}

/** Where each inline tag sits in `body` — what the editor decoration needs.
    Offsets point at the `#`; `tag` excludes it. Not deduplicated: every
    occurrence is its own clickable chip. */
export function inlineTagMatches(body: string): { tag: string; from: number; to: number }[] {
  const code = spans(body, CODE_RE);
  const linkish = spans(body, LINKISH_RE);
  const out: { tag: string; from: number; to: number }[] = [];
  for (const m of body.matchAll(TAG_RE)) {
    const from = m.index;
    const to = from + m[0].length;
    if (!tagBoundaryOk(body, from)) continue;
    if (inSpans(code, from, to) || inSpans(linkish, from, to)) continue;
    const tag = trimTail(m[0].slice(1));
    if (!tag) continue;
    out.push({ tag, from, to: from + 1 + tag.length });
  }
  return out;
}

/** Inline tags in `body`, without their `#`, in first-appearance order and
    deduplicated case-insensitively (first spelling wins). */
export function inlineTags(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { tag } of inlineTagMatches(body)) {
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

/** Tags from the `tags:` prop. A string list is canonical; a scalar is
    accepted and split on commas. A leading `#` is stripped, so
    `tags: ["#demo"]` and `tags: [demo]` are the same tag. */
export function propTags(props: Record<string, unknown>): string[] {
  const key = Object.keys(props).find((k) => k.toLowerCase() === "tags");
  if (key === undefined) return [];
  const value = props[key];
  let raw: string[];
  if (Array.isArray(value)) raw = value.map((v) => (typeof v === "string" ? v : String(v)));
  else if (typeof value === "string") raw = value.split(",");
  else if (value === null || value === undefined) raw = [];
  else raw = [String(value)];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const tag = value.trim().replace(/^#+/, "").trim();
    if (!tag) continue;
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

/** A note's tag set: the union of both sources, inline first (prose order),
    then any prop entry the body didn't already carry. */
export function noteTags(props: Record<string, unknown>, body: string): string[] {
  const out = inlineTags(body);
  const seen = new Set(out.map((t) => t.toLowerCase()));
  for (const tag of propTags(props)) {
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

/** Does a note with `tags` belong in this folder?

    A folder with no positive tags matches nothing — an unfinished builder
    must never sweep the whole vault into a folder. Exclusions always veto.

    Lockstep twin: `TagFolder::matches` in src-tauri/src/vault/tags.rs. */
export function tagFolderMatches(folder: TagFolder, tags: string[]): boolean {
  const folded = new Set(tags.map((t) => t.toLowerCase()));
  const has = (t: string) => folded.has(t.toLowerCase());
  if (folder.tags.length === 0) return false;
  const positive = folder.match === "all" ? folder.tags.every(has) : folder.tags.some(has);
  if (!positive) return false;
  return !folder.exclude.some(has);
}

/** The tags acting inside a folder applies — its positives only. Applying an
    exclusion would file the note straight back out of the folder.

    Lockstep twin: `TagFolder::apply_tags` in src-tauri/src/vault/tags.rs. */
export function tagFolderApplyTags(folder: TagFolder): string[] {
  return [...folder.tags];
}

/** The folder's rule in words, for a row tooltip and the builder's preview —
    the user never sees a query language, so this is the only place the rule
    is ever spelled out. */
export function tagFolderSummary(folder: TagFolder): string {
  if (folder.tags.length === 0) return "No tags yet";
  const join = folder.match === "all" ? " and " : " or ";
  let out = folder.tags.map((t) => `#${t}`).join(join);
  if (folder.exclude.length > 0) {
    out += `, but not ${folder.exclude.map((t) => `#${t}`).join(" or ")}`;
  }
  return out;
}

/** The notes in a tag folder, in the caller's order. */
export function notesInTagFolder(folder: TagFolder, notes: NoteMeta[]): NoteMeta[] {
  return notes.filter((n) => tagFolderMatches(folder, n.tags ?? []));
}

/** Every tag across `notes` with its note count, most-used first, ties broken
    alphabetically — the source for `#` autocomplete and the builder's chip
    picker. Display spelling is the most common one seen.

    Lockstep twin: `Engine::tag_universe` in src-tauri/src/vault/tags.rs. */
export function tagUniverse(notes: NoteMeta[]): { tag: string; count: number }[] {
  const counts = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const note of notes) {
    for (const tag of note.tags ?? []) {
      const key = tag.toLowerCase();
      const entry = counts.get(key) ?? { count: 0, spellings: new Map() };
      entry.count += 1;
      entry.spellings.set(tag, (entry.spellings.get(tag) ?? 0) + 1);
      counts.set(key, entry);
    }
  }
  return [...counts.entries()]
    .map(([key, { count, spellings }]) => {
      let tag = key;
      let best = -1;
      for (const [spelling, n] of spellings) {
        // spelling ties break alphabetically, like the Rust twin — never by
        // scan order, which would differ between the two sides
        if (n > best || (n === best && spelling < tag)) {
          best = n;
          tag = spelling;
        }
      }
      return { tag, count };
    })
    .sort((a, b) => b.count - a.count || a.tag.toLowerCase().localeCompare(b.tag.toLowerCase()));
}

/** The `#`-completion context at the cursor: the partial tag being typed, or
    null when the cursor isn't in one. Mirrors `wikiLinkQuery`'s shape so
    Editor.tsx can wrap it the same way. */
export function tagQuery(textBefore: string): { from: number; query: string } | null {
  const m = /#([A-Za-z][A-Za-z0-9_-]*)?$/.exec(textBefore);
  if (!m) return null;
  const from = m.index;
  if (!tagBoundaryOk(textBefore, from)) return null;
  return { from, query: m[1] ?? "" };
}

export const MAX_TAG_OPTIONS = 100;

/** Completion candidates for a `#` query: prefix matches first, then
    substring matches, each block already in most-used order. */
export function tagOptions(query: string, universe: { tag: string; count: number }[]): string[] {
  const q = query.toLowerCase();
  if (!q) return universe.slice(0, MAX_TAG_OPTIONS).map((t) => t.tag);
  const prefix: string[] = [];
  const rest: string[] = [];
  for (const { tag } of universe) {
    const folded = tag.toLowerCase();
    if (folded.startsWith(q)) prefix.push(tag);
    else if (folded.includes(q)) rest.push(tag);
  }
  return [...prefix, ...rest].slice(0, MAX_TAG_OPTIONS);
}
