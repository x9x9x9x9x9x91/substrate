// Sheet model: a note body with a ```csv fence (data) and a ```formulas fence
// (computed columns + named summaries). The grid UI and metrics dashboards are
// views over this; the note text stays the source of truth.
// Pure TS, no DOM/node imports: runs in the app and under `node --test`.

import { parseStrictNumber } from "./aggregate.ts";
import { todayIso } from "./dates.ts";
import {
  collectCrossRefs,
  collectRefs,
  evaluate,
  ferr,
  hasAggregate,
  IDENT_SRC,
  isErr,
  parseFormula,
  renameRefs,
  ROW_COLUMNS_PREFIX,
  type Cell,
  type Expr,
  type FErr,
  type FxResolver,
  type Scope,
  type ScopedValue,
  type Value,
} from "./formula.ts";

// Formula-line name matchers, built from the tokenizer's identifier class so a
// unicode column name (`Größe`, `märz_total`) parses the same everywhere.
const FORMULA_LINE_RE = new RegExp(`^(${IDENT_SRC})\\s*=\\s*([\\s\\S]+)$`, "u");
const FORMULA_NAME_RE = new RegExp(`^${IDENT_SRC}$`, "u");
const FORMULA_LHS_RE = new RegExp(`^\\s*(${IDENT_SRC})\\s*=`, "u");
const FORMULA_LINE_PARTS_RE = new RegExp(
  `^(\\s*)(${IDENT_SRC})(\\s*=\\s*)([\\s\\S]*?)\\s*$`,
  "u"
);

export interface FormulaLine {
  name: string;
  src: string; // right-hand side source text
  expr: Expr | FErr;
  aggregate: boolean;
}

export interface SheetModel {
  headers: string[];
  rows: string[][]; // raw string cells, padded to headers.length
  formulas: FormulaLine[];
  errors: string[]; // unparsable formula lines + folded-name collisions
  hasCsv: boolean;
}

export interface SheetEval {
  headers: string[];
  rows: Cell[][]; // typed data cells
  computed: { name: string; cells: Value[] }[];
  summaries: { name: string; value: Value }[];
  /** Folded names two things bind to → the message every reference gets
      instead of data (SUB-751). Kept on the eval so a *reader* sheet can see
      this sheet's ambiguity too (SUB-756); keyed by folded (lowercased) name. */
  collisions: Map<string, string>;
}

export interface Fence {
  from: number;
  to: number;
  inner: string;
}

// The closing ``` must sit on its own line — at the start of a line or at the
// very end of the body — and outside a quoted cell: a ``` inside a quoted CSV
// cell is data, not the end of the fence. CRLF is tolerated after the opening
// fence. Quotes follow CSV rules ("" is an escaped quote); formula strings
// can't span lines, so quote state resets per line outside the csv fence.
export function findFence(body: string, lang: string): Fence | null {
  const open = "```" + lang;
  const multiline = lang === "csv";
  let from = body.indexOf(open);
  while (from >= 0) {
    let innerStart = from + open.length;
    if (body.startsWith("\r\n", innerStart)) innerStart += 2;
    else if (body[innerStart] === "\n") innerStart += 1;
    else {
      from = body.indexOf(open, from + 1); // "```csv" mentioned mid-prose
      continue;
    }
    let fallback = -1; // first closing-shaped ```, quote state ignored
    let inQuotes = false;
    for (let i = innerStart; i < body.length; ) {
      const c = body[i];
      if (c === '"') {
        if (inQuotes && body[i + 1] === '"') i += 2;
        else {
          inQuotes = !inQuotes;
          i++;
        }
        continue;
      }
      const closing =
        c === "`" &&
        body.startsWith("```", i) &&
        (body[i - 1] === "\n" || i + 3 === body.length);
      if (closing) {
        if (fallback < 0) fallback = i;
        if (!inQuotes) return { from, to: i + 3, inner: body.slice(innerStart, i) };
        i += 3;
        continue;
      }
      if (c === "\n" && !multiline) inQuotes = false;
      i++;
    }
    // No quote-balanced closing fence (unclosed-quote content): take the first
    // closing-shaped ``` anyway, else look for a later opening fence.
    if (fallback >= 0) return { from, to: fallback + 3, inner: body.slice(innerStart, fallback) };
    from = body.indexOf(open, from + 1);
  }
  return null;
}

