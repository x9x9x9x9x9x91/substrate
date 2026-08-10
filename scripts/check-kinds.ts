#!/usr/bin/env node
/**
 * Dashboard-kind inventory drift check.
 *
 * The set of `dashboard:` values the app renders is written out by hand in
 * five places, and until this script existed only one of them was guarded:
 *
 *   1. `BUILT_IN_KINDS`  — src/lib/kinds.ts. The SOURCE OF TRUTH here, and
 *      the set a vault bundle may not shadow (§5.8): a built-in missing from
 *      it can be shadowed by vault code, and built-ins write vault state, so
 *      the gap is a write-capture path.
 *   2. The dispatch chain — `DashboardBody` in src/components/DashboardPane.tsx.
 *   3. `DASHBOARD_ICONS`  — src/lib/dbicons.ts. A kind missing here silently
 *      falls to the generic chart glyph; nothing failed, the row just looks
 *      like every other row.
 *   4. docs/vault-format.md §5.2 — the dispatch table external writers treat
 *      as a contract, plus the sentence naming the icon set.
 *   5. src-tauri/src/seed/AGENTS.md — the orientation file the app seeds into
 *      a new vault (and examples/vault/AGENTS.md, held byte-identical to it by
 *      scripts/example-vault.test.ts).
 *
 * Same shape as scripts/check-ipc.ts: re-derive every inventory
 * mechanically from the checked-in tree, compare, and fail `npm test` on any
 * divergence. Input it cannot parse is thrown, never skipped — a silently
 * skipped inventory is exactly the drift this exists to catch.
 *
 * TWO exceptions are modelled explicitly rather than special-cased silently:
 *
 *   - `charts` is RESERVED: a real `dashboard:` value with no branch of its own,
 *     because it names the ` ```chart `-fence renderer (§5.5) that DashboardBody
 *     already falls through to. So it belongs in `BUILT_IN_KINDS` (bundles may
 *     not shadow it) and in both DISPATCH TABLES the docs publish — external
 *     writers need to know the name works — but it must appear in neither the
 *     if-chain (a branch there would be dead code) nor the icon inventories
 *     (a reserved name owns no sidebar row of its own).
 *   - PRIVACY. Some kinds are machine-specific and sit between share-mirror
 *     strip markers (see STRIP_START/STRIP_END below) so the public mirror
 *     never carries them. A kind's privacy has to MATCH across all five:
 *     a kind private in one file and public in another leaves the stripped
 *     snapshot either broken or leaking, so the flag is compared like a name.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blankNonCode, matchDelim } from "./check-ipc.ts";
import { RESERVED_KINDS } from "../src/lib/kinds.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Built-in names that exist to be un-shadowable, not to be dispatched. Owned
    by src/lib/kinds.ts — the dispatch tail needs the same set
    at runtime to tell a legitimate fall-through from a missing renderer, and
    two copies of it would be one more inventory to drift. Re-exported because
    the failures below name it and the tests import it from here. */
export { RESERVED_KINDS };

/**
 * Dispatched kinds that deliberately keep the generic chart glyph. Empty on
 * purpose: a new kind gets a curated mark, and this is the visible escape
 * hatch for the day one genuinely shouldn't (the checker names it in the
 * failure, so nobody has to guess the opt-out exists).
 */
export const ICON_EXEMPT: ReadonlySet<string> = new Set<string>();

/* ── privacy ────────────────────────────────────────────────────────────── */

/**
 * The strip markers, assembled rather than written out. This file ships to
 * the public mirror itself, and share-mirror.sh scans every shipped file for
 * literal markers and refuses on an unbalanced count — a bare mention here
 * would read as an unclosed region and abort the mirror.
 */
const STRIP = "share-mirror" + ":strip-";
export const STRIP_START = STRIP + "start";
export const STRIP_END = STRIP + "end";

/**
 * Per-character "is inside a share-mirror strip region" map for a source.
 * Both marker spellings count (`// …` in code, `<!-- … -->` in markdown), and
 * the marker LINES themselves are inside the region — share-mirror.sh drops
 * them too. Unbalanced or nested markers throw, exactly as the shell does:
 * a half-stripped file ships either broken code or a private name.
 */
