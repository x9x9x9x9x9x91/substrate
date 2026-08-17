// Live values in prose — an inline code span whose text is `=`, one
// space, then an expression computes, and the answer renders in its place.
// `The label has `= Masters.count` releases.` reads as a sentence; in any other
// markdown viewer it degrades to a plain code span, which is the whole point of
// riding the existing inline-code grammar instead of inventing a fence.
//
// The grammar is deliberately narrow, because prose about code is still prose:
// `` `=SUM(A1:A2)` `` in a sentence about Excel is something someone WROTE, and
// a renderer that swallows it has destroyed their text. Two rules keep that
// impossible:
//   1. Only the documented form matches — `=` then exactly one space. A bare
//      `` `=…` `` is never a live expression, whatever follows it.
//   2. A span whose expression does not parse is not a match at all, so it
//      renders as the ordinary code span it already is. The quiet dash is
//      reserved for expressions that DO parse and then fail to evaluate —
//      a missing sheet, an unknown member, no FX rate.
// Between them, no input can turn visible text into a dash.
//
// Pure TS, no DOM/node imports: runs in the app and under `node --test`.
// Keep to erasable TS syntax only (no enums/namespaces) so node can strip types.
//
// This module OWNS none of the arithmetic. Expressions parse and evaluate with
// the sheets engine exactly as a sheet's own `formulas` fence does
// (formula.ts parseFormula/evaluate), against sheets already loaded by
// dashboardSheets.ts. Nothing here changes sheet semantics; it only extends
// name resolution into note bodies.
//
// Volatile by construction: no value is ever written back to the note. The
// `.md` keeps the expression text and nothing else.

import { CALC_ERR_DISPLAY } from "./calc.ts";
import { NO_MATCH, fuzzyScore } from "./fuzzy.ts";
import {
  IDENT_SRC,
  collectCrossRefs,
  evaluate,
  ferr,
  isErr,
  parseFormula,
  type Expr,
  type FxResolver,
  type Scope,
  type ScopedValue,
} from "./formula.ts";
import { formatValue, type SheetEval } from "./sheet.ts";
import type { DashboardSheetState } from "./dashboardSheets.ts";

/** One inline expression and where it sits in the body. Offsets span the whole
    code span, backticks included — what the editor decoration replaces. */
export interface LiveExprMatch {
  /** The expression text, `=` and surrounding whitespace stripped. */
  expr: string;
  from: number;
  to: number;
}

/** One expression's answer. `display` is always renderable — the quiet dash
    when it didn't work out — and `err` carries the reason for a hover title.
    The dash is calc.ts's; a failed live value must look exactly like
    a failed calc line, never a red wall inside a sentence. */
export interface LiveValue {
  display: string;
  err?: string;
  /** This was not an expression at all (it doesn't parse, or parsing blew the
      stack). `display` is then the input text verbatim and the caller renders
      the literal span — never the dash, which would eat text the user wrote. */
  literal?: boolean;
}

export const LIVE_ERR_DISPLAY = CALC_ERR_DISPLAY;