// ---------- CSV ----------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  // Excel and Google Sheets prefix their CSV exports with a UTF-8 BOM. It is
  // invisible, but it lands before the first cell's opening quote — and the
  // rule below (a quote only opens at cell start) then reads that quote as
  // literal text, so a quoted first header keeps its quotes and, if it holds
  // a comma, splits: every column after it shifts by one and the import lands
  // wrong while reporting success.
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        cell += c;
        i++;
      }
    } else if (c === '"' && cell === "") {
      // RFC 4180: a quote only opens a quoted cell at cell start. A bare quote
      // mid-cell (`12" single`) is literal text — treating it as an opener
      // swallowed every following comma and newline into one cell, and the
      // next save baked that row fusion into the note.
      inQuotes = true;
      i++;
    } else if (c === ",") {
      endCell();
      i++;
    } else if (c === "\n") {
      endRow();
      i++;
    } else if (c === "\r") {
      i++; // tolerate CRLF
    } else {
      cell += c;
      i++;
    }
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

export function serializeCsv(rows: string[][]): string {
  // Backticks are escaped too (SUB-681): findFence ends the csv fence at the
  // first line-initial ``` that is outside CSV quote state, so a cell written
  // verbatim as ```… would truncate the fence at that data line — every row
  // below it, the closing fence, and the following prose fall out of the model
  // and the next save bakes the loss in. Quoting any cell holding a backtick
  // keeps the scanner reading it as data (it is inside quotes) and costs
  // nothing but two quote characters.
  const esc = (c: string) => (/[",\n\r`]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c);
  return rows.map((r) => r.map(esc).join(",")).join("\n");
}

// ---------- model ----------

export function typedCell(raw: string): Cell {
  if (raw.trim() === "") return null;
  // strict parse (SUB-221): "1e3"/"0x10"/"Infinity" stay text, not numbers
  const n = parseStrictNumber(raw);
  return n !== null ? n : raw;
}

export function parseSheet(body: string): SheetModel {
  const csv = findFence(body, "csv");
  const rows = csv ? parseCsv(csv.inner) : [];
  const headers = rows.length > 0 ? rows[0].map((h) => h.trim()) : [];
  const data = rows.slice(1).map((r) => {
    const out = r.slice(0, headers.length);
    while (out.length < headers.length) out.push("");
    return out;
  });

  const formulas: FormulaLine[] = [];
  const errors: string[] = [];
  const ff = findFence(body, "formulas");
  if (ff) {
    // A line is a summary when its right side uses an aggregate function or
    // references nothing row-shaped — i.e. only cross-sheet values and other
    // summaries (`net = total - Cash.cash_total` is a summary, not a per-row
    // column). A constant-only right side (`ceiling = 25000`, `annual = 2500 * 12`)
    // references nothing at all and is a summary too (SUB-715): as a computed
    // column it repeated the same value down every row and couldn't be bound
    // from a dashboard as a single value. Classification is order-independent:
    // scan every line first, then iterate to a fixpoint. A line referencing a
    // summary defined later in the fence still classifies as a summary; a line
    // touching anything row-shaped (a data column or a computed column,
    // wherever defined) stays a data row.
    const parsed: { name: string; src: string; expr: Expr | FErr }[] = [];
    for (const rawLine of ff.inner.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const m = FORMULA_LINE_RE.exec(line);
      if (!m) {
        errors.push(`can't parse formula line: ${line}`);
        continue;
      }
      parsed.push({ name: m[1], src: m[2], expr: parseFormula(m[2]) });
    }
    // A bare (non-dotted) reference that isn't a summary is row-shaped: a data
    // column or a computed column. Used by the SUB-748 rule — a LOOKUP whose
    // *key* is row-shaped evaluates per row, so it doesn't make its line a
    // summary. summaryNames only grows across the fixpoint, so this predicate
    // only ever turns lines into summaries, never back.
    const summaryNames = new Set<string>();
    const rowShaped = (r: string) => !r.includes(".") && !summaryNames.has(r);
    for (let changed = true; changed; ) {
      changed = false;
      for (const p of parsed) {
        const key = p.name.toLowerCase();
        if (isErr(p.expr) || summaryNames.has(key)) continue;
        const refs = collectRefs(p.expr);
        if (
          hasAggregate(p.expr, rowShaped) ||
          refs.every((r) => r.includes(".") || summaryNames.has(r))
        ) {
          summaryNames.add(key);
          changed = true;
        }
      }
    }
    for (const p of parsed) {
      formulas.push({
        name: p.name,
        src: p.src,
        expr: p.expr,
        aggregate: summaryNames.has(p.name.toLowerCase()),
      });
    }
  }
  for (const msg of foldedCollisions(headers, formulas.map((f) => f.name)).values()) {
    errors.push(msg);
  }
  return { headers, rows: data, formulas, errors, hasCsv: csv !== null };
}

// ---------- folded-name collisions (SUB-751) ----------

/** Every name in a sheet binds case-insensitively — `PRICE` and `price` are
    one name — but nothing used to check whether two *different* names fold
    together. They did bind together: the later one overwrote the earlier in
    scope, so `x = price * 2` computed off the second `PRICE` column and
    `SUM(price)` summed it, with the first column still sitting visibly in the
    grid. Wrong numbers, no error, nothing to notice.

    An ambiguous name is not resolvable by guessing which one was meant, so the
    engine refuses to guess: the folded name is reported here (into
    `SheetModel.errors`, which the grid shows) and every reference to it
    evaluates to that same message instead of to data. Three shapes collide —
    two data columns, two formula lines, or a formula named like a column.
    The cross-sheet member precedence (summary > computed > data) is a rule for
    *different* names on other sheets and is untouched — but an ambiguous name
    is refused there too (SUB-756), see `memberValue`. Data cells always keep
    rendering: a vault note that already
    holds a collision still loads and shows its rows, errors and all. */
function foldedCollisions(headers: string[], formulaNames: string[]): Map<string, string> {
  // Blank headers never take part: they bind nothing referenceable anyway.
  const counts = new Map<string, { cols: number; fx: number }>();
  const order: string[] = [];
  const at = (name: string) => {
    const k = name.trim().toLowerCase();
    let c = counts.get(k);
    if (!c) {
      c = { cols: 0, fx: 0 };
      counts.set(k, c);
      order.push(k);
    }
    return c;
  };
  for (const h of headers) if (h.trim() !== "") at(h).cols++;
  for (const n of formulaNames) at(n).fx++;

  const out = new Map<string, string>();
  for (const k of order) {
    const c = counts.get(k)!;
    if (c.cols + c.fx < 2) continue;
    const n = (x: number) => (x === 2 ? "two" : x === 3 ? "three" : String(x));
    out.set(
      k,
      c.cols > 0 && c.fx > 0
        ? `“${k}” is both a column and a formula name — rename one`
        : c.cols > 1
          ? `${n(c.cols)} columns fold to “${k}” — rename one`
          : `${n(c.fx)} formulas fold to “${k}” — rename one`
    );
  }
  return out;
}

// ---------- evaluation ----------

// Loads another sheet's model by name (title/stem, case-insensitive).
// Return an FErr for "no such note" / "not a sheet" — it becomes the value of
// every reference to that sheet and propagates Excel-style.
export type SheetLoader = (name: string) => SheetModel | FErr;

// Cycle-safe resolution context shared across one network of sheets.
interface CrossCtx {
  stack: string[]; // lowercased names currently being evaluated
  cache: Map<string, SheetEval | FErr>;
  load: SheetLoader;
}

const COL_AS_VALUE = "a whole column can't be used as a single value";

function resolveSheet(
  ctx: CrossCtx,
  fx: FxResolver,
  sheet: string,
  today: () => string
): SheetEval | FErr {
  const l = sheet.toLowerCase();
  const hit = ctx.cache.get(l);
  if (hit) return hit;
  let out: SheetEval | FErr;
  if (ctx.stack.includes(l)) {
    out = ferr(`circular sheet reference: ${[...ctx.stack, l].join(" → ")}`);
  } else {
    const m = ctx.load(sheet);
    if (isErr(m)) out = m;
    else {
      ctx.stack.push(l);
      out = evalSheetInner(m, fx, ctx, today);
      ctx.stack.pop();
    }
  }
  ctx.cache.set(l, out);
  return out;
}

// A member off another sheet: summary first, then computed column, then data
// column (same precedence as a sheet's own summary scope).
function memberValue(ev: SheetEval, sheet: string, name: string): ScopedValue | ScopedValue[] {
  const s = ev.summaries.find((s) => s.name.toLowerCase() === name);
  if (s) return s.value;
  const cc = ev.computed.find((c) => c.name.toLowerCase() === name);
  if (cc) return cc.cells;
  // An ambiguous name on the *other* sheet is ambiguous here too (SUB-756).
  // Summaries and computed columns already carry their own collision error, so
  // they answer honestly above; a data column doesn't — without this, two
  // headers folding to one name would hand back whichever came first.
  const amb = ev.collisions.get(name.trim().toLowerCase());
  if (amb) return ferr(amb);
  const h = ev.headers.findIndex((h) => h.toLowerCase() === name);
  if (h >= 0) return ev.rows.map((r) => r[h] ?? null);
  return ferr(`no column or summary “${name}” on sheet “${sheet}”`);
}

export function evaluateSheet(
  model: SheetModel,
  fx: FxResolver,
  cross?: { self: string; load: SheetLoader },
  today: () => string = todayIso
): SheetEval {
  const ctx: CrossCtx | null = cross
    ? { stack: [cross.self.toLowerCase()], cache: new Map(), load: cross.load }
    : null;
  return evalSheetInner(model, fx, ctx, today);
}

function evalSheetInner(
  model: SheetModel,
  fxResolver: FxResolver,
  ctx: CrossCtx | null,
  today: () => string
): SheetEval {
  const rows: Cell[][] = model.rows.map((r) => r.map(typedCell));
  const computed: { name: string; cells: Value[] }[] = [];
  const summaries: { name: string; value: Value }[] = [];

  // Names two things fold onto (SUB-751). Bound over every scope below, after
  // the real bindings, so an ambiguous name resolves to its own error instead
  // of to whichever binding happened to land last — and a line whose own name
  // is ambiguous carries that error as its value, since nothing can address it.
  const collisions = foldedCollisions(
    model.headers,
    model.formulas.map((f) => f.name)
  );
  const collisionOf = (name: string): FErr | null => {
    const msg = collisions.get(name.trim().toLowerCase());
    return msg ? ferr(msg) : null;
  };
  // The scalar error binding is what every reference site wants: arithmetic
  // propagates it, and an aggregate's column argument propagates it too rather
  // than reporting the generic "whole column" misuse. The ROW_COLUMNS_PREFIX
  // view a row-scoped LOOKUP's table arguments read has to be overwritten as
  // well, or it would still hand back one of the colliding columns' data.
  const bindCollisions = (scope: Scope) => {
    for (const [k, msg] of collisions) {
      const e = ferr(msg);
      scope.set(k, e);
      scope.set(ROW_COLUMNS_PREFIX + k, rows.map(() => e));
    }
  };

  // Cross-sheet bindings: "sheet.name" → summary scalar or whole column.
  // Bound once per referenced member and visible in both row and summary
  // scope; columns misused as scalars are caught by the guards below.
  const crossBindings: [string, ScopedValue | ScopedValue[]][] = [];
  if (ctx) {
    const seen = new Set<string>();
    for (const f of model.formulas) {
      if (isErr(f.expr)) continue;
      for (const cr of collectCrossRefs(f.expr)) {
        const key = `${cr.sheet}.${cr.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ev = resolveSheet(ctx, fxResolver, cr.sheet, today);
        crossBindings.push([key, isErr(ev) ? ev : memberValue(ev, cr.sheet, cr.name)]);
      }
    }
  }
  const bindCross = (scope: Scope) => {
    for (const [k, v] of crossBindings) scope.set(k, v);
  };

  // Whole-column view of this sheet's own columns, keyed under a prefix no
  // parsed reference can produce. Grows left-to-right with the computed
  // columns, so a row-scoped LOOKUP sees exactly the columns already defined
  // before its line — the same visibility rule row scope has always had.
  const rowColumns: Map<string, ScopedValue[]> = new Map();
  model.headers.forEach((h, c) =>
    rowColumns.set(ROW_COLUMNS_PREFIX + h.toLowerCase(), rows.map((r) => r[c] ?? null))
  );

  // Row scope: data columns as scalars + earlier computed columns. Computed
  // columns see only columns defined before them (left-to-right, Notion-style).
  for (const f of model.formulas) {
    if (f.aggregate) continue;
    // A line whose own name is ambiguous can't be addressed at all, so its
    // cells carry the collision rather than a value nothing can read.
    const own = collisionOf(f.name);
    const cells: Value[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (own) {
        cells.push(own);
        continue;
      }
      if (isErr(f.expr)) {
        cells.push(f.expr);
        continue;
      }
      const scope: Scope = new Map();
      model.headers.forEach((h, c) => scope.set(h.toLowerCase(), rows[i][c] ?? null));
      for (const cc of computed) scope.set(cc.name.toLowerCase(), cc.cells[i] ?? null);
      // Whole-column view alongside the row values (SUB-748): only a row-scoped
      // LOOKUP's table arguments read it, so a same-sheet rates table works
      // per row while every other name still resolves to this row's cell.
      for (const [k, col] of rowColumns) scope.set(k, col);
      bindCross(scope);
      bindCollisions(scope);
      const v = evaluate(f.expr, scope, fxResolver, today);
      cells.push(Array.isArray(v) ? ferr(COL_AS_VALUE) : (v as Value));
    }
    computed.push({ name: f.name, cells });
    rowColumns.set(ROW_COLUMNS_PREFIX + f.name.toLowerCase(), cells);
  }

  // Summary scope: every column as a whole array; earlier summaries are
  // available as scalars so `net = total - crypto` works.
  const summaryScope: Scope = new Map();
  model.headers.forEach((h, c) =>
    summaryScope.set(h.toLowerCase(), rows.map((r) => r[c] ?? null))
  );
  for (const cc of computed) summaryScope.set(cc.name.toLowerCase(), cc.cells);
  bindCross(summaryScope);
  bindCollisions(summaryScope);

  for (const f of model.formulas) {
    if (!f.aggregate) continue;
    const own = collisionOf(f.name);
    if (own || isErr(f.expr)) {
      summaries.push({ name: f.name, value: own ?? (f.expr as FErr) });
      continue;
    }
    const v = evaluate(f.expr, summaryScope, fxResolver, today);
    const value = Array.isArray(v) ? ferr(COL_AS_VALUE) : (v as Value);
    summaries.push({ name: f.name, value });
    // A colliding name keeps its collision error in scope — a later summary
    // must not overwrite the ambiguity it caused with its own value.
    if (!isErr(value) && !own) summaryScope.set(f.name.toLowerCase(), value);
  }

  return { headers: model.headers, rows, computed, summaries, collisions };
}

export function findSummary(ev: SheetEval, name: string): Value | FErr {
  const s = ev.summaries.find((s) => s.name.toLowerCase() === name.toLowerCase());
  return s ? s.value : ferr(`no summary “${name}” on this sheet`);
}

// ---------- display ----------

/** Columns whose integers are labels, not quantities (SUB-633). A year or an
 * id is a name made of digits: grouping it renders 2026 as "2.026", and in
 * de-DE the dot IS the thousands separator, so it reads as a different
 * number entirely (the shipped Work Index sheet showed its year column as
 * 2.026/2.025/2.024).
 *
 * Sheets carry no schema, so the header name is the only signal available —
 * and it is deliberately the ONLY one: no value-range guessing, so a money
 * or size column can never lose its grouping by accident. Matches `year`
 * (plus `jahr`/`yr`) outright and a trailing id/no/nr token (`order_id`,
 * `invoice no`, `job nr`). Applies to integers only — a decimal in such a
 * column still formats de-DE. */
function isLabelColumn(header: string): boolean {
  const h = header.trim().toLowerCase();
  return /^(year|jahr|yr)$/.test(h) || /(^|[\s_.-])(id|no|nr)$/.test(h);
}

/** The one grid-wide number format (SUB-282: de-DE like every other surface):
 * dot thousands grouping, comma decimals; fractional values show exactly
 * 2 decimals, integers stay bare (1.234 — never 1.234,00).
 *
 * Two exceptions drop the grouping for integers (SUB-633), because a number
 * that is really a name — a year, a port, a catalogue number — reads as a
 * different number once grouped: de-DE writes 2026 as "2.026", and the dot
 * IS the thousands separator.
 *
 * 1. Four-digit integers, always. This is where identifiers live (years,
 *    ports, PLZ, catalogue numbers), grouping one four-digit number buys no
 *    legibility at all, and DIN 5008 already lets four-digit numbers go
 *    unseparated — so a genuine four-digit quantity loses nothing either.
 *    It needs no header, so it fixes columns whatever they are called.
 * 2. Any integer in a label column (see isLabelColumn), which extends the
 *    same treatment to longer identifiers — `order_id` 48211, not "48.211".
 *    Header-name-driven and never value-driven, so a money or size column
 *    can't lose its grouping by accident.
 *
 * Five-digit-and-up quantities and all fractional values keep de-DE
 * grouping. Display-only: editing seeds from and writes back the raw csv
 * strings, so this output is never re-parsed. */
export function formatNum(v: number, header?: string): string {
  if (Number.isInteger(v)) {
    const plain =
      Math.abs(v) < 10000 || (header !== undefined && isLabelColumn(header));
    return plain ? String(v) : v.toLocaleString("de-DE", { maximumFractionDigits: 0 });
  }
  return v.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** `header` is the column the value renders under, when there is one — the
 * grid passes it so id columns skip thousands grouping past four digits.
 * Headerless callers (summary cards, metrics tiles) still get the four-digit
 * rule; only the header-driven half of formatNum needs the name. */
export function formatValue(v: Value | Cell, header?: string): string {
  if (v === null || v === undefined) return "";
  if (isErr(v)) return "!";
  if (typeof v === "number") return formatNum(v, header);
  if (typeof v === "boolean") return v ? "true" : "false";
  return v;
}

export function errMessage(v: unknown): string | null {
  return isErr(v) ? v.err : null;
}

// ---------- body edit ops (preserve everything outside the csv fence) ----------

// also the shared write idiom of the fence-owning panes (food log, food DB)
export function replaceCsvRows(body: string, rows: string[][]): string {
  const fence = findFence(body, "csv");
  const inner = "```csv\n" + serializeCsv(rows) + "\n```";
  if (!fence) {
    return body.trimEnd() + (body.trim() ? "\n\n" : "") + inner + "\n";
  }
  return body.slice(0, fence.from) + inner + body.slice(fence.to);
}

// Mutations work on the RAW parsed csv, not the model: the model pads/truncates
// rows to the header width for evaluation, so serializing it back would silently
// delete the extra cells of any ragged row (hand-edited or pasted CSV). Splice
// only what changed; every other row keeps its exact cell count.

export function setSheetCell(body: string, rowIdx: number, colIdx: number, value: string): string {
  const fence = findFence(body, "csv");
  if (!fence) return body;
  const rows = parseCsv(fence.inner);
  const headers = rows.length > 0 ? rows[0] : [];
  if (rowIdx < 0 || rowIdx >= rows.length - 1) return body;
  if (colIdx < 0 || colIdx >= headers.length) return body;
  const row = rows[rowIdx + 1];
  while (row.length <= colIdx) row.push("");
  row[colIdx] = value;
  return replaceCsvRows(body, rows);
}

export function addSheetRow(body: string): string {
  const fence = findFence(body, "csv");
  if (!fence) return body;
  const rows = parseCsv(fence.inner);
  const headers = rows.length > 0 ? rows[0] : [];
  if (headers.length === 0) return body;
  return replaceCsvRows(body, [...rows, headers.map(() => "")]);
}

export function addSheetColumn(body: string, name: string): string {
  const col = name.trim();
  if (!FORMULA_NAME_RE.test(col)) return body;
  const fence = findFence(body, "csv");
  const rows = fence ? parseCsv(fence.inner) : [];
  const headers = rows.length > 0 ? rows[0] : [];
  if (headers.some((h) => h.trim().toLowerCase() === col.toLowerCase())) return body;
  if (headers.length === 0) return replaceCsvRows(body, [[col]]);
  // Short rows pad to the new width; a ragged row's first extra cell simply
  // becomes visible under the new column (data surfaces, never shifts or drops).
  const width = headers.length;
  const next = [
    [...headers, col],
    ...rows.slice(1).map((r) => {
      const out = [...r];
      while (out.length < width + 1) out.push("");
      return out;
    }),
  ];
  return replaceCsvRows(body, next);
}

/** Delete one data row (0-based, header excluded). Ragged rows elsewhere
    keep their exact cell counts — only the deleted row leaves. */
export function deleteSheetRow(body: string, rowIdx: number): string {
  const fence = findFence(body, "csv");
  if (!fence) return body;
  const rows = parseCsv(fence.inner);
  if (rowIdx < 0 || rowIdx >= rows.length - 1) return body;
  return replaceCsvRows(body, rows.filter((_, i) => i !== rowIdx + 1));
}

/** Swap one data row with its neighbor (dir -1 = up, +1 = down). */
export function moveSheetRow(body: string, rowIdx: number, dir: -1 | 1): string {
  const fence = findFence(body, "csv");
  if (!fence) return body;
  const rows = parseCsv(fence.inner);
  const a = rowIdx + 1;
  const b = a + dir;
  if (rowIdx < 0 || a >= rows.length || b < 1 || b >= rows.length) return body;
  const next = [...rows];
  [next[a], next[b]] = [next[b], next[a]];
  return replaceCsvRows(body, next);
}

/** Delete a data column by header name. Each row loses only that cell —
    a ragged row's trailing extras keep their positions relative to the
    surviving columns. Refusing the last column keeps the grid alive; the
    empty state's "+ column" is the way back from zero anyway. */
export function deleteSheetColumn(body: string, name: string): string {
  const fence = findFence(body, "csv");
  if (!fence) return body;
  const rows = parseCsv(fence.inner);
  const headers = rows.length > 0 ? rows[0] : [];
  const c = headers.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase());
  if (c === -1 || headers.length <= 1) return body;
  return replaceCsvRows(
    body,
    rows.map((r) => r.filter((_, i) => i !== c))
  );
}

/** Swap a data column with its neighbor (dir -1 = left, +1 = right). Rows
    shorter than either index pad first so cells travel with their column. */
export function moveSheetColumn(body: string, name: string, dir: -1 | 1): string {
  const fence = findFence(body, "csv");
  if (!fence) return body;
  const rows = parseCsv(fence.inner);
  const headers = rows.length > 0 ? rows[0] : [];
  const a = headers.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase());
  const b = a + dir;
  if (a === -1 || b < 0 || b >= headers.length) return body;
  const hi = Math.max(a, b);
  return replaceCsvRows(
    body,
    rows.map((row) => {
      const out = [...row];
      while (out.length <= hi) out.push("");
      [out[a], out[b]] = [out[b], out[a]];
      return out;
    })
  );
}

/** Split fence contents into editable lines. findFence's inner always ends
    with the newline before the closing ```, so a plain split leaves a
    trailing empty element; re-joining with a "\n" of our own would add a
    blank line on every edit. Drop that one artifact — interior blanks the
    user wrote stay. */
function splitFenceLines(inner: string): string[] {
  const lines = inner.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Remove one formula line (a computed column or summary). Other lines —
    comments, blanks, formulas that may now error — stay byte-identical;
    a dangling reference surfaces as a visible formula error, never a
    silent rewrite. */
export function deleteSheetFormula(body: string, name: string): string {
  const ff = findFence(body, "formulas");
  if (!ff) return body;
  const target = name.trim().toLowerCase();
  const lines = splitFenceLines(ff.inner);
  const keep = lines.filter((raw) => {
    const m = FORMULA_LHS_RE.exec(raw);
    return !(m && m[1].toLowerCase() === target);
  });
  if (keep.length === lines.length) return body;
  const inner = "```formulas\n" + keep.join("\n") + "\n```";
  return body.slice(0, ff.from) + inner + body.slice(ff.to);
}

// ---------- formula fence editing ----------

// Update one formula line: rename its left side and/or replace its right side.
// A rename also rewrites references on every other line (renameRefs keeps
// string literals, function names, and other sheets' members untouched).
// No-op when the line is missing, the new name is invalid or collides with a
// data column or another formula, or the new right side is empty.
export function updateSheetFormula(
  body: string,
  oldName: string,
  newName: string,
  newSrc: string
): string {
  const ff = findFence(body, "formulas");
  if (!ff) return body;
  const name = newName.trim();
  const src = newSrc.trim();
  if (!FORMULA_NAME_RE.test(name) || !src) return body;
  const model = parseSheet(body);
  const old = oldName.toLowerCase();
  if (!model.formulas.some((f) => f.name.toLowerCase() === old)) return body;
  const clash =
    model.headers.some((h) => h.toLowerCase() === name.toLowerCase()) ||
    model.formulas.some(
      (f) => f.name.toLowerCase() !== old && f.name.toLowerCase() === name.toLowerCase()
    );
  if (clash) return body;
  const target = model.formulas.find((f) => f.name.toLowerCase() === old)!;
  const renaming = name !== target.name;
  const lines = splitFenceLines(ff.inner).map((raw) => {
    const m = FORMULA_LINE_PARTS_RE.exec(raw);
    if (!m) return raw; // comments, blanks, unparsable lines stay untouched
    if (m[2].toLowerCase() === old) return `${m[1]}${name}${m[3]}${src}`;
    return renaming ? m[1] + m[2] + m[3] + renameRefs(m[4], oldName, name) : raw;
  });
  const inner = "```formulas\n" + lines.join("\n") + "\n```";
  return body.slice(0, ff.from) + inner + body.slice(ff.to);
}