export function stripFlags(src: string, label = "source"): boolean[] {
  const flags = new Array<boolean>(src.length).fill(false);
  let at = 0;
  let depth = 0;
  for (const line of src.split("\n")) {
    const start = line.includes(STRIP_START);
    const end = line.includes(STRIP_END);
    if (start && end) throw new Error(`${label}: one line opens and closes a strip region`);
    if (start) {
      if (depth) throw new Error(`${label}: nested ${STRIP_START}`);
      depth = 1;
    } else if (end) {
      if (!depth) throw new Error(`${label}: ${STRIP_END} without a start`);
    }
    if (depth) for (let i = at; i < at + line.length + 1 && i < flags.length; i++) flags[i] = true;
    if (end) depth = 0;
    at += line.length + 1;
  }
  if (depth) throw new Error(`${label}: unterminated ${STRIP_START}`);
  return flags;
}

/** One inventory: kind name → whether it is mirror-private here. */
export type KindMap = Map<string, boolean>;

/**
 * The span of a `{…}` / `[…]` block that follows an anchor, located on the
 * comment- and string-blanked source so prose can't move it, and returned as
 * offsets into the ORIGINAL text.
 */
function blockAfter(src: string, anchor: RegExp, open: "{" | "[", label: string): [number, number] {
  const code = blankNonCode(src, "ts");
  const m = anchor.exec(code);
  if (!m) throw new Error(`${label}: ${anchor} not found — the declaration moved or was renamed`);
  const from = code.indexOf(open, m.index + m[0].length);
  if (from === -1) throw new Error(`${label}: no ${open} after ${anchor}`);
  return [from + 1, matchDelim(code, from)];
}

/**
 * The body of a top-level `.tsx` function, by lines rather than by brace
 * matching: `blankNonCode` is a TS scanner and JSX text (an apostrophe in
 * prose, a `<` that is not a comparison) is not TS, so running it over a
 * component file mangles the source. A top-level function in this codebase
 * ends at the first column-0 `}`, which is enough and cannot be confused by
 * anything inside the body.
 */
function tsxBlock(src: string, anchor: RegExp, label: string): [number, number] {
  const lines = src.split("\n");
  let at = 0;
  let from = -1;
  for (const line of lines) {
    if (from === -1) {
      if (anchor.test(line)) from = at + line.length + 1;
    } else if (line === "}") {
      return [from, at];
    }
    at += line.length + 1;
  }
  if (from === -1) throw new Error(`${label}: ${anchor} not found — the declaration moved or was renamed`);
  throw new Error(`${label}: no column-0 } closing the block after ${anchor}`);
}

/** Non-blank, non-comment lines of a span, with their absolute offsets. */
function codeLines(src: string, from: number, to: number): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  let at = from;
  for (const line of src.slice(from, to).split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("//")) out.push({ text: t, at });
    at += line.length + 1;
  }
  return out;
}

/* ── 1. BUILT_IN_KINDS (source of truth) ────────────────────────────────── */