// Fenced blocks and inline code spans, same grammar as tags.ts (which cites
// the Rust `code_ranges` twin). Deliberately not `/m`: the closing `$` must
// mean end-of-input, or a closed fence would end at its first line break.
const CODE_RE = /(?:^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?(?:\n(?:```|~~~)[^\n]*(?=\n|$)|$)|`[^`\n]*`/g;

/** Is this match the fenced-block alternative rather than an inline span? */
function isFence(text: string): boolean {
  const t = text.startsWith("\n") ? text.slice(1) : text;
  return t.startsWith("```") || t.startsWith("~~~");
}

/** The one documented form: a code span holding `=`, exactly one space, then a
    non-empty expression. Nothing else is a live value — `` `=1+1` ``,
    `` `=  1+1` `` and `` ` = 1+1` `` are all ordinary code spans. The single
    space is what separates "I am running this" from "I am writing about this",
    and it is the form every doc and every affordance shows. */
const LIVE_SPAN_RE = /^`= (\S.*?)\s*`$/;

/** Line ranges holding a 4-space (or tab) indented code block — markdown code
    as much as a fence is, and the same threshold calc.ts uses for calc lines
    (`^ {0,3}=`). A block starts on an indented line whose predecessor is blank
    or absent, so an indented list continuation (predecessor: the list item)
    stays prose. A loose list's indented paragraph reads as code here and its
    spans quietly don't compute — a miss, never a corruption. */
function indentedCodeRanges(body: string): [number, number][] {
  const out: [number, number][] = [];
  let offset = 0;
  let prevBlank = true;
  let start: number | null = null;
  for (const line of body.split("\n")) {
    const indented = /^(?: {4}|\t)/.test(line);
    const blank = line.trim() === "";
    if (indented && (prevBlank || start !== null)) {
      if (start === null) start = offset;
    } else if (start !== null && !blank) {
      out.push([start, offset]);
      start = null;
    }
    offset += line.length + 1;
    if (!indented || start === null) prevBlank = blank;
  }
  if (start !== null) out.push([start, body.length]);
  return out;
}

/** Every inline live expression in `body`, in document order.
 *
 * Three things are deliberately NOT matches, and each is text someone wrote
 * rather than code they meant to run:
 *  - a span inside a fenced or indented code block — code being *shown*;
 *  - a span that isn't the documented `` `= expr` `` form, prose about
 *    spreadsheets (`` `=SUM(A1:A2)` ``) very much included;
 *  - a span whose expression doesn't parse — so it keeps rendering as the
 *    literal code span it already is, rather than becoming a dash where the
 *    reader's own words used to be.
 *
 * A double-backtick span (``` ``= 1 + 1`` ```) never matches either: CODE_RE's
 * inline alternative is single-backtick, which makes doubling the escape hatch
 * for writing the syntax itself in prose. */
export function liveExprMatches(body: string): LiveExprMatch[] {
  const out: LiveExprMatch[] = [];
  const indented = indentedCodeRanges(body);
  for (const m of body.matchAll(CODE_RE)) {
    if (isFence(m[0])) continue;
    const from = m.index;
    const to = m.index + m[0].length;
    if (indented.some(([a, b]) => from >= a && from < b)) continue;
    const parts = LIVE_SPAN_RE.exec(m[0]);
    if (!parts) continue;
    const expr = parts[1].trim();
    if (expr === "") continue;
    if (parseLive(expr) === null) continue;
    out.push({ expr, from, to });
  }
  return out;
}

/** Parse one expression, or null if it isn't one. `parseFormula` returns an
    error value for ordinary bad syntax; deeply nested input can instead blow
    the recursive-descent stack and *throw* a RangeError. Either way the answer
    is the same — not an expression — and nothing throws past here into the
    CodeMirror decoration builder. */
function parseLive(expr: string): Expr | null {
  try {
    const parsed = parseFormula(expr);
    return isErr(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

/** The sheets `body` needs loaded, deduplicated and lowercased — what the
    caller hands dashboardSheets(). A live expression only ever reaches another
    note through a `Sheet.name` reference, so the cross-refs the sheet engine
    already collects are the complete list. Matches all parse by construction;
    the null branch is belt, not a case. */
export function liveSheetNames(body: string): string[] {
  const seen = new Set<string>();
  for (const { expr } of liveExprMatches(body)) {
    const parsed = parseLive(expr);
    if (!parsed) continue;
    // walking a pathologically deep tree can exhaust the stack as readily as
    // evaluating it; that expression simply reaches no sheet
    try {
      for (const ref of collectCrossRefs(parsed)) seen.add(ref.sheet);
    } catch {
      continue;
    }
  }
  return [...seen];
}

/** What `Sheet.name` means, read-only over the public SheetEval shape:
    summary, then computed column, then a flagged collision, then a data
    column. Same precedence the sheet engine applies to its own cross-sheet
    refs (sheet.ts, `memberValue`) — re-derived here rather than reached into,
    because the engine keeps that helper private and this lane does not change
    sheet internals. */
function memberOf(ev: SheetEval, sheet: string, name: string): ScopedValue | ScopedValue[] {
  const summary = ev.summaries.find((s) => s.name.toLowerCase() === name);
  if (summary) return summary.value;
  const computed = ev.computed.find((c) => c.name.toLowerCase() === name);
  if (computed) return computed.cells;
  const collision = ev.collisions.get(name.trim().toLowerCase());
  if (collision) return ferr(collision);
  const col = ev.headers.findIndex((h) => h.toLowerCase() === name);
  if (col >= 0) return ev.rows.map((r) => r[col] ?? null);
  return ferr(`no column or summary “${name}” on sheet “${sheet}”`);
}

/** The scope one expression evaluates in: its own cross-sheet references,
    bound exactly as evaluateSheet binds them (`sheet.name`, both lowercased).
    A sheet that failed to load binds its error, so the expression fails with
    the reason the sheet gave rather than "unknown sheet value". */
function scopeFor(e: Expr, sheets: Map<string, DashboardSheetState>): Scope {
  const scope: Scope = new Map();
  for (const ref of collectCrossRefs(e)) {
    const key = `${ref.sheet}.${ref.name}`;
    if (scope.has(key)) continue;
    const state = sheets.get(ref.sheet);
    if (!state) {
      scope.set(key, ferr(`no sheet named “${ref.sheet}”`));
      continue;
    }
    if ("error" in state) {
      scope.set(key, ferr(state.error));
      continue;
    }
    scope.set(key, memberOf(state.ev, ref.sheet, ref.name));
  }
  return scope;
}

/** Evaluate one inline expression against already-loaded sheets.
 *
 * Formatting is the sheet grid's own (formatValue → formatNum), so a value
 * reads the same in a sentence as it does in the sheet it came from — a
 * unit-carrying cell included: units reach sheet values as part of the value
 * itself, and formatValue passes them through untouched, which is exactly
 * what the grid shows.
 *
 * A whole column is not a sentence-shaped answer — `= Sheet.column` without an
 * aggregate says nothing a reader can use — so it fails quietly rather than
 * printing a comma list.
 *
 * `literal: true` says "this was never an expression" — the caller renders the
 * span's own text instead of a dash. Callers reaching here through
 * liveExprMatches never see it (those all parse); a direct caller with
 * arbitrary text does, and it is the honest answer for text that isn't code.
 * Evaluation itself is wrapped too: a deep expression can exhaust the stack
 * inside `evaluate` as easily as inside the parser, and nothing may throw into
 * the decoration builder. */
export function evalLiveExpr(
  expr: string,
  sheets: Map<string, DashboardSheetState>,
  fx: FxResolver
): LiveValue {
  const parsed = parseLive(expr);
  if (!parsed) return { display: expr, literal: true };
  let value: ScopedValue | ScopedValue[];
  try {
    value = evaluate(parsed, scopeFor(parsed, sheets), fx);
  } catch (e) {
    return { display: expr, literal: true, err: e instanceof Error ? e.message : String(e) };
  }
  if (Array.isArray(value)) {
    return { display: LIVE_ERR_DISPLAY, err: "that is a whole column — wrap it in SUM, COUNT or AVG" };
  }
  if (isErr(value)) return { display: LIVE_ERR_DISPLAY, err: value.err };
  const display = formatValue(value);
  if (display === "") return { display: LIVE_ERR_DISPLAY, err: "that value is empty" };
  return { display };
}

// --- Name completion inside an open span -------------------------------------
//
// The reason live values were unusable without docs: `Sheet.summary` demands
// exact recall of a name written in another note. These two functions are the
// pure half of the popup that removes that demand — Editor.tsx wraps them in a
// CompletionSource the same way it wraps the `/` menu and the `[[` picker.
//
// Deliberately text-only, not tree-driven: the span being typed is not yet a
// closed `` `…` ``, so the parser sees no InlineCode node to resolve against.

/** An UNCLOSED `` `= `` span up to the cursor: backtick, `=`, one space, then
    anything but a backtick or newline. The one-space form is the documented
    one (LIVE_SPAN_RE), so the popup only ever appears where a live value can
    actually parse. */
const LIVE_OPEN_RE = /`= ([^`\n]*)$/;

/** The trailing `Sheet.` / `Sheet.mem` and bare `Sheet` fragments. Both are
    end-anchored, so what completes is always the name under the cursor, with
    whatever expression precedes it (`SUM(`, `2 * `) left alone. */
const MEMBER_TAIL_RE = new RegExp(`(${IDENT_SRC})\\.((?:${IDENT_SRC})?)$`, "u");
const SHEET_TAIL_RE = new RegExp(`(${IDENT_SRC})$`, "u");
/** Characters that may sit right before a name — anything else means the
    "empty fragment" reading is wrong (`12` is a number, not a name in waiting). */
const NAME_START_RE = /[\s(,+\-*/]$/;
/** What can't precede a fragment for it to be a fresh name: more name. */
const NAME_CHAR_RE = /[\p{L}\p{M}\p{N}_.]/u;

export interface LiveBindQuery {
  /** the sheet whose members to offer, or null while the sheet itself is typed */
  sheet: string | null;
  /** the typed fragment; empty means "list everything" */
  query: string;
}

/** What to complete at the end of `textBefore` (doc text up to the cursor), or
    null where no name can go.

    Two stages, because a live value reaches a value in two hops: the sheet, then
    the member on it. `` `= Mas `` asks for sheets; `` `= Masters. `` asks for
    that sheet's summaries and columns.

    A double-backtick span is never a live value — it is the escape hatch for
    writing the syntax in prose (see liveExprMatches) — so no popup there. */
export function liveBindQuery(textBefore: string): LiveBindQuery | null {
  const m = LIVE_OPEN_RE.exec(textBefore);
  if (!m) return null;
  if (m.index > 0 && textBefore[m.index - 1] === "`") return null;
  const tail = m[1];
  const member = MEMBER_TAIL_RE.exec(tail);
  if (member && fresh(tail, member.index)) return { sheet: member[1], query: member[2] };
  const sheet = SHEET_TAIL_RE.exec(tail);
  if (sheet && fresh(tail, sheet.index)) return { sheet: null, query: sheet[1] };
  // nothing typed yet, or an operator just closed: the sheet list opens
  if (tail === "" || NAME_START_RE.test(tail)) return { sheet: null, query: "" };
  return null;
}

/** Is the fragment at `at` the start of a name, rather than the tail of one
    already qualified (`Masters.rev` — `rev` is not a sheet)? */
function fresh(tail: string, at: number): boolean {
  return at === 0 || !NAME_CHAR_RE.test(tail[at - 1]);
}

/** Names ranked for the popup: fuzzy score descending, caller order kept on a
    tie, duplicates and misses dropped.

    The tiebreak is caller order rather than alphabetical because the caller
    knows which names answer a sentence: a sheet's summaries come before its
    columns (NotePane builds the member list that way), so a bare `Sheet.`
    offers `cash_total` before `account`. Alphabetical would bury the whole
    point of the list under whichever column happens to start with an "a".
    Sheet titles arrive unordered, so that caller sorts before calling.

    Names that are not identifier-shaped are dropped too, and that is a
    grammar fact rather than a filter preference: cross-sheet refs parse as
    `ident.ident` with no quoting anywhere in formula.ts, so a sheet called
    "Q3 Masters" cannot be referenced at all. Offering it would insert text
    that can only fail. */
export function liveBindOptions(query: string, names: string[]): string[] {
  const ident = new RegExp(`^${IDENT_SRC}$`, "u");
  const seen = new Set<string>();
  const out: { name: string; score: number }[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!ident.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const score = fuzzyScore(query, name);
    if (score === NO_MATCH) continue;
    out.push({ name, score });
  }
  // Array.prototype.sort is stable, so equal scores stay in caller order
  out.sort((a, b) => b.score - a.score);
  return out.map((entry) => entry.name);
}
