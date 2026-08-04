// Calc lines (SUB-834) — a note line that starts with `=` computes, and the
// answer renders beside it without ever being written to the document.
// Pure TS, no DOM/node imports: runs in the app and under `node --test`.
// Keep to erasable TS syntax only (no enums/namespaces) so node can strip types.
//
// Deliberate fork from formula.ts: this is a second, smaller expression engine
// rather than an extension of the sheet one. formula.ts evaluates over Cells
// (number | string | boolean) and its tokenizer rejects `€`, `$`, unit
// suffixes and `3.9M` outright; teaching it quantities would change the value
// type every sheet call-site reads. So the ~150 lines of Pratt parsing below
// are duplicated on purpose, over Quantity instead of Cell. What IS shared:
// the FErr/FxResolver vocabulary, the IDENT rules, and every unit and number
// primitive in units.ts/aggregate.ts. A later unification (SUB-825) would
// merge the two evaluators; until then formula.ts stays sheets-owned.

import { normalizeNumberInput, parseStrictNumber } from "./aggregate.ts";
import { IDENT_SRC, ferr, isErr, type FErr, type FxResolver } from "./formula.ts";
import { convert, formatQuantity, parseQuantity, resolveUnit, type Quantity } from "./units.ts";

export type NumberStyle = "de" | "intl";

/** One line's answer. `display` is always renderable — the quiet dash when the
    line didn't work out — and `err` carries the reason for a hover title. */
export interface CalcResult {
  display: string;
  err?: string;
}

/** What a failed line shows: a dim dash, never a red wall. */
export const CALC_ERR_DISPLAY = "–";

// ---------- line shape ----------

// A calc line is `=` at the start, with at most 3 leading spaces — markdown's
// own threshold for a block start, which keeps a 4-space-indented `= 1 + 1`
// (a code block to every other reader) out of the engine.
const CALC_LINE_RE = /^ {0,3}=(.*)$/;
// `===` under a heading is a setext underline, not arithmetic; a lone `=` is
// someone mid-keystroke. Neither should sprout a dash.
const SETEXT_OR_EMPTY_RE = /^=*$/;
// list markers a numeric line may wear: "- 12", "* 12", "1. 12", "2) 12"
const LIST_MARKER_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/;
// `= name: expr` — the binding prefix, identifiers per formula.ts
const BINDING_RE = new RegExp(`^\\s*(${IDENT_SRC})\\s*:\\s*(.*)$`, "u");
// trailing `in <unit>` — the postfix conversion of the whole expression
const IN_UNIT_RE = /^(.*?)\s+in\s+([^\s]+)\s*$/iu;

/** Is this line a calc line at all? Cheap enough for a per-line scan. */
export function isCalcLine(text: string): boolean {
  const m = CALC_LINE_RE.exec(text);
  return m !== null && !SETEXT_OR_EMPTY_RE.test(m[1].trim());
}

/** Line indexes (0-based) inside ``` fences, fence markers included. Calc runs
    on raw text, so it needs its own answer to "is this line code?" rather than
    the editor's syntax tree — the tree is only parsed for the viewport. */
export function fencedLines(lines: string[]): Set<number> {
  const out = new Set<number>();
  let open: { marker: "`" | "~"; length: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (open) {
      out.add(i);
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(lines[i]);
      if (
        close &&
        close[1][0] === open.marker &&
        close[1].length >= open.length
      ) {
        open = null;
      }
      continue;
    }
    const start = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!start) continue;
    // CommonMark forbids a backtick in a backtick fence's info string.
    if (start[1][0] === "`" && start[2].includes("`")) continue;
    open = {
      marker: start[1][0] as "`" | "~",
      length: start[1].length,
    };
    out.add(i);
  }
  return out;
}

/** Whether a body contains a calc line Markdown will actually render as
    prose. Used to keep ordinary notes from activating the shared FX source. */
export function hasExecutableCalcLine(body: string): boolean {
  const lines = body.split("\n");
  const fenced = fencedLines(lines);
  return lines.some((line, i) => !fenced.has(i) && isCalcLine(line));
}

// ---------- tokenizer ----------

type Tok =
  | { t: "qty"; v: Quantity }
  | { t: "ident"; v: string }
  | { t: "op"; v: string };