export function parseBuiltInKinds(src: string, label = "src/lib/kinds.ts"): KindMap {
  const [from, to] = blockAfter(src, /\bBUILT_IN_KINDS\b[^=]*=\s*new Set\s*\(/, "[", label);
  const priv = stripFlags(src, label);
  const out: KindMap = new Map();
  for (const { text, at } of codeLines(src, from, to)) {
    const m = /^"([a-z0-9][a-z0-9-]*)",?$/.exec(text);
    if (!m) throw new Error(`${label}: unparseable BUILT_IN_KINDS entry ${JSON.stringify(text)}`);
    if (out.has(m[1])) throw new Error(`${label}: "${m[1]}" listed twice in BUILT_IN_KINDS`);
    out.set(m[1], priv[at]);
  }
  if (out.size === 0) throw new Error(`${label}: BUILT_IN_KINDS parsed as empty`);
  return out;
}

/* ── 2. the dispatch chain ──────────────────────────────────────────────── */

export interface Dispatch {
  /** kind → the component it renders */
  kinds: Map<string, { component: string; private: boolean }>;
  /** the component an unrecognized kind falls through to */
  fallback: string;
}

/**
 * `DashboardBody`'s if-chain. Every line mentioning `kind ===` must be a plain
 * `if (kind === "x") return <XDashboard …>` — a computed or grouped comparison
 * is thrown rather than skipped, because a kind reached through one would be
 * dispatched without appearing in any inventory.
 */
export function parseDispatch(src: string, label = "src/components/DashboardPane.tsx"): Dispatch {
  const [from, to] = tsxBlock(src, /^function DashboardBody\(/, label);
  const priv = stripFlags(src, label);
  const kinds = new Map<string, { component: string; private: boolean }>();
  let fallback = "";
  for (const { text, at } of codeLines(src, from, to)) {
    if (text.includes("kind ===")) {
      const m = /^if \(kind === "([a-z0-9][a-z0-9-]*)"\) return <([A-Za-z0-9_]+) \{\.\.\.props\} \/>;$/.exec(text);
      if (!m) throw new Error(`${label}: unparseable dispatch branch ${JSON.stringify(text)}`);
      if (kinds.has(m[1])) throw new Error(`${label}: "${m[1]}" dispatched twice — the second branch is dead`);
      kinds.set(m[1], { component: m[2], private: priv[at] });
      continue;
    }
    const f = /^return <([A-Za-z0-9_]+) \{\.\.\.props\} \/>;$/.exec(text);
    if (f) {
      if (fallback) throw new Error(`${label}: DashboardBody has two unconditional returns`);
      fallback = f[1];
    }
  }
  if (kinds.size === 0) throw new Error(`${label}: DashboardBody's dispatch chain parsed as empty`);
  if (!fallback) throw new Error(`${label}: DashboardBody has no unconditional fallback return`);
  return { kinds, fallback };
}

/* ── 3. DASHBOARD_ICONS ─────────────────────────────────────────────────── */

export interface IconEntry {
  glyph: string;
  private: boolean;
}

export function parseIcons(src: string, label = "src/lib/dbicons.ts"): Map<string, IconEntry> {
  const [from, to] = blockAfter(src, /\bconst DASHBOARD_ICONS\b[^=]*=\s*/, "{", label);
  const priv = stripFlags(src, label);
  const out = new Map<string, IconEntry>();
  for (const { text, at } of codeLines(src, from, to)) {
    const m = /^(?:"([a-z0-9][a-z0-9-]*)"|([a-z0-9][a-z0-9-]*)):\s*\{\s*glyph:\s*"([a-z0-9-]+)"\s*\},?$/.exec(text);
    if (!m) throw new Error(`${label}: unparseable DASHBOARD_ICONS entry ${JSON.stringify(text)}`);
    const kind = m[1] ?? m[2];
    if (out.has(kind)) throw new Error(`${label}: "${kind}" mapped twice in DASHBOARD_ICONS`);
    out.set(kind, { glyph: m[3], private: priv[at] });
  }
  if (out.size === 0) throw new Error(`${label}: DASHBOARD_ICONS parsed as empty`);
  return out;
}

/** Top-level keys of the curated `GLYPHS` record, so a typo'd mark is caught. */
export function parseGlyphIds(src: string, label = "src/lib/dbicons.ts"): Set<string> {
  const [from, to] = blockAfter(src, /\bexport const GLYPHS\b[^=]*=\s*/, "{", label);
  const code = blankNonCode(src, "ts");
  const out = new Set<string>();
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = code[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (c === ":" && depth === 0) {
      // key names are read from the ORIGINAL text — blanking hollowed the
      // quoted ones ("check-square" → spaces)
      const m = /(?:"([^"\n]+)"|([A-Za-z0-9_-]+))\s*$/.exec(src.slice(from, i));
      if (!m) throw new Error(`${label}: unparseable GLYPHS key before offset ${i}`);
      out.add(m[1] ?? m[2]);
    }
  }
  if (out.size === 0) throw new Error(`${label}: GLYPHS parsed as empty`);
  return out;
}

/* ── 4+5. the prose lists ───────────────────────────────────────────────── */

/**
 * Backtick-quoted kind names inside a delimited region of a doc.
 *
 * `arrow` mode takes only names followed by `→` (the dispatch tables write
 * `` `metrics` `` → the metrics cards renderer), so surrounding prose that
 * mentions a kind in passing is not an inventory entry. `list` mode takes
 * every backticked token, for a plain enumeration.
 *
 * A missing anchor throws: an inventory that quietly stops being found reads
 * exactly like an inventory that agrees.
 */
export function parseDocKinds(
  text: string,
  opts: { label: string; start: string; end: string; mode: "arrow" | "list" }
): KindMap {
  const from = text.indexOf(opts.start);
  if (from === -1) throw new Error(`${opts.label}: anchor ${JSON.stringify(opts.start)} not found — the prose was reworded`);
  const to = text.indexOf(opts.end, from);
  if (to === -1) throw new Error(`${opts.label}: closing anchor ${JSON.stringify(opts.end)} not found after the list`);
  const priv = stripFlags(text, opts.label);
  const region = text.slice(from, to);
  const re = opts.mode === "arrow" ? /`([a-z0-9][a-z0-9-]*)`\s*→/g : /`([a-z0-9][a-z0-9-]*)`/g;
  const out: KindMap = new Map();
  let m: RegExpExecArray | null;
  while ((m = re.exec(region))) {
    if (out.has(m[1])) throw new Error(`${opts.label}: "${m[1]}" listed twice`);
    out.set(m[1], priv[from + m.index]);
  }
  if (out.size === 0) throw new Error(`${opts.label}: the list parsed as empty`);
  return out;
}

/**
 * The prose roster of curated glyph ids, in the order it prints them.
 *
 * A separate parser from `parseDocKinds` because this list is not a kind
 * inventory: it carries no privacy flags (every glyph ships to the mirror) and
 * its ids are compared against `GLYPHS` rather than against the dispatch chain.
 * Order is kept because the roster is the picker grid's order (`GLYPH_IDS`),
 * and a roster that lists the right names in the wrong places still misdescribes
 * the picker.
 */
export function parseDocGlyphIds(text: string, label = "docs/vault-format.md §5.2 glyph roster"): string[] {
  const anchor = "curated glyph ids";
  const from = text.indexOf(anchor);
  if (from === -1) throw new Error(`${label}: anchor ${JSON.stringify(anchor)} not found — the prose was reworded`);
  // the roster is one sentence: it ends at the first period outside the backticks
  const to = text.indexOf("`.\n", from);
  if (to === -1) throw new Error(`${label}: the roster does not end in a backticked id — the prose was reworded`);
  const out = [...text.slice(from, to + 1).matchAll(/`([a-z0-9][a-z0-9-]*)`/g)].map((m) => m[1]);
  // the anchor sentence names the source symbols before the list itself
  const list = out.filter((id) => id !== "GLYPHS");
  if (list.length === 0) throw new Error(`${label}: the roster parsed as empty`);
  return list;
}

/**
 * The `.vault/*.json` paths `EXCLUDE_CONTENT` keeps out of history.
 *
 * Rust rather than TypeScript, which no other inventory here reads — but the
 * drift class is identical (a hand-written prose list against a constant), the
 * doc side is a sentence in the same file §5.2 already guards, and a second
 * script existing only to parse one Rust string literal would be the same
 * inventory in one more place.
 */
export function parseExcludedVaultJsons(src: string, label = "src-tauri/src/history.rs"): string[] {
  const m = /pub\(crate\) const EXCLUDE_CONTENT: &str =\s*("(?:[^"\\]|\\.)*")\s*;/.exec(src);
  if (!m) throw new Error(`${label}: EXCLUDE_CONTENT not found or not a single string literal`);
  const lines = m[1].slice(1, -1).split("\\n");
  const out = lines.filter((l) => l.startsWith(".vault/") && l.endsWith(".json"));
  if (out.length === 0) throw new Error(`${label}: EXCLUDE_CONTENT names no .vault JSONs`);
  return out;
}

