// Formula language for sheets — column-and-aggregate formulas, Excel-style.
// v2: cross-sheet references (`OtherSheet.col`, `"Quoted Name".summary`).
// Pure TS, no DOM/node imports: runs in the app and under `node --test`.
// Keep to erasable TS syntax only (no enums/namespaces) so node can strip types.

import { parseStrictNumber } from "./aggregate.ts";
import { daysBetween, isIsoDate, shiftDate, todayIso } from "./dates.ts";

export type Scalar = number | string | boolean;
export type Cell = Scalar | null; // null = empty cell
export type Value = Scalar | FErr;

export interface FErr {
  err: string;
}

export const ferr = (msg: string): FErr => ({ err: msg });

export function isErr(v: unknown): v is FErr {
  return typeof v === "object" && v !== null && "err" in (v as Record<string, unknown>);
}

// FX rate resolver: ("USD","EUR") → rate, or null when unavailable.
export type FxResolver = (from: string, to: string) => number | null;

/** What one fact lookup can come back as (docs/time-travel-spec.md §2.3).
    The five cases are distinct on purpose: a value the vault genuinely cannot
    know must never render as a blank or a zero, and a mistyped path must never
    read as "did not exist yet". */
export type HistoryLookup =
  /** the fact had this value — raw text; the engine coerces numbers */
  | { kind: "value"; value: string }
  /** the note or the key did not exist then (or has since been deleted): blank */
  | { kind: "absent" }
  /** before the oldest surviving snapshot — trimmed or purged, unanswerable.
      `oldest` is that snapshot's ISO day, or null when the vault has none. */
  | { kind: "unknowable"; oldest: string | null }
  /** no note at that path *today* — a typo, not a "not yet" */
  | { kind: "unknown-note" }
  /** the fact wasn't in the prefetch, or history is still loading */
  | { kind: "pending" };

/** Reads one frontmatter fact, optionally as of a past day.
    `date` null = present tense (`PROP`); an ISO day = as of the last instant of
    that local day (`AT`, §2.1). Synchronous like `fx`: whatever it needs was
    prefetched before evaluation began (§3.1). */
export interface HistoryResolver {
  (path: string, key: string, date: string | null): HistoryLookup;
  /** Set by `AT()` on the resolver it hands its own body: the day being read as
      of. It is what tells everything inside that body it is in the past tense —
      anything that can only speak for today refuses rather than quietly
      answering with today's number, which is the one failure a time-travel
      query must never have. */
  asOfDate?: string;
  /** The resolver this one was bound from, so a nested `AT()` binds its day
      against the original rather than on top of an outer day. */
  unbound?: HistoryResolver;
  /** Reads a member off another sheet as of a past day (§3.2). Supplied by the
      surface that prefetched the historical sheets, because re-evaluating one
      is a *sheet* operation and this file knows nothing about sheets — the same
      division as `load`, which hands cross-sheet values in through scope.
      Absent when nothing prefetched them, which reads as "not loaded yet"
      rather than as today's number. */
  sheetValue?: (sheet: string, member: string, date: string) => ScopedValue | ScopedValue[];
}

// A scope value may itself be an error (e.g. a computed column feeding a
// summary) — errors then propagate through dependent formulas, Excel-style.
export type ScopedValue = Cell | FErr;

// Scope maps lowercased column names to either a row value or a whole column.
export type Scope = Map<string, ScopedValue | ScopedValue[]>;

/** Key prefix for the whole-column view of the *current* sheet's columns,
    bound alongside the per-row values in row scope. In row scope a
    column name resolves to this row's cell — which is what a computed column
    wants everywhere except a row-scoped `LOOKUP`'s table arguments, where a
    same-sheet table (`LOOKUP(cur, code, rate)`) still needs whole columns.
    The prefix starts with a NUL so no parsed reference can ever collide with
    it, and only LOOKUP's column positions consult it: every other read of a
    column name in row scope stays the row's own cell. */
export const ROW_COLUMNS_PREFIX = "\u0000col.";

// ---------- AST ----------

export type BinOp = "+" | "-" | "*" | "/" | "=" | "<>" | "<" | ">" | "<=" | ">=";

export type Expr =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  // sheet set → cross-sheet reference ("holdings.total"); both sides lowercased
  | { k: "ref"; name: string; sheet?: string }
  | { k: "call"; name: string; args: Expr[] }
  | { k: "bin"; op: BinOp; l: Expr; r: Expr }
  | { k: "neg"; e: Expr };

const AGGREGATES = new Set([
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COUNT",
  "SUMIF",
  "COUNTIF",
  "SUMPRODUCT",
  "LAST",
  "LOOKUP",
]);
const SCALAR_FNS = new Set(["IF", "ROUND", "FX", "TODAY", "PROP", "AT"]);

// Does the expression read a row value — a column of the current sheet, used
// outside any aggregate? `rowShaped` answers that for one bare (non-dotted)
// reference; the caller owns the definition (sheet.ts: not a summary name).
// Refs inside an aggregate are whole columns, not row values, so `SUM(price)`
// is row-shaped-free — with the one exception below.
function readsRowValue(e: Expr, rowShaped: (ref: string) => boolean): boolean {
  switch (e.k) {
    case "ref":
      return e.sheet === undefined && rowShaped(e.name);
    case "call":
      // A row-scoped LOOKUP yields a per-row value, so it counts as
      // row-shaped itself even though LOOKUP is an aggregate name — that keeps
      // a LOOKUP keyed off another LOOKUP classifying as one per-row line.
      if (isRowScopedLookup(e, rowShaped)) return true;
      if (AGGREGATES.has(e.name)) return false;
      return e.args.some((a) => readsRowValue(a, rowShaped));
    case "bin":
      return readsRowValue(e.l, rowShaped) || readsRowValue(e.r, rowShaped);
    case "neg":
      return readsRowValue(e.e, rowShaped);
    default:
      return false;
  }
}

/** A LOOKUP call whose *key* argument is row-shaped: it evaluates
    once per row against the current row's cell, so it does not make its line a
    summary. Its key/value column arguments stay whole-column table refs. */