// A number head in either dialect — the digits, dots and commas together;
// normalizeNumberInput/parseStrictNumber settle which dialect it was.
const NUM_HEAD_RE = /^(?:[0-9][0-9.,]*|\.[0-9]+)/;
// k/M/B immediately after a number and NOT followed by another letter, so
// "12k" is twelve thousand while "12kB" stays twelve kilobytes.
const SHORTHAND_RE = /^([kKMB])(?![\p{L}])/u;
const SHORTHAND: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, B: 1e9 };
// a trailing unit word: letters, a bare percent, or a currency symbol
const UNIT_WORD_RE = /^(?:%|[€$£¥]|\p{L}+)/u;
const IDENT_HEAD_RE = new RegExp(`^${IDENT_SRC}`, "u");
const CURRENCY_SYMBOL_RE = /^[€$£¥]/u;

function readNumber(text: string): number | null {
  return parseStrictNumber(normalizeNumberInput(text));
}

function tokenize(src: string): Tok[] | FErr {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }

    // "$25" / "€ 1.234,56" — a symbol may lead its number
    if (CURRENCY_SYMBOL_RE.test(c)) {
      const rest = src.slice(i + 1).replace(/^[ \t]*/, "");
      const head = NUM_HEAD_RE.exec(rest);
      const unit = resolveUnit(c);
      if (!head || !unit) return ferr(`unexpected “${c}”`);
      const consumed = src.length - rest.length + head[0].length;
      const value = readNumber(head[0]);
      if (value === null) return ferr(`bad number “${head[0]}”`);
      toks.push({ t: "qty", v: { value, unit: unit.code } });
      i = consumed;
      continue;
    }

    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const head = NUM_HEAD_RE.exec(src.slice(i))!;
      let value = readNumber(head[0]);
      if (value === null) return ferr(`bad number “${head[0]}”`);
      i += head[0].length;
      const shorthand = SHORTHAND_RE.exec(src.slice(i));
      if (shorthand) {
        value *= SHORTHAND[shorthand[1]];
        i += 1;
      }
      // a unit may follow, with or without a space ("5 kg", "5kg", "25USD").
      // A word that names no unit is left for the parser to trip over rather
      // than swallowed — "5 furlongs" has no honest reading as 5.
      const after = src.slice(i);
      const spaced = after.replace(/^[ \t]*/, "");
      const word = UNIT_WORD_RE.exec(spaced);
      let unit: string | null = null;
      if (word) {
        const def = resolveUnit(word[0]);
        if (def) {
          unit = def.code;
          i += after.length - spaced.length + word[0].length;
        }
      }
      toks.push({ t: "qty", v: { value, unit } });
      continue;
    }

    const ident = IDENT_HEAD_RE.exec(src.slice(i));
    if (ident) {
      toks.push({ t: "ident", v: ident[0] });
      i += ident[0].length;
      continue;
    }

    if ("+-*/()".includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    return ferr(`unexpected character “${c}”`);
  }
  return toks;
}

// ---------- arithmetic over quantities ----------

/** A bare number takes on its partner's unit in + and -: `100 € + 19` is 119 €,
    the reading every calculator app of this shape gives it. Two real units
    must still agree on dimension. */
function addSub(op: "+" | "-", l: Quantity, r: Quantity, fx: FxResolver): Quantity | FErr {
  const sign = op === "+" ? 1 : -1;
  if (l.unit === null && r.unit === null) return { value: l.value + sign * r.value, unit: null };
  if (r.unit === null) return { value: l.value + sign * r.value, unit: l.unit };
  if (l.unit === null) return { value: l.value + sign * r.value, unit: r.unit };
  const converted = convert(r, l.unit, fx);
  if (isErr(converted)) return converted;
  return { value: l.value + sign * converted, unit: l.unit };
}

function mul(l: Quantity, r: Quantity): Quantity | FErr {
  if (l.unit !== null && r.unit !== null) {
    return ferr(`can't multiply ${l.unit} by ${r.unit}`);
  }
  return { value: l.value * r.value, unit: l.unit ?? r.unit };
}