/** The same paths as the doc bullet spells them out. */
export function parseDocExcludedVaultJsons(
  text: string,
  label = "docs/vault-format.md §11 exclude list"
): string[] {
  const anchor = "`src-tauri/src/history.rs` `EXCLUDE_CONTENT`)";
  const from = text.indexOf(anchor);
  if (from === -1) throw new Error(`${label}: anchor ${JSON.stringify(anchor)} not found — the prose was reworded`);
  const to = text.indexOf("Everything else is tracked", from);
  if (to === -1) throw new Error(`${label}: closing anchor not found after the list`);
  const out = [...text.slice(from, to).matchAll(/`(\.vault\/[a-z0-9-]+\.json)`/g)].map((m) => m[1]);
  if (out.length === 0) throw new Error(`${label}: the exclude list parsed as empty`);
  return out;
}

/** Number words the prose counts those JSONs with, up to a roster nobody will write out. */
const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];

/**
 * Every "the N device-local `.vault` JSONs" claim in a doc, with its word.
 *
 * The count is a second, looser copy of the enumeration: prose elsewhere
 * summarises the list by size instead of repeating it, and that summary is
 * what went stale when the fourth file landed.
 */
export function parseDocLocalJsonCounts(text: string): string[] {
  return [...text.matchAll(/the ([a-z]+) device-local\s+`?\.vault`? JSONs/g)].map((m) => m[1]);
}