export function isRowScopedLookup(e: Expr, rowShaped: (ref: string) => boolean): boolean {
  return (
    e.k === "call" && e.name === "LOOKUP" && e.args.length > 0 && readsRowValue(e.args[0], rowShaped)
  );
}

// `rowShaped` (optional) enables the row-scope rule: pass it to have a
// LOOKUP with a row-shaped key classify as a computed column instead of a
// summary. Without it, every aggregate name makes the line a summary (v2 rule).
export function hasAggregate(e: Expr, rowShaped?: (ref: string) => boolean): boolean {
  const rec = (x: Expr) => hasAggregate(x, rowShaped);
  switch (e.k) {
    case "call":
      if (rowShaped && isRowScopedLookup(e, rowShaped)) return e.args.some(rec);
      return AGGREGATES.has(e.name) || e.args.some(rec);
    case "bin":
      return rec(e.l) || rec(e.r);
    case "neg":
      return rec(e.e);
    default:
      return false;
  }
}

/** Does the expression call `name` (already uppercased, as the parser stores
    call names) anywhere inside it? The summary bar asks this about `FX` so a
    sheet that never converts currency stops carrying a USD→EUR stamp under it. */
export function callsFunction(e: Expr, name: string): boolean {
  switch (e.k) {
    case "call":
      return e.name === name || e.args.some((a) => callsFunction(a, name));
    case "bin":
      return callsFunction(e.l, name) || callsFunction(e.r, name);
    case "neg":
      return callsFunction(e.e, name);
    default:
      return false;
  }
}

// All column names referenced anywhere in the expression (lowercased).
// Cross-sheet refs come out dotted: "holdings.total".
export function collectRefs(e: Expr, out: string[] = []): string[] {
  switch (e.k) {
    case "ref":
      out.push(e.sheet ? `${e.sheet}.${e.name}` : e.name);
      break;
    case "call":
      for (const a of e.args) collectRefs(a, out);
      break;
    case "bin":
      collectRefs(e.l, out);
      collectRefs(e.r, out);
      break;
    case "neg":
      collectRefs(e.e, out);
      break;
  }
  return out;
}

/** The columns a value *describes*, as opposed to every column it reads.
 *
 * Same walk as `collectRefs`, except that the conditional aggregates separate
 * their value column from their filters: `SUMIF(status, "open", value_eur)` is
 * a sum OF value_eur, filtered BY status — the criteria columns and the match
 * values are modifiers, not what the number is about (answered
 * Option A). `SUMIF(col, match)` sums col itself, so col is its own value
 * column. COUNTIF has no value column — it counts rows — so every filter
 * column it names describes it equally, while its match values still don't.
 * Every other call descends normally; evaluation keeps reading every ref.
 *
 * Used for totals-row placement: which column a summary sits under. */
export function describingRefs(e: Expr, out: string[] = []): string[] {
  switch (e.k) {
    case "ref":
      out.push(e.sheet ? `${e.sheet}.${e.name}` : e.name);
      break;
    case "call":
      if (e.name === "SUMIF" && e.args.length >= 2) {
        // evalAggregate sums args[2] when the extended form spells it, else
        // args[0]; the trailing (column, match) pairs are pure filters.
        describingRefs(e.args.length >= 3 ? e.args[2] : e.args[0], out);
      } else if (e.name === "COUNTIF" && e.args.length >= 2) {
        // COUNTIF(col, m, col2, m2, …): columns at the even positions.
        for (let i = 0; i < e.args.length; i += 2) describingRefs(e.args[i], out);
      } else {
        for (const a of e.args) describingRefs(a, out);
      }
      break;
    case "bin":
      describingRefs(e.l, out);
      describingRefs(e.r, out);
      break;
    case "neg":
      describingRefs(e.e, out);
      break;
  }
  return out;
}

export interface CrossRef {
  sheet: string;
  name: string;
}

// Cross-sheet references only, as { sheet, name } pairs (both lowercased).
export function collectCrossRefs(e: Expr, out: CrossRef[] = []): CrossRef[] {
  switch (e.k) {
    case "ref":
      if (e.sheet !== undefined) out.push({ sheet: e.sheet, name: e.name });
      break;
    case "call":
      for (const a of e.args) collectCrossRefs(a, out);
      break;
    case "bin":
      collectCrossRefs(e.l, out);
      collectCrossRefs(e.r, out);
      break;
    case "neg":
      collectCrossRefs(e.e, out);
      break;
  }
  return out;
}

/** One fact a formula will ask history for: a note path, a frontmatter key, and
    the day to read them as of. */
export interface HistoryRef {
  path: string;
  key: string;
  date: string;
}

/** Statically evaluate an expression that must not depend on any row, sheet or
    fact: literals, `TODAY()`, and date arithmetic over them (§3.1). Anything
    that reaches for a column or a fact errors against the empty scope and comes
    back null — which is exactly the "not statically resolvable" answer the
    prefetch needs. */
function staticValue(e: Expr, today: () => string): string | null {
  const v = evaluate(e, new Map(), () => null, today);
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}

/** Every (fact, day) pair an expression will look up, found without evaluating
    it (docs/time-travel-spec.md §3.1). This is the prefetch list: the engine is
    synchronous, so whatever `AT()` will ask for has to be fetched before
    evaluation starts, the same way `FX` rates are.

    The static-resolvability rule lives here and nowhere else: an `AT()` whose
    date, path or key can only be known per row contributes nothing to the list,
    and the cell reports "history not loaded yet" when it runs. That is the
    honest shape of the limit — `AT(bought, PROP(...))` is a later slice, not a
    silently wrong answer now. */
export function collectHistoryRefs(
  e: Expr,
  today: () => string = todayIso,
  out: HistoryRef[] = [],
  asOf: string | null = null
): HistoryRef[] {
  switch (e.k) {
    case "call": {
      if (e.name === "AT" && e.args.length === 2) {
        const date = staticValue(e.args[0], today);
        // nested AT: the inner date wins for its own body, matching evaluation
        collectHistoryRefs(e.args[1], today, out, isIsoDate(date ?? "") ? date : null);
        return out;
      }
      if (e.name === "PROP" && e.args.length === 2 && asOf !== null) {
        const path = staticValue(e.args[0], today)?.trim();
        const key = staticValue(e.args[1], today)?.trim();
        if (path && key) out.push({ path, key, date: asOf });
        return out;
      }
      for (const a of e.args) collectHistoryRefs(a, today, out, asOf);
      break;
    }
    case "bin":
      collectHistoryRefs(e.l, today, out, asOf);
      collectHistoryRefs(e.r, today, out, asOf);
      break;
    case "neg":
      collectHistoryRefs(e.e, today, out, asOf);
      break;
  }
  return out;
}