function div(l: Quantity, r: Quantity, fx: FxResolver): Quantity | FErr {
  if (r.value === 0) return ferr("division by zero");
  if (r.unit === null) return { value: l.value / r.value, unit: l.unit };
  if (l.unit === null) return ferr(`can't divide a plain number by ${r.unit}`);
  // same dimension → the units cancel and the answer is a ratio
  const converted = convert(r, l.unit, fx);
  if (isErr(converted)) return converted;
  if (converted === 0) return ferr("division by zero");
  return { value: l.value / converted, unit: null };
}

// ---------- parser + evaluator (single pass) ----------

/** Variable scope: lowercased name → its value. Bound top-down by the doc. */
export type CalcScope = Map<string, Quantity>;

class Evaluator {
  pos = 0;
  private toks: Tok[];
  private scope: CalcScope;
  private fx: FxResolver;
  constructor(toks: Tok[], scope: CalcScope, fx: FxResolver) {
    this.toks = toks;
    this.scope = scope;
    this.fx = fx;
  }

  peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  atOp(...vs: string[]): boolean {
    const t = this.peek();
    return !!t && t.t === "op" && vs.includes(t.v);
  }

  run(): Quantity | FErr {
    const v = this.additive();
    if (isErr(v)) return v;
    const rest = this.peek();
    if (rest) return ferr(rest.t === "op" ? `unexpected “${rest.v}”` : "unexpected extra input");
    return v;
  }

  additive(): Quantity | FErr {
    const first = this.multiplicative();
    if (isErr(first)) return first;
    let acc: Quantity = first;
    while (this.atOp("+", "-")) {
      const op = (this.toks[this.pos++] as { t: "op"; v: string }).v as "+" | "-";
      const r = this.multiplicative();
      if (isErr(r)) return r;
      const out = addSub(op, acc, r, this.fx);
      if (isErr(out)) return out;
      acc = out;
    }
    return acc;
  }

  multiplicative(): Quantity | FErr {
    const first = this.unary();
    if (isErr(first)) return first;
    let acc: Quantity = first;
    while (this.atOp("*", "/")) {
      const op = (this.toks[this.pos++] as { t: "op"; v: string }).v;
      const r = this.unary();
      if (isErr(r)) return r;
      const out = op === "*" ? mul(acc, r) : div(acc, r, this.fx);
      if (isErr(out)) return out;
      acc = out;
    }
    return acc;
  }

  unary(): Quantity | FErr {
    if (this.atOp("-")) {
      this.pos++;
      const e = this.unary();
      if (isErr(e)) return e;
      return { value: -e.value, unit: e.unit };
    }
    if (this.atOp("+")) this.pos++;
    return this.primary();
  }

  primary(): Quantity | FErr {
    const t = this.toks[this.pos++];
    if (!t) return ferr("unfinished expression");
    if (t.t === "qty") return t.v;
    if (t.t === "ident") {
      const v = this.scope.get(t.v.toLowerCase());
      // Forward references land here too: scope only holds what earlier lines
      // bound, so a name defined below reads as unknown rather than as 0.
      return v ?? ferr(`unknown name “${t.v}”`);
    }
    if (t.v === "(") {
      const e = this.additive();
      if (isErr(e)) return e;
      const close = this.toks[this.pos++];
      if (!close || close.t !== "op" || close.v !== ")") return ferr("expected “)”");
      return e;
    }
    return ferr(`unexpected “${t.v}”`);
  }
}

/** Evaluate one expression against a scope. Exported for tests and for any
    caller that already knows it holds an expression (no `=`, no binding). */
export function evalExpression(src: string, scope: CalcScope, fx: FxResolver): Quantity | FErr {
  const toks = tokenize(src);
  if (isErr(toks)) return toks;
  if (toks.length === 0) return ferr("nothing to compute");
  return new Evaluator(toks, scope, fx).run();
}

// ---------- line aggregates ----------

type AggKind = "sum" | "avg" | "count";

/** The contiguous run of quantity lines directly above `index`, nearest first.
    Stops at the first line that is empty or doesn't parse as a quantity —
    including another calc line, which never parses as one. */