/* ── cross-check ────────────────────────────────────────────────────────── */

export interface Inventories {
  builtIn: KindMap;
  dispatch: Dispatch;
  icons: Map<string, IconEntry>;
  glyphIds: Set<string>;
  formatDispatch: KindMap;
  formatIcons: KindMap;
  formatGlyphRoster: string[];
  seedAgents: KindMap;
  excludedVaultJsons: string[];
  formatExcludedVaultJsons: string[];
  localJsonCounts: { label: string; words: string[] }[];
}

const show = (ks: Iterable<string>) => [...ks].map((k) => `"${k}"`).join(", ");

/** Names + privacy of one inventory against the derived expectation. */
function compare(problems: string[], label: string, want: KindMap, got: KindMap, fix: string): void {
  const missing = [...want.keys()].filter((k) => !got.has(k));
  const extra = [...got.keys()].filter((k) => !want.has(k));
  if (missing.length) problems.push(`${label}: missing ${show(missing)} — ${fix}`);
  if (extra.length) problems.push(`${label}: lists ${show(extra)}, which is not there — ${fix}`);
  for (const [k, isPrivate] of got) {
    const wanted = want.get(k);
    if (wanted === undefined || wanted === isPrivate) continue;
    problems.push(
      `${label}: "${k}" is ${isPrivate ? "inside" : "outside"} a share-mirror strip region here but ` +
        `${wanted ? "private" : "public"} in src/lib/kinds.ts — the mirror would ${
          isPrivate ? "drop it from one file only" : "leak it"
        }`
    );
  }
}

/**
 * An ordered, flagless roster against the constant it publishes.
 *
 * Order counts here in a way it does not for the kind inventories: both lists
 * this checks are read as sequences — the glyph roster mirrors the picker grid,
 * the exclude list mirrors the file git actually writes — so a reordering is a
 * doc that describes something the reader will not see.
 */
function compareList(problems: string[], label: string, want: string[], got: string[], fix: string): void {
  const missing = want.filter((k) => !got.includes(k));
  const extra = got.filter((k) => !want.includes(k));
  if (missing.length) problems.push(`${label}: missing ${show(missing)} — ${fix}`);
  if (extra.length) problems.push(`${label}: lists ${show(extra)}, which is not there — ${fix}`);
  if (!missing.length && !extra.length && want.join("\u0000") !== got.join("\u0000")) {
    problems.push(`${label}: names the right entries in a different order than the source — ${fix}`);
  }
}