/** One sheet a formula will read a member off in the past tense. The member
    name is deliberately NOT part of it: reading `Holdings.total` as of a day
    means re-evaluating that whole sheet as it stood, so the unit the prefetch
    deals in is (sheet, day), and every member of it comes free. */
export interface HistorySheetRef {
  sheet: string;
  date: string;
}

/** Every (sheet, day) an expression will read a member off, found without
    evaluating it — the cross-sheet half of the prefetch list (§3.1, §3.2).
    Same static-resolvability rule as `collectHistoryRefs`: a date only a row
    knows collects nothing, and that cell reports history isn't loaded. */
export function collectHistorySheetRefs(
  e: Expr,
  today: () => string = todayIso,
  out: HistorySheetRef[] = [],
  asOf: string | null = null
): HistorySheetRef[] {
  switch (e.k) {
    case "ref":
      if (e.sheet !== undefined && asOf !== null) out.push({ sheet: e.sheet, date: asOf });
      break;
    case "call": {
      if (e.name === "AT" && e.args.length === 2) {
        const date = staticValue(e.args[0], today);
        collectHistorySheetRefs(e.args[1], today, out, isIsoDate(date ?? "") ? date : null);
        return out;
      }
      for (const a of e.args) collectHistorySheetRefs(a, today, out, asOf);
      break;
    }
    case "bin":
      collectHistorySheetRefs(e.l, today, out, asOf);
      collectHistorySheetRefs(e.r, today, out, asOf);
      break;
    case "neg":
      collectHistorySheetRefs(e.e, today, out, asOf);
      break;
  }
  return out;
}

// ---------- identifiers ----------

// Formula identifiers (column names, summary names, function names) are unicode
// letters, not ASCII: a vault may be German/English, so `Größe`, `März` and
// `价格` must be referenceable. The class is UAX#31-shaped — a letter or `_`
// to start, then letters, combining marks, numbers and `_`. Marks are in the
// continuation set so a decomposed umlaut (o + U+0308) stays one token instead
// of erroring mid-name. Digits still can't start a name (a column called `2024`
// stays unreferenceable — separate issue), so number literals stay unambiguous.
export const IDENT_START_SRC = "[\\p{L}_]";
export const IDENT_SRC = "[\\p{L}_][\\p{L}\\p{M}\\p{N}_]*";
const IDENT_START_RE = new RegExp(`^${IDENT_START_SRC}$`, "u");
const IDENT_HEAD_RE = new RegExp(`^${IDENT_SRC}`, "u");

// ---------- tokenizer ----------

// from/to are source offsets (renameRefs splices by position, keeping the
// user's spacing and quoting untouched).
type Tok =
  | { t: "num"; v: number; from: number; to: number }
  | { t: "str"; v: string; from: number; to: number }
  | { t: "ident"; v: string; from: number; to: number }
  | { t: "op"; v: string; from: number; to: number };

function tokenize(src: string): Tok[] | FErr {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:\d+\.?\d*|\.\d+)/.exec(src.slice(i));
      if (!m) return ferr(`bad number at ${i + 1}`);
      toks.push({ t: "num", v: parseFloat(m[0]), from: i, to: i + m[0].length });
      i += m[0].length;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = "";
      for (;;) {
        if (j >= src.length) return ferr("unterminated string");
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            out += '"';
            j += 2;
          } else break;
        } else {
          out += src[j];
          j++;
        }
      }
      toks.push({ t: "str", v: out, from: i, to: j + 1 });
      i = j + 1;
      continue;
    }
    // Test the whole code point, not src[i]: an astral letter is a surrogate
    // pair, and a lone surrogate matches no unicode letter class.
    if (IDENT_START_RE.test(String.fromCodePoint(src.codePointAt(i)!))) {
      const m = IDENT_HEAD_RE.exec(src.slice(i));
      if (!m) return ferr(`bad name at ${i + 1}`);
      toks.push({ t: "ident", v: m[0], from: i, to: i + m[0].length });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<>" || two === "<=" || two === ">=") {
      toks.push({ t: "op", v: two, from: i, to: i + 2 });
      i += 2;
      continue;
    }
    if ("+-*/(),=<>.".includes(c)) {
      toks.push({ t: "op", v: c, from: i, to: i + 1 });
      i++;
      continue;
    }
    return ferr(`unexpected character “${c}”`);
  }
  return toks;
}

// Rename whole-ident references in formula source, preserving all other
// formatting (spacing, quoting, comment-free as formulas are). Function names,
// string literals, and idents adjacent to a dot (sheet names and member names
// in cross-sheet refs) are left alone. Unparsable source comes back unchanged.
export function renameRefs(src: string, oldName: string, newName: string): string {
  const toks = tokenize(src);
  if (isErr(toks)) return src;
  const old = oldName.toLowerCase();
  let out = "";
  let pos = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== "ident" || t.v.toLowerCase() !== old) continue;
    const prev = toks[i - 1];
    const next = toks[i + 1];
    const dotted =
      (prev?.t === "op" && prev.v === ".") || (next?.t === "op" && next.v === ".");
    const call = next?.t === "op" && next.v === "(";
    if (dotted || call) continue;
    out += src.slice(pos, t.from) + newName;
    pos = t.to;
  }
  return out + src.slice(pos);
}

// ---------- parser (recursive descent) ----------

class Parser {
  pos = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  next(): Tok | undefined {
    return this.toks[this.pos++];
  }

  expectOp(v: string): FErr | null {
    const t = this.next();
    if (!t || t.t !== "op" || t.v !== v) return ferr(`expected “${v}”`);
    return null;
  }