function runAbove(lines: string[], index: number, skipped: Set<number>): Quantity[] {
  const out: Quantity[] = [];
  for (let i = index - 1; i >= 0; i--) {
    if (skipped.has(i)) break;
    const raw = lines[i];
    if (raw.trim() === "") break;
    const q = parseQuantity(raw.replace(LIST_MARKER_RE, ""));
    if (!q) break;
    out.push(q);
  }
  return out.reverse();
}

function aggregate(kind: AggKind, run: Quantity[], fx: FxResolver): Quantity | FErr {
  if (kind === "count") return { value: run.length, unit: null };
  if (run.length === 0) return ferr("no numbers directly above this line");
  // The first line of the run sets the unit; the rest convert into it, so a
  // column of mixed currencies sums in whatever the top row was typed in.
  const unit = run[0].unit;
  let total = run[0].value;
  for (let i = 1; i < run.length; i++) {
    const q = run[i];
    if (unit === null) {
      if (q.unit !== null) return ferr(`can't add ${q.unit} to a plain number`);
      total += q.value;
      continue;
    }
    if (q.unit === null) {
      total += q.value;
      continue;
    }
    const converted = convert(q, unit, fx);
    if (isErr(converted)) return converted;
    total += converted;
  }
  return { value: kind === "avg" ? total / run.length : total, unit };
}

// ---------- the document pass ----------

interface ParsedLine {
  /** lowercased variable name this line binds, if any */
  bind?: string;
  /** bare sum/avg/count, if that's what the line is */
  agg?: AggKind;
  /** the expression source (empty for a bare aggregate) */
  expr: string;
  /** trailing `in <unit>` target, canonical code */
  into?: string;
}

function parseCalcLine(text: string): ParsedLine | null {
  const m = CALC_LINE_RE.exec(text);
  if (!m) return null;
  let body = m[1].trim();
  if (SETEXT_OR_EMPTY_RE.test(body)) return null;

  const out: ParsedLine = { expr: "" };
  const bound = BINDING_RE.exec(body);
  if (bound) {
    out.bind = bound[1].toLowerCase();
    body = bound[2].trim();
  }

  const into = IN_UNIT_RE.exec(body);
  if (into) {
    const def = resolveUnit(into[2]);
    // "5 kg in lb" converts; "the note is in progress" isn't a conversion, so
    // an unknown target is left in the expression to fail on its own terms.
    if (def) {
      out.into = def.code;
      body = into[1].trim();
    }
  }

  const bare = body.toLowerCase();
  if (bare === "sum" || bare === "avg" || bare === "count") {
    out.agg = bare;
    return out;
  }
  out.expr = body;
  return out;
}

/** Evaluate every calc line in a document, top-down, sharing one variable
    scope. Only calc lines appear in the result — a prose line has no entry,
    so the caller never has to ask twice.
 *
 *  Whole-doc by nature: a `sum` reads the lines above it and a variable read
 *  depends on every line before it, so there is no honest viewport-scoped
 *  version of this. Notes are small (a long one is a few hundred lines) and
 *  each line is one regex plus a short token walk, so the editor recomputes
 *  per update rather than caching a dependency graph.
 *
 *  `skipped` marks lines the caller wants ignored — fenced code, most of all.
 *  They neither compute nor bind, and they stop an aggregate's run. */
export function evalCalcDoc(
  lines: string[],
  fx: FxResolver,
  style: NumberStyle,
  skipped: Set<number> = new Set()
): Map<number, CalcResult> {
  const results = new Map<number, CalcResult>();
  const scope: CalcScope = new Map();

  for (let i = 0; i < lines.length; i++) {
    if (skipped.has(i)) continue;
    const parsed = parseCalcLine(lines[i]);
    if (!parsed) continue;

    let value: Quantity | FErr = parsed.agg
      ? aggregate(parsed.agg, runAbove(lines, i, skipped), fx)
      : evalExpression(parsed.expr, scope, fx);

    if (!isErr(value) && parsed.into) {
      const converted = convert(value, parsed.into, fx);
      value = isErr(converted) ? converted : { value: converted, unit: parsed.into };
    }

    if (isErr(value)) {
      results.set(i, { display: CALC_ERR_DISPLAY, err: value.err });
      continue;
    }
    if (parsed.bind) scope.set(parsed.bind, value);
    results.set(i, { display: formatQuantity(value.value, value.unit, style) });
  }
  return results;
}