/** Every drift class, as human-readable lines. Empty array = the five agree. */
export function crossCheck(inv: Inventories): string[] {
  const problems: string[] = [];
  const { builtIn, dispatch, icons, glyphIds } = inv;

  // BUILT_IN_KINDS is the source of truth, so it is checked against the
  // dispatch chain plus the reserved names rather than against a hand list.
  const dispatched: KindMap = new Map([...dispatch.kinds].map(([k, v]) => [k, v.private]));
  for (const k of RESERVED_KINDS) {
    if (!builtIn.has(k)) {
      problems.push(
        `kinds.ts: reserved kind "${k}" is missing from BUILT_IN_KINDS — a vault bundle could shadow it`
      );
    }
    if (dispatch.kinds.has(k)) {
      problems.push(
        `dispatch: "${k}" is reserved (it names the chart-fence fallback ${dispatch.fallback}), ` +
          `but DashboardBody dispatches it — drop the branch or drop it from RESERVED_KINDS`
      );
    }
  }
  for (const k of dispatched.keys()) {
    if (!builtIn.has(k)) {
      problems.push(
        `kinds.ts: DashboardBody dispatches "${k}" but BUILT_IN_KINDS omits it — ` +
          `a vault bundle named "${k}" could shadow a built-in that writes vault state`
      );
    }
  }
  for (const [k, isPrivate] of builtIn) {
    if (RESERVED_KINDS.has(k)) continue;
    if (!dispatched.has(k)) {
      problems.push(
        `dispatch: BUILT_IN_KINDS claims "${k}" but DashboardBody never dispatches it — ` +
          `add the branch, or add it to RESERVED_KINDS in src/lib/kinds.ts`
      );
      continue;
    }
    if (dispatched.get(k) !== isPrivate) {
      problems.push(
        `dispatch: "${k}" is ${dispatched.get(k) ? "private" : "public"} in DashboardBody but ` +
          `${isPrivate ? "private" : "public"} in src/lib/kinds.ts — the strip regions disagree`
      );
    }
  }

  // icons: one curated mark per dispatched kind, and no marks for anything else
  for (const [k, isPrivate] of dispatched) {
    if (ICON_EXEMPT.has(k)) continue;
    const icon = icons.get(k);
    if (!icon) {
      problems.push(
        `icons: "${k}" has no DASHBOARD_ICONS entry — its sidebar row silently keeps the generic ` +
          `chart glyph (add a mark, or add it to ICON_EXEMPT in scripts/check-kinds.ts)`
      );
      continue;
    }
    if (icon.private !== isPrivate) {
      problems.push(
        `icons: "${k}" is ${icon.private ? "private" : "public"} in DASHBOARD_ICONS but ` +
          `${isPrivate ? "private" : "public"} in the dispatch chain — the strip regions disagree`
      );
    }
  }
  for (const [k, icon] of icons) {
    if (!dispatched.has(k)) {
      problems.push(
        `icons: DASHBOARD_ICONS maps "${k}", which nothing dispatches — dead entry`
      );
    }
    if (!glyphIds.has(icon.glyph)) {
      problems.push(`icons: "${k}" uses glyph "${icon.glyph}", which GLYPHS does not define`);
    }
  }
  for (const k of ICON_EXEMPT) {
    if (icons.has(k)) problems.push(`ICON_EXEMPT lists "${k}", but DASHBOARD_ICONS does give it a mark`);
    else if (!dispatched.has(k)) problems.push(`ICON_EXEMPT lists "${k}", which nothing dispatches`);
  }

  // docs. The published tables name every value a `dashboard:` prop may take,
  // so they carry the reserved names too — those are dispatched through the
  // fallback rather than a branch, which is an implementation detail the
  // contract should not expose.
  const documented: KindMap = new Map(dispatched);
  for (const k of RESERVED_KINDS) {
    const isPrivate = builtIn.get(k);
    if (isPrivate !== undefined) documented.set(k, isPrivate);
  }

  compare(problems, "docs/vault-format.md §5.2 dispatch table", documented, inv.formatDispatch,
    "external writers read this table as a contract");

  const iconKinds: KindMap = new Map([...icons].map(([k, v]) => [k, v.private]));
  compare(problems, "docs/vault-format.md §5.2 icon list", iconKinds, inv.formatIcons,
    "it names the DASHBOARD_ICONS set");

  compareList(
    problems,
    "docs/vault-format.md §5.2 glyph roster",
    [...glyphIds],
    inv.formatGlyphRoster,
    "it is the published set of ids an `icon:` prop may name, in picker order"
  );

  compareList(
    problems,
    "docs/vault-format.md §11 exclude list",
    inv.excludedVaultJsons,
    inv.formatExcludedVaultJsons,
    "it enumerates EXCLUDE_CONTENT's device-local `.vault` JSONs"
  );

  // The prose also summarises that same list by size in other sections, and a
  // count is what goes stale silently: nothing about "three" looks wrong.
  const want = COUNT_WORDS[inv.excludedVaultJsons.length];
  for (const { label, words } of inv.localJsonCounts) {
    for (const w of words) {
      if (w === want) continue;
      problems.push(
        `${label}: says "the ${w} device-local \`.vault\` JSONs", but EXCLUDE_CONTENT excludes ` +
          `${inv.excludedVaultJsons.length} of them — say "${want ?? inv.excludedVaultJsons.length}"`
      );
    }
  }

  // The seeded orientation file is written into every new vault, public and
  // private builds alike, and carries no strip regions — so it lists exactly
  // the PUBLIC half of the documented set and stays silent about the rest.
  const publicDocumented: KindMap = new Map([...documented].filter(([, p]) => !p));
  compare(problems, "src-tauri/src/seed/AGENTS.md", publicDocumented, inv.seedAgents,
    "it is the orientation file the app seeds into a new vault");
  for (const [k, isPrivate] of inv.seedAgents) {
    if (isPrivate || documented.get(k) === true) {
      problems.push(
        `src-tauri/src/seed/AGENTS.md: names the private kind "${k}" — this file ships to the mirror ` +
          `with no strip region, so the name would leak`
      );
    }
  }

  return problems;
}