  atOp(...vs: string[]): boolean {
    const t = this.peek();
    return !!t && t.t === "op" && vs.includes(t.v);
  }

  // comparison is non-associative: a < b < c is a syntax error
  parseExpr(): Expr | FErr {
    const l = this.parseAdditive();
    if (isErr(l)) return l;
    if (this.atOp("=", "<>", "<", ">", "<=", ">=")) {
      const op = (this.next() as { t: "op"; v: string }).v as BinOp;
      const r = this.parseAdditive();
      if (isErr(r)) return r;
      return { k: "bin", op, l, r };
    }
    return l;
  }

  parseAdditive(): Expr | FErr {
    let l = this.parseMultiplicative();
    if (isErr(l)) return l;
    while (this.atOp("+", "-")) {
      const op = (this.next() as { t: "op"; v: string }).v as BinOp;
      const r = this.parseMultiplicative();
      if (isErr(r)) return r;
      l = { k: "bin", op, l, r };
    }
    return l;
  }

  parseMultiplicative(): Expr | FErr {
    let l = this.parseUnary();
    if (isErr(l)) return l;
    while (this.atOp("*", "/")) {
      const op = (this.next() as { t: "op"; v: string }).v as BinOp;
      const r = this.parseUnary();
      if (isErr(r)) return r;
      l = { k: "bin", op, l, r };
    }
    return l;
  }

  parseUnary(): Expr | FErr {
    if (this.atOp("-")) {
      this.next();
      const e = this.parseUnary();
      if (isErr(e)) return e;
      return { k: "neg", e };
    }
    if (this.atOp("+")) this.next();
    return this.parsePrimary();
  }

  parsePrimary(): Expr | FErr {
    const t = this.next();
    if (!t) return ferr("unexpected end of formula");
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "str") {
      // "Quoted Sheet Name".member — cross-sheet ref whose name has spaces
      if (this.atOp(".")) return this.crossRef(t.v);
      return { k: "str", v: t.v };
    }
    if (t.t === "ident") {
      if (this.atOp("(")) {
        this.next();
        const args: Expr[] = [];
        if (!this.atOp(")")) {
          for (;;) {
            const a = this.parseExpr();
            if (isErr(a)) return a;
            args.push(a);
            if (this.atOp(",")) {
              this.next();
              continue;
            }
            break;
          }
        }
        const e = this.expectOp(")");
        if (e) return e;
        return { k: "call", name: t.v.toUpperCase(), args };
      }
      if (this.atOp(".")) return this.crossRef(t.v);
      return { k: "ref", name: t.v.toLowerCase() };
    }
    if (t.t === "op" && t.v === "(") {
      const e = this.parseExpr();
      if (isErr(e)) return e;
      const err = this.expectOp(")");
      if (err) return err;
      return e;
    }
    return ferr(`unexpected “${t.t === "op" ? t.v : ""}”`);
  }

  // Consumes ". member" after a sheet name (bare ident or quoted string).
  crossRef(sheet: string): Expr | FErr {
    this.next(); // the dot
    const m = this.next();
    if (!m || m.t !== "ident") return ferr(`expected a column or summary after “${sheet}.”`);
    return { k: "ref", sheet: sheet.toLowerCase(), name: m.v.toLowerCase() };
  }
}

export function parseFormula(src: string): Expr | FErr {
  const toks = tokenize(src);
  if (isErr(toks)) return toks;
  if (toks.length === 0) return ferr("empty formula");
  const p = new Parser(toks);
  const e = p.parseExpr();
  if (isErr(e)) return e;
  if (p.pos < toks.length) return ferr("trailing input after formula");
  return e;
}

// ---------- evaluator ----------

function asNum(v: ScopedValue, what: string): number | FErr {
  if (isErr(v)) return v;
  if (v === null) return 0; // Excel: empty cell is 0 in arithmetic
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    if (v.trim() === "") return 0;
    const n = parseStrictNumber(v);
    if (n !== null) return n;
  }
  return ferr(`${what} is not a number`);
}

function asBool(v: ScopedValue): boolean | FErr {
  if (isErr(v)) return v;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (v === null) return false;
  const t = v.trim().toLowerCase();
  if (t === "true") return true;
  if (t === "false" || t === "") return false;
  return ferr("not a condition");
}

// Date arithmetic on ISO day strings, on the local-day calendar the rest of
// the app uses (dates.ts does the math — no UTC-midnight pitfalls):
//   date ± days → date; date − date → whole days (signed). A fractional day
//   count truncates toward zero — day-granularity math has no time component
//   to carry a fraction. Returns null when neither side is a date, leaving
//   the plain numeric path (and its error messages) untouched.
function dateArith(op: "+" | "-", l: ScopedValue, r: ScopedValue): Value | null {
  const dl = typeof l === "string" && isIsoDate(l) ? l : null;
  const dr = typeof r === "string" && isIsoDate(r) ? r : null;
  if (dl === null && dr === null) return null;
  if (op === "+") {
    if (dl !== null && dr !== null) return ferr("can't add two dates");
    const n = asNum(dl !== null ? r : l, "day count");
    if (isErr(n)) return n;
    return shiftDate((dl ?? dr)!, Math.trunc(n));
  }
  if (dl !== null && dr !== null) return daysBetween(dr, dl);
  if (dl !== null) {
    const n = asNum(r, "day count");
    if (isErr(n)) return n;
    return shiftDate(dl, -Math.trunc(n));
  }
  return ferr("can't subtract a date from a number");
}

// Excel-ish equality: numeric when both sides are numbers, else case-insensitive text.
export function looseEq(a: ScopedValue, b: ScopedValue): boolean {
  if (isErr(a) || isErr(b)) return false;
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (typeof a === "number" && typeof b === "number") return a === b;
  const na = typeof a === "number" ? a : Number(String(a).trim());
  const nb = typeof b === "number" ? b : Number(String(b).trim());
  if (!isNaN(na) && !isNaN(nb) && String(a).trim() !== "" && String(b).trim() !== "") {
    return na === nb;
  }
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function compare(op: BinOp, l: ScopedValue, r: ScopedValue): Value {
  if (op === "=") return looseEq(l, r);
  if (op === "<>") return !looseEq(l, r);
  // a blank cell never satisfies an ordering comparison — without
  // this guard null skips the numeric path and "" sorts below every number,
  // so `IF(b<10,…)` fired on empty rows
  if (l === null || r === null) return false;
  const bothNum =
    (typeof l === "number" || !isNaN(Number(l))) &&
    (typeof r === "number" || !isNaN(Number(r)));
  if (bothNum) {
    const a = Number(l);
    const b = Number(r);
    return op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b;
  }
  const a = String(l ?? "").toLowerCase();
  const b = String(r ?? "").toLowerCase();
  return op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b;
}

// Numeric view of a column: errors propagate (SUM over a broken cell is
// broken, like Excel), text and blanks are skipped. String cells parse
// strictly — "1e3"/"Infinity" are text, they can't poison a SUM.
function numericCells(col: ScopedValue[]): number[] | FErr {
  const out: number[] = [];
  for (const c of col) {
    if (isErr(c)) return c;
    if (typeof c === "number") out.push(c);
    else if (typeof c === "string") {
      const n = parseStrictNumber(c);
      if (n !== null) out.push(n);
    }
  }
  return out;
}

// ---------- SUMIF/COUNTIF criteria ----------
//
// Excel-style comparison criteria: a *string* match argument that starts with
// >=, <=, <>, > or < compares instead of matching exactly (`">=1"`, `"<5"`,
// `"<>0"`). Everything else — numbers, booleans, plain strings — keeps the
// exact-match behaviour unchanged.
interface Criteria {
  op: "<" | ">" | "<=" | ">=" | "<>";
  raw: string;
  // operand as text, plus its strict numeric reading when it has one
  text: string;
  num: number | null;
}

const CRITERIA_RE = /^(<=|>=|<>|<|>)([\s\S]*)$/;

function parseCriteria(match: ScopedValue): Criteria | null {
  if (typeof match !== "string") return null;
  const m = CRITERIA_RE.exec(match.trim());
  if (!m) return null;
  const text = m[2].trim();
  return { op: m[1] as Criteria["op"], raw: match.trim(), text, num: parseStrictNumber(text) };
}

// One cell against one comparison criteria. Blank cells never satisfy a
// comparison (same rule as `compare`) — including `<>`, so a blank
// row can't silently join a `"<>0"` bucket. A numeric criteria over a
// non-numeric cell errors rather than guessing at a text ordering.
function matchesCriteria(cell: ScopedValue, c: Criteria, name: string): boolean | FErr {
  if (c.text === "") return ferr(`${name}: criteria “${c.raw}” has no value to compare against`);
  if (cell === null || (typeof cell === "string" && cell.trim() === "")) return false;
  if (c.op === "<>") return !looseEq(cell, c.num !== null ? c.num : c.text);
  if (c.num !== null) {
    const n =
      typeof cell === "number" ? cell : typeof cell === "string" ? parseStrictNumber(cell) : null;
    if (n === null) {
      return ferr(`${name}: criteria “${c.raw}” needs numbers, but the column has “${cell}”`);
    }
    return c.op === "<" ? n < c.num : c.op === ">" ? n > c.num : c.op === "<=" ? n <= c.num : n >= c.num;
  }
  const a = String(cell).toLowerCase();
  const b = c.text.toLowerCase();
  return c.op === "<" ? a < b : c.op === ">" ? a > b : c.op === "<=" ? a <= b : a >= b;
}

// ---------- SUMIF/COUNTIF wildcard criteria ----------
//
// Excel treats `*` (any run, including empty) and `?` (exactly one character)
// as wildcards in an exact-match criteria string, with `~` as the escape:
// `~*`, `~?` and `~~` are the literal characters. Only the exact-match path is
// affected — comparison criteria parse first and never reach here.
//
// A pattern that uses neither a wildcard nor an escape compiles to null and
// keeps the plain `looseEq` path, so ordinary matches (including their numeric
// loose equality) behave exactly as before.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileWildcard(pattern: string): RegExp | null {
  let src = "";
  let special = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    const next = pattern[i + 1];
    if (ch === "~" && (next === "*" || next === "?" || next === "~")) {
      src += escapeRegExp(next);
      i++;
      special = true;
      continue;
    }
    if (ch === "*" || ch === "?") {
      // [\s\S] rather than `.` so a newline inside a cell is an ordinary character
      src += ch === "*" ? "[\\s\\S]*" : "[\\s\\S]";
      special = true;
      continue;
    }
    src += escapeRegExp(ch);
  }
  return special ? new RegExp(`^${src}$`, "i") : null;
}

// Blank cells never match a pattern — without this guard
// `"*"` would count every empty row. Matching is case-insensitive, like looseEq.
function wildcardMatch(cell: ScopedValue, re: RegExp): boolean {
  if (cell === null || isErr(cell)) return false;
  if (typeof cell === "string" && cell.trim() === "") return false;
  return re.test(String(cell));
}