/* ── driver ─────────────────────────────────────────────────────────────── */

const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

export function collect(): Inventories {
  const dbicons = read("src/lib/dbicons.ts");
  const vaultFormat = read("docs/vault-format.md");
  const dashboards = read("docs/dashboards.md");
  return {
    excludedVaultJsons: parseExcludedVaultJsons(read("src-tauri/src/history.rs")),
    formatExcludedVaultJsons: parseDocExcludedVaultJsons(vaultFormat),
    formatGlyphRoster: parseDocGlyphIds(vaultFormat),
    localJsonCounts: [
      { label: "docs/vault-format.md", words: parseDocLocalJsonCounts(vaultFormat) },
      { label: "docs/dashboards.md", words: parseDocLocalJsonCounts(dashboards) },
    ],
    builtIn: parseBuiltInKinds(read("src/lib/kinds.ts")),
    dispatch: parseDispatch(read("src/components/DashboardPane.tsx")),
    icons: parseIcons(dbicons),
    glyphIds: parseGlyphIds(dbicons),
    formatDispatch: parseDocKinds(vaultFormat, {
      label: "docs/vault-format.md §5.2 dispatch table",
      start: "These public kinds are dispatched:",
      end: "**A missing `dashboard` prop",
      mode: "arrow",
    }),
    formatIcons: parseDocKinds(vaultFormat, {
      label: "docs/vault-format.md §5.2 icon list",
      start: "DASHBOARD_ICONS —",
      end: "plus any machine-specific kinds",
      mode: "list",
    }),
    seedAgents: parseDocKinds(read("src-tauri/src/seed/AGENTS.md"), {
      label: "src-tauri/src/seed/AGENTS.md",
      start: "the public built-ins are:",
      end: "`dashboard: charts` always selects",
      mode: "list",
    }),
  };
}

function main(): void {
  let inv: Inventories;
  try {
    inv = collect();
  } catch (e) {
    console.error(`check-kinds: could not build the inventories — ${(e as Error).message}`);
    console.error("This is a parse failure, not a clean tree. Fix the parser or the source.");
    process.exit(2);
  }

  const problems = crossCheck(inv);
  console.log(
    `check-kinds: ${inv.builtIn.size} built-in kinds ` +
      `(${inv.dispatch.kinds.size} dispatched, ${RESERVED_KINDS.size} reserved), ` +
      `${inv.icons.size} curated icons`
  );
  if (problems.length === 0) {
    console.log("check-kinds: inventories agree ✓");
    return;
  }
  console.error(`\ncheck-kinds: ${problems.length} drift problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error("");
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