function evalAggregate(
  name: string,
  args: Expr[],
  scope: Scope,
  fx: FxResolver,
  today: () => string,
  hist?: HistoryResolver
): Value {
  const colArg = (e: Expr | undefined, what: string): ScopedValue[] | FErr => {
    if (!e) return ferr(`${name}: missing ${what}`);
    // In row scope a bare column name resolves to this row's cell, so a
    // row-scoped LOOKUP over a same-sheet table (`LOOKUP(cur, code, rate)`)
    // would see scalars where it needs columns. The whole-column view bound
    // under ROW_COLUMNS_PREFIX supplies them; it is absent in summary scope
    // (where names already resolve to columns), so nothing else changes.
    // That view holds TODAY's column, so inside `AT()` it must not answer at
    // all: `AT(2026-01-01, SUM(amount))` would otherwise hand back the current
    // total with a past date on it — the exact quiet wrong answer the bare-ref
    // branch of `evaluate` refuses. Fall through to that refusal.
    if (e.k === "ref" && e.sheet === undefined && hist?.asOfDate === undefined) {
      const col = scope.get(ROW_COLUMNS_PREFIX + e.name);
      if (Array.isArray(col)) return col;
    }
    const v = evaluate(e, scope, fx, today, hist);
    if (isErr(v)) return v;
    if (!Array.isArray(v)) return ferr(`${name}: ${what} must be a column`);
    return v;
  };
  switch (name) {
    case "SUM":
    case "AVG":
    case "MIN":
    case "MAX":
    case "COUNT": {
      const col = colArg(args[0], "column");
      if (isErr(col)) return col;
      const ns = numericCells(col);
      if (isErr(ns)) return ns;
      if (name === "COUNT") return ns.length;
      if (name === "SUM") return ns.reduce((a, b) => a + b, 0);
      if (ns.length === 0) return ferr(`${name}: no numeric values`);
      if (name === "AVG") return ns.reduce((a, b) => a + b, 0) / ns.length;
      if (name === "MIN") return Math.min(...ns);
      return Math.max(...ns);
    }
    case "LAST": {
      // Last non-empty cell in stored row order, returned as-is (number,
      // string, boolean — no coercion). "Empty" follows typedCell: null, or a
      // string that trims to "". Error cells propagate like every other
      // aggregate; an all-empty column errors like MAX over an empty set.
      const col = colArg(args[0], "column");
      if (isErr(col)) return col;
      let last: Value | null = null;
      for (const c of col) {
        if (isErr(c)) return c;
        if (c === null || (typeof c === "string" && c.trim() === "")) continue;
        last = c;
      }
      return last === null ? ferr(`${name}: no non-empty values`) : last;
    }
    case "SUMPRODUCT": {
      // Row-wise product across every argument column, summed — the
      // weighted average is `SUMPRODUCT(v, w) / SUMPRODUCT(w)` with no helper
      // column. Coercion follows Excel rather than numericCells' skip rule:
      // a row whose cells aren't all numeric contributes 0 (a blank weight
      // means "no weight", not "drop the row"), while an error cell in any
      // argument propagates like every other aggregate. Columns must be the
      // same length — money math never silently truncates to the shortest.
      if (args.length === 0) return ferr(`${name}: missing column`);
      const cols: ScopedValue[][] = [];
      for (const a of args) {
        const col = colArg(a, "column");
        if (isErr(col)) return col;
        if (cols.length > 0 && col.length !== cols[0].length) {
          return ferr(
            `${name}: columns have different lengths (${cols[0].length} vs ${col.length})`
          );
        }
        cols.push(col);
      }
      let total = 0;
      for (let i = 0; i < cols[0].length; i++) {
        let product = 1;
        let numeric = true;
        // no early exit: an error cell anywhere in the row still propagates,
        // even when an earlier column already zeroed the row
        for (const col of cols) {
          const cell = col[i];
          if (isErr(cell)) return cell;
          const n =
            typeof cell === "number"
              ? cell
              : typeof cell === "string"
                ? parseStrictNumber(cell)
                : null;
          if (n === null) numeric = false;
          else product *= n;
        }
        if (numeric) total += product;
      }
      return total;
    }
    case "SUMIF":
    case "COUNTIF": {
      // Multi-criteria: extra (column, match) pairs append after the
      // existing args — COUNTIF(col, m, col2, m2, …), SUMIF(col, m, valueCol,
      // col2, m2, …) — and every pair must hit for a row to count (AND).
      // SUMIF's extended form always spells the value column, so the pair
      // sequence starts at a fixed offset instead of being position-guessed.
      if (args.length < 2) {
        const col0 = colArg(args[0], "criteria column");
        if (isErr(col0)) return col0;
        return ferr(`${name}: missing match value`);
      }
      const pairStart = name === "SUMIF" && args.length >= 3 ? 3 : 2;
      if ((args.length - pairStart) % 2 !== 0) {
        return ferr(
          `${name}: extra criteria come in column/match pairs — ` +
            `${name}(column, match${name === "SUMIF" ? ", valueColumn" : ""}, column2, match2, …)`
        );
      }
      // Each pair carries its column, its match value, the parsed comparison
      // criteria when the match is ">=1"-shaped (null = exact match), and the
      // compiled wildcard pattern when an exact-match string uses `*`/`?`
      // (null = plain looseEq).
      const pairs: {
        col: ScopedValue[];
        match: ScopedValue;
        crit: Criteria | null;
        wild: RegExp | null;
      }[] = [];
      const readPair = (colExpr: Expr | undefined, matchExpr: Expr, what: string): FErr | null => {
        const c = colArg(colExpr, what);
        if (isErr(c)) return c;
        const m = evaluate(matchExpr, scope, fx, today, hist);
        if (isErr(m)) return m;
        if (Array.isArray(m)) return ferr(`${name}: match must be a single value`);
        // Criteria columns are ANDed row by row, so a length mismatch has no
        // honest reading — error rather than silently dropping the tail rows.
        if (pairs.length > 0 && c.length !== pairs[0].col.length) {
          return ferr(
            `${name}: criteria columns must have the same number of rows ` +
              `(${pairs[0].col.length} vs ${c.length})`
          );
        }
        const crit = parseCriteria(m);
        pairs.push({
          col: c,
          match: m,
          crit,
          wild: crit === null && typeof m === "string" ? compileWildcard(m) : null,
        });
        return null;
      };
      const first = readPair(args[0], args[1], "criteria column");
      if (first) return first;
      for (let i = pairStart; i < args.length; i += 2) {
        const e = readPair(args[i], args[i + 1], "criteria column");
        if (e) return e;
      }
      // rowHit(): AND across every pair. An error cell in a criteria column is
      // returned as-is, which SUMIF propagates and COUNTIF filters out first.
      const rowHit = (i: number): boolean | FErr => {
        for (const p of pairs) {
          const cell = p.col[i] ?? null;
          if (isErr(cell)) return cell;
          const h = p.crit
            ? matchesCriteria(cell, p.crit, name)
            : p.wild
              ? wildcardMatch(cell, p.wild)
              : looseEq(cell, p.match);
          if (isErr(h)) return h;
          if (!h) return false;
        }
        return true;
      };
      const rows = pairs[0].col.length;
      if (name === "COUNTIF") {
        let n = 0;
        for (let i = 0; i < rows; i++) {
          // unchanged: an error cell simply doesn't count
          if (pairs.some((p) => isErr(p.col[i] ?? null))) continue;
          const h = rowHit(i);
          if (isErr(h)) return h;
          if (h) n++;
        }
        return n;
      }
      // SUMIF(col, match) sums col itself; SUMIF(col, match, valueCol) sums valueCol.
      const vals = args.length >= 3 ? colArg(args[2], "value column") : pairs[0].col;
      if (isErr(vals)) return vals;
      // Rows pair off criteria against values, so a length mismatch has no
      // honest reading here either — reachable via a cross-sheet value column,
      // where an overhang would silently read as blank rows summing to 0.
      if (vals.length !== rows) {
        return ferr(
          `${name}: value column must have the same number of rows as the ` +
            `criteria column (${rows} vs ${vals.length})`
        );
      }
      let sum = 0;
      for (let i = 0; i < rows; i++) {
        const h = rowHit(i);
        if (isErr(h)) return h;
        if (!h) continue;
        const cell = vals[i] ?? null;
        if (isErr(cell)) return cell;
        const n = asNum(cell, "SUMIF value");
        if (!isErr(n)) sum += n;
      }
      return sum;
    }
    case "LOOKUP": {
      // LOOKUP(key, keyColumn, valueColumn) — first row (stored order) whose
      // keyColumn matches `key`, that row's valueColumn cell, as-is. Both
      // columns may be data or computed, and either may come from another
      // sheet (`LOOKUP("USD", Rates.code, Rates.rate)`) — cross-sheet refs
      // resolve to columns in scope, so nothing here is sheet-aware.
      if (args.length < 3) return ferr(`${name}: needs a key, a key column and a value column`);
      const key = evaluate(args[0], scope, fx, today, hist);
      if (isErr(key)) return key;
      if (Array.isArray(key)) return ferr(`${name}: key must be a single value`);
      const keys = colArg(args[1], "key column");
      if (isErr(keys)) return keys;
      const vals = colArg(args[2], "value column");
      if (isErr(vals)) return vals;
      const blank = (c: ScopedValue): boolean =>
        c === null || (typeof c === "string" && c.trim() === "");
      // A blank key never matches (same rule as `compare`/criteria),
      // so an empty rates cell can't quietly become the row everything hits.
      if (blank(key)) return ferr(`${name}: key is empty`);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (isErr(k)) return k; // a broken key column errors, never mismatches
        if (blank(k)) continue;
        if (!looseEq(k, key)) continue;
        const cell = vals[i] ?? null;
        if (isErr(cell)) return cell;
        // A matched row with no value is an error, not 0: silently zeroing a
        // missing FX rate is exactly the money bug LOOKUP exists to prevent.
        if (cell === null || (typeof cell === "string" && cell.trim() === "")) {
          return ferr(`${name}: row matching “${key}” has an empty value`);
        }
        return cell;
      }
      return ferr(`${name}: no row where the key column matches “${key}”`);
    }
    default:
      return ferr(`unknown function ${name}`);
  }
}

/** Turn one resolver answer into a cell or an error (docs/time-travel-spec.md
    §2.3). A fact that did not exist yet is blank — the language's skip value —
    while a date the vault genuinely cannot speak for says so in the cell rather
    than reading as a blank or a zero, and a path with no note behind it today
    is an error naming the path so a typo can't pass for "not yet". */
function historyCell(
  fn: string,
  path: string,
  date: string | null,
  got: HistoryLookup
): ScopedValue {
  switch (got.kind) {
    case "value": {
      // value-typed, not number-typed: text comes back as text and arithmetic
      // over it errors exactly like arithmetic over any other text cell
      const n = parseStrictNumber(got.value);
      return n === null ? got.value : n;
    }
    case "absent":
      return null;
    case "unknowable":
      return ferr(
        got.oldest ? `no history before ${got.oldest}` : "no history in this vault yet"
      );
    case "unknown-note":
      return ferr(`${fn}: no note at “${path}”`);
    case "pending":
      return ferr(date ? `${fn}: history not loaded yet` : `${fn}: note not loaded yet`);
  }
}

// `today` is the clock seam for volatile TODAY(): a () → ISO-day provider,
// defaulting to the app's local-day clock. One evaluation network shares one
// clock; tests inject their own.
export function evaluate(
  e: Expr,
  scope: Scope,
  fx: FxResolver,
  today: () => string = todayIso,
  hist?: HistoryResolver
): ScopedValue | ScopedValue[] {
  switch (e.k) {
    case "num":
      return e.v;
    case "str":
      return e.v;
    case "ref": {
      const key = e.sheet ? `${e.sheet}.${e.name}` : e.name;
      // Inside `AT()` a scope value is still today's number — the sheet was
      // computed from today's tables. A member off ANOTHER sheet can be carried
      // back, by re-evaluating that sheet as it stood (§3.2); the current
      // sheet's own rows and summaries cannot, so they refuse and say which
      // name it is. Answering those from today's scope would be the quiet wrong
      // answer a time-travel query exists to avoid. The cross-sheet case is
      // decided before the scope lookup because the historical read does not
      // need today's binding to exist at all.
      if (hist?.asOfDate !== undefined && e.sheet !== undefined) {
        if (!hist.sheetValue) return ferr(`AT: “${key}” — sheet history is not loaded yet`);
        return hist.sheetValue(e.sheet, e.name, hist.asOfDate);
      }
      const v = scope.get(key);
      if (v === undefined) {
        return ferr(e.sheet ? `unknown sheet value “${key}”` : `unknown column “${e.name}”`);
      }
      if (hist?.asOfDate !== undefined) {
        return ferr(`AT: “${key}” is today's value — only PROP() can be read as of a past date`);
      }
      return v;
    }
    case "neg": {
      const v = evaluate(e.e, scope, fx, today, hist);
      if (isErr(v)) return v;
      if (Array.isArray(v)) return ferr("cannot negate a column");
      const n = asNum(v, "value");
      if (isErr(n)) return n;
      return -n;
    }
    case "bin": {
      const l = evaluate(e.l, scope, fx, today, hist);
      if (isErr(l)) return l;
      const r = evaluate(e.r, scope, fx, today, hist);
      if (isErr(r)) return r;
      if (Array.isArray(l) || Array.isArray(r)) {
        return ferr("a whole column can't be used as a single value");
      }
      switch (e.op) {
        case "+":
        case "-":
        case "*":
        case "/": {
          if (e.op === "+" || e.op === "-") {
            const d = dateArith(e.op, l, r);
            if (d !== null) return d;
          }
          const a = asNum(l, "left side");
          if (isErr(a)) return a;
          const b = asNum(r, "right side");
          if (isErr(b)) return b;
          if (e.op === "+") return a + b;
          if (e.op === "-") return a - b;
          if (e.op === "*") return a * b;
          if (b === 0) return ferr("division by zero");
          return a / b;
        }
        default:
          return compare(e.op, l, r);
      }
    }
    case "call": {
      if (AGGREGATES.has(e.name)) return evalAggregate(e.name, e.args, scope, fx, today, hist);
      if (!SCALAR_FNS.has(e.name)) return ferr(`unknown function ${e.name}`);
      const arg = (i: number): Cell | FErr => {
        const a = e.args[i];
        if (!a) return ferr(`${e.name}: missing argument ${i + 1}`);
        const v = evaluate(a, scope, fx, today, hist);
        if (isErr(v)) return v;
        if (Array.isArray(v)) return ferr(`${e.name}: argument ${i + 1} must be a single value`);
        return v;
      };
      switch (e.name) {
        case "IF": {
          if (e.args.length < 2) return ferr("IF: needs condition and value");
          const cond = evaluate(e.args[0], scope, fx, today, hist);
          if (isErr(cond)) return cond;
          if (Array.isArray(cond)) return ferr("IF: condition must be a single value");
          const b = asBool(cond);
          if (isErr(b)) return b;
          // lazy: only the taken branch is evaluated
          const branch = b ? e.args[1] : e.args[2];
          if (!branch) return false;
          const v = evaluate(branch, scope, fx, today, hist);
          if (Array.isArray(v)) return ferr("IF: branch must be a single value");
          return v;
        }
        case "ROUND": {
          const x = arg(0);
          if (isErr(x)) return x;
          const n = arg(1);
          if (isErr(n)) return n;
          const xv = asNum(x, "ROUND value");
          if (isErr(xv)) return xv;
          const nv = asNum(n, "ROUND digits");
          if (isErr(nv)) return nv;
          const d = Math.max(-15, Math.min(15, Math.trunc(nv)));
          // Shift the decimal point in decimal (exponential-notation) space,
          // not binary-float space: 1.005 * 100 is 100.49999… as a double,
          // but "1.005e2" parses to exactly 100.5 — the half cases land right.
          // Excel rounds half away from zero.
          const [coef, exp] = Math.abs(xv).toExponential().split("e");
          const shifted = Number(`${coef}e${Number(exp) + d}`);
          // a value too large to shift has no fractional digits left anyway
          if (!Number.isFinite(shifted)) return xv;
          const [rc, re] = Math.round(shifted).toExponential().split("e");
          return Math.sign(xv) * Number(`${rc}e${Number(re) - d}`);
        }
        case "FX": {
          const from = arg(0);
          if (isErr(from)) return from;
          const to = arg(1);
          if (isErr(to)) return to;
          const f = String(from).toUpperCase();
          const t = String(to).toUpperCase();
          if (f === t) return 1;
          const rate = fx(f, t);
          if (rate === null || !isFinite(rate)) return ferr(`no FX rate for ${f}→${t}`);
          return rate;
        }
        case "TODAY": {
          // Volatile: the clock is re-read on every evaluation. The engine
          // keeps no state across evaluateSheet calls, so a sheet's TODAY()
          // is recomputed whenever the sheet is (re)loaded and on every edit
          // — the rule docs/sheets-spec.md documents.
          if (e.args.length > 0) return ferr("TODAY: takes no arguments");
          return today();
        }
        case "PROP": {
          // A frontmatter key on another note, as a scalar
          // (docs/time-travel-spec.md §3.2). Present tense on its own; inside
          // `AT()` the injected resolver is the one that carries the as-of day,
          // so nothing here needs to know which tense it is being read in.
          if (e.args.length !== 2) return ferr("PROP: needs a note path and a key");
          const p = arg(0);
          if (isErr(p)) return p;
          const k = arg(1);
          if (isErr(k)) return k;
          const path = String(p ?? "").trim();
          const key = String(k ?? "").trim();
          if (!path) return ferr("PROP: needs a note path");
          if (!key) return ferr("PROP: needs a frontmatter key");
          if (!hist) return ferr("PROP: note data is not available here");
          return historyCell("PROP", path, null, hist(path, key, null));
        }
        case "AT": {
          // Reads its body as of the end of one past day (§3.2). The date binds
          // by *wrapping the resolver*, not by a parameter every function would
          // have to carry: everything inside the body keeps reading facts the
          // way it always does, and the resolver it reads through is the one
          // that knows which day it is. Nested `AT()` therefore just wraps
          // again — the innermost one wins, which is what reading it aloud
          // suggests.
          if (e.args.length !== 2) return ferr("AT: needs a date and a value");
          const d = arg(0); // the date is read in the present tense, deliberately
          if (isErr(d)) return d;
          const date = String(d ?? "").trim();
          if (!isIsoDate(date)) {
            return ferr(`AT: “${date}” is not a date — use YYYY-MM-DD or TODAY()`);
          }
          if (!hist) return ferr("AT: history is not available here");
          // Bind from the *unwrapped* resolver: wrapping a wrapper would leave
          // the outer day in charge of the inner body, and a nested `AT()`
          // would silently read the wrong year.
          const base = hist.unbound ?? hist;
          const asOf: HistoryResolver = (p, k) => base(p, k, date);
          asOf.asOfDate = date;
          asOf.unbound = base;
          asOf.sheetValue = base.sheetValue;
          const v = evaluate(e.args[1], scope, fx, today, asOf);
          if (Array.isArray(v)) return ferr("AT: value must be a single value");
          return v;
        }
      }
      return ferr(`unknown function ${e.name}`);
    }
  }
}
