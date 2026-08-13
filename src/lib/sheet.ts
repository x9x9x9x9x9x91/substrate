// Sheet model: a note body with a ```csv fence (data) and a ```formulas fence
// (computed columns + named summaries). The grid UI and metrics dashboards are
// views over this; the note text stays the source of truth.
// Pure TS, no DOM/node imports: runs in the app and under `node --test`.

import { parseStrictNumber } from "./aggregate.ts";
import { todayIso } from "./dates.ts";
import type { HistorySheetSnapshot } from "./history-facts.ts";
import { numberLocale } from "./numberLocale.ts";
import {
  callsFunction,
  collectCrossRefs,
  collectHistoryRefs,
  collectHistorySheetRefs,
  collectRefs,
  describingRefs,
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
  type HistoryRef,
  type HistoryResolver,
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
  /** Which blank-line-separated block of the fence this line sits in, 0-based.
      The summary bar reads it for hierarchy: the first block that
      holds summaries is the headline, later ones collapse. A run of blank
      lines is one separator, and blanks before the first formula line bind to
      block 0 — so an empty block never exists and a fence with no blank lines
      is one block, exactly as before. Comments and unparsable lines never open
      a block; they neither start one nor break one. */
  group: number;
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
  /** `group` is the formula line's block in the fence (FormulaLine.group) —
      the summary bar's hierarchy, carried here so a reader doesn't have to
      re-parse the note. */
  summaries: { name: string; value: Value; group: number }[];
  /** Folded names two things bind to → the message every reference gets
      instead of data. Kept on the eval so a *reader* sheet can see
      this sheet's ambiguity too; keyed by folded (lowercased) name. */
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

// An unterminated quote consumes the rest of the text: once a cell opens a
// quote and never closes it, commas and newlines are literal content, so every
// row below fuses into that one cell. Quote state only opens on a `"` at the
// START of a cell (see the in-cell rule below), so a stray quote mid-cell is
// harmless. Known and accepted — the writers here are machine-appended logs
// and serializeCsv, which never emit an unterminated quote — but it is why a
// stray `"` at the start of a cell in a hand-edited sheet truncates the table
// from that point down.
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
  // Backticks are escaped too: findFence ends the csv fence at the
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
  // strict parse: "1e3"/"0x10"/"Infinity" stay text, not numbers
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
    // references nothing at all and is a summary too: as a computed
    // column it repeated the same value down every row and couldn't be bound
    // from a dashboard as a single value. Classification is order-independent:
    // scan every line first, then iterate to a fixpoint. A line referencing a
    // summary defined later in the fence still classifies as a summary; a line
    // touching anything row-shaped (a data column or a computed column,
    // wherever defined) stays a data row.
    const parsed: { name: string; src: string; expr: Expr | FErr; group: number }[] = [];
    let group = 0;
    let pendingBreak = false; // a blank line seen after at least one formula
    for (const rawLine of ff.inner.split("\n")) {
      const line = rawLine.trim();
      if (!line) {
        if (parsed.length > 0) pendingBreak = true;
        continue;
      }
      if (line.startsWith("#")) continue;
      const m = FORMULA_LINE_RE.exec(line);
      if (!m) {
        errors.push(`can't parse formula line: ${line}`);
        continue;
      }
      if (pendingBreak) {
        group++;
        pendingBreak = false;
      }
      parsed.push({ name: m[1], src: m[2], expr: parseFormula(m[2]), group });
    }
    // A bare (non-dotted) reference that isn't a summary is row-shaped: a data
    // column or a computed column. Used by the lookup-key rule — a LOOKUP whose
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
        group: p.group,
      });
    }
  }
  for (const msg of foldedCollisions(headers, formulas.map((f) => f.name)).values()) {
    errors.push(msg);
  }
  return { headers, rows: data, formulas, errors, hasCsv: csv !== null };
}

// ---------- folded-name collisions ----------

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
    is refused there too, see `memberValue`. Data cells always keep
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
  today: () => string,
  hist?: HistoryResolver
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
      out = evalSheetInner(m, fx, ctx, today, hist);
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
  // An ambiguous name on the *other* sheet is ambiguous here too.
  // Summaries and computed columns already carry their own collision error, so
  // they answer honestly above; a data column doesn't — without this, two
  // headers folding to one name would hand back whichever came first.
  const amb = ev.collisions.get(name.trim().toLowerCase());
  if (amb) return ferr(amb);
  const h = ev.headers.findIndex((h) => h.toLowerCase() === name);
  if (h >= 0) return ev.rows.map((r) => r[h] ?? null);
  return ferr(`no column or summary “${name}” on sheet “${sheet}”`);
}

/** `hist` is the time-travel seam: the synchronous resolver `PROP()`
    and `AT()` read facts through, prefetched by the pane exactly the way FX
    rates are. Omitted, those functions report that history isn't loaded rather
    than answering — the sheet still evaluates. */
export function evaluateSheet(
  model: SheetModel,
  fx: FxResolver,
  cross?: { self: string; load: SheetLoader },
  today: () => string = todayIso,
  hist?: HistoryResolver
): SheetEval {
  const ctx: CrossCtx | null = cross
    ? { stack: [cross.self.toLowerCase()], cache: new Map(), load: cross.load }
    : null;
  return evalSheetInner(model, fx, ctx, today, hist);
}

function evalSheetInner(
  model: SheetModel,
  fxResolver: FxResolver,
  ctx: CrossCtx | null,
  today: () => string,
  hist?: HistoryResolver
): SheetEval {
  const rows: Cell[][] = model.rows.map((r) => r.map(typedCell));
  const computed: { name: string; cells: Value[] }[] = [];
  const summaries: { name: string; value: Value; group: number }[] = [];

  // Names two things fold onto. Bound over every scope below, after
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
        const ev = resolveSheet(ctx, fxResolver, cr.sheet, today, hist);
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
      // Whole-column view alongside the row values: only a row-scoped
      // LOOKUP's table arguments read it, so a same-sheet rates table works
      // per row while every other name still resolves to this row's cell.
      for (const [k, col] of rowColumns) scope.set(k, col);
      bindCross(scope);
      bindCollisions(scope);
      const v = evaluate(f.expr, scope, fxResolver, today, hist);
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
      summaries.push({ name: f.name, value: own ?? (f.expr as FErr), group: f.group });
      continue;
    }
    const v = evaluate(f.expr, summaryScope, fxResolver, today, hist);
    const value = Array.isArray(v) ? ferr(COL_AS_VALUE) : (v as Value);
    summaries.push({ name: f.name, value, group: f.group });
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

// ---------- totals row placement ----------

export interface TotalsRow {
  /** grid column index → summary names, in fence order. Grid columns count
      data headers first, then computed columns in fence order — the same
      order SheetGrid renders. */
  byColumn: Map<number, string[]>;
  /** lowercased names the totals row took, so the footer can skip them. */
  absorbed: Set<string>;
}

/** Which summaries belong in the in-grid totals row, and under which column.
 *
 * The rule is the formula's own references: strip cross-sheet refs and refs
 * to other summaries, and what's left is the row-shaped set — the data and
 * computed columns the line actually reads. Exactly one column in that set
 * means the summary describes that column (`monthly_total = SUM(monthly_eur)`,
 * `share = SUM(cost) / budget_total`), so it renders in that column's totals
 * cell. Anything else — several columns, a cross-sheet total, a bare constant,
 * a sheet-wide COUNT of nothing — has no single column to sit under and stays
 * in the footer.
 *
 * "Reads" means `describingRefs`, not every ref: a conditional aggregate is
 * about its value column, not its filters, so `SUMIF(status, "open", value_eur)`
 * sits under `value_eur` (answered Option A — the number IS a sum of
 * that column; the filter is a modifier). COUNTIF keeps sitting under its
 * filter column, because counting rows is all it does.
 *
 * Deliberately no fallback guess: a summary the heuristic can't place is
 * visible in the footer, never dropped. Ambiguous (folded) names are refused
 * on both sides — the summary's own name and the column it would land under —
 * because the folded-name rule already says nothing may resolve such a name to data.
 *
 * Several summaries may share one column (`sum` and `avg` of the same column);
 * they stack in that cell in fence order rather than one silently winning. */
export function totalsRow(model: SheetModel): TotalsRow {
  const byColumn = new Map<number, string[]>();
  const absorbed = new Set<string>();
  const summaryNames = new Set(
    model.formulas.filter((f) => f.aggregate).map((f) => f.name.toLowerCase())
  );
  const collisions = foldedCollisions(
    model.headers,
    model.formulas.map((f) => f.name)
  );

  // Grid column order: data headers, then computed columns in fence order.
  const colIndex = new Map<string, number>();
  model.headers.forEach((h, i) => {
    const k = h.trim().toLowerCase();
    if (k !== "" && !colIndex.has(k)) colIndex.set(k, i);
  });
  let next = model.headers.length;
  for (const f of model.formulas) if (!f.aggregate) colIndex.set(f.name.toLowerCase(), next++);

  for (const f of model.formulas) {
    if (!f.aggregate || isErr(f.expr)) continue;
    if (collisions.has(f.name.toLowerCase())) continue;
    const rowRefs = new Set(
      describingRefs(f.expr).filter((r) => !r.includes(".") && !summaryNames.has(r))
    );
    if (rowRefs.size !== 1) continue;
    const only = [...rowRefs][0];
    if (collisions.has(only)) continue;
    const col = colIndex.get(only);
    if (col === undefined) continue; // reference to nothing on this sheet
    const at = byColumn.get(col);
    if (at) at.push(f.name);
    else byColumn.set(col, [f.name]);
    absorbed.add(f.name.toLowerCase());
  }
  return { byColumn, absorbed };
}

// ---------- selection readout ----------

export interface SelectionStats {
  /** non-blank cells in the selection, errors included */
  count: number;
  /** how many of those are numbers */
  numeric: number;
  sum: number;
  /** mean over the numeric cells; null when there are none */
  avg: number | null;
}

/** Sum/avg/count over a selected range — display only, never written back.
    Blanks are skipped like every aggregate in the language; error
    cells count as cells but contribute no number, so a range holding one bad
    formula still reports the honest sum of the rest rather than nothing. */
export function selectionStats(values: (Value | Cell | undefined)[]): SelectionStats {
  let count = 0;
  let numeric = 0;
  let sum = 0;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    count++;
    if (typeof v === "number") {
      numeric++;
      sum += v;
    }
  }
  return { count, numeric, sum, avg: numeric > 0 ? sum / numeric : null };
}

/** Which Count the totals quick-pick should prefill for a column.
 *
 * COUNT means "how many numbers are here" — the language keeps that meaning,
 * and nothing here changes it. But a quick-pick over a column of text (`paid`
 * = yes/no, a month column, a name column) then prefills a formula that can
 * only ever read 0, which looks like the feature is broken rather than like
 * an honest answer. On such a column the pick prefills `COUNTIF(column, "*")`
 * instead: the wildcard counts non-blank, non-error cells, whatever they hold.
 *
 * Evidence, not schema, decides — the same rule shape as
 * columnTakesNumberInput:
 *  - any numeric cell (a number, or a string that parses strictly as one,
 *    which is what COUNT itself counts) → "COUNT". A mixed column keeps
 *    numeric semantics; the input still takes the whole formula language.
 *  - otherwise, at least one non-blank, non-error cell → "COUNTIF": values
 *    are present, but nothing is numeric.
 *  - no usable evidence — no rows, all blank, or all errors — → "COUNT".
 *    Empty/blank columns read 0 either way, while an error-only column keeps
 *    COUNT's existing error propagation instead of being silently flattened
 *    to 0 by COUNTIF. */
export function countPickKind(values: (Value | Cell | undefined)[]): "COUNT" | "COUNTIF" {
  let nonBlank = false;
  for (const v of values) {
    if (v === null || v === undefined || isErr(v)) continue;
    if (typeof v === "number") return "COUNT";
    if (typeof v === "string") {
      if (v.trim() === "") continue;
      if (parseStrictNumber(v) !== null) return "COUNT";
    }
    nonBlank = true;
  }
  return nonBlank ? "COUNTIF" : "COUNT";
}

// ---------- display ----------

/** Columns whose integers are labels, not quantities. A year or an
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

/** Is this column numeric *by evidence*, so a typed draft may be normalized
 * from de-DE into canonical dot-decimal?
 *
 * `normalizeNumberInput` is documented for number-KIND columns only — every
 * other call site gates it on kind === "number". Sheets carry no schema,
 * so the grid has to earn that gate instead of assuming it: without one,
 * committing an unrelated text cell — an ip `192.168`, a version, a dotted
 * label — silently rewrites it to `192168`, which is data loss on Enter.
 *
 * Two conditions, both required:
 *  1. The column's OTHER data cells (every row but the one being edited)
 *     parse as numbers via typedCell, and there is at least one of them.
 *     A column of text has no claim on the de-DE grammar; a column that is
 *     all numbers does. An all-blank or single-row column stays verbatim —
 *     no evidence, no rewrite.
 *  2. The column is not a label column (isLabelColumn), which
 *     exists exactly for "the digits here are names, not quantities": a
 *     `year` column of 2.024/2.025 is dotted on purpose and must survive. */
export function columnTakesNumberInput(
  model: SheetModel,
  col: number,
  editingRow: number
): boolean {
  const header = model.headers[col];
  if (header === undefined || isLabelColumn(header)) return false;
  let seen = false;
  for (let r = 0; r < model.rows.length; r++) {
    if (r === editingRow) continue;
    const v = typedCell(model.rows[r][col] ?? "");
    if (v === null) continue; // blank cells abstain
    if (typeof v !== "number") return false;
    seen = true;
  }
  return seen;
}

/** The one grid-wide number format, in the user's dialect
 * (`numberLocale()`, de-DE by default like every other surface):
 * grouped thousands, 2 decimals for fractional values, integers bare
 * (de-DE `1.234` — never `1.234,00`).
 *
 * Two exceptions drop the grouping for integers, because a number
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
 * Five-digit-and-up quantities and all fractional values keep the locale's
 * grouping. Display-only: editing seeds from and writes back the raw csv
 * strings, so this output is never re-parsed. */
export function formatNum(v: number, header?: string): string {
  if (Number.isInteger(v)) {
    const plain =
      Math.abs(v) < 10000 || (header !== undefined && isLabelColumn(header));
    return plain ? String(v) : v.toLocaleString(numberLocale(), { maximumFractionDigits: 0 });
  }
  return v.toLocaleString(numberLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** How one grid column renders every number in it.
 *
 * The shape is decided per COLUMN, not per value, and that is the whole
 * point: formatNum's rules are value-driven (integer vs fractional, below
 * vs above 10000), so a single money column rendered `7400` next to
 * `37.680` — a reader could not tell thirty-seven thousand from 37.68, and
 * could induce no rule at all. Grouping and decimal count are properties of
 * a column of quantities; only the digits differ per row. */
export interface ColumnFormat {
  /** fixed decimals every cell in the column renders with */
  decimals: 0 | 2;
  /** thousands grouping (dots, in the de-DE dialect) */
  group: boolean;
}

/** The neutral shape for a column with no numbers in it at all — nothing to
 * be consistent about, and it renders no numeric cells. */
const PLAIN_FORMAT: ColumnFormat = { decimals: 0, group: false };

/** The format one column of values renders in.
 *
 * Two decisions, both from the whole column:
 *
 *  1. Decimals — 2 if ANY value in the column is fractional, else 0. A money
 *     column holding 1200 and 4,10 shows `1.200,00` and `4,10`: the same
 *     grammar down the column, so the decimal comma always means the same
 *     thing. A column of whole numbers stays whole (`1.234`, never
 *     `1.234,00`), exactly as before.
 *  2. Grouping — on, unless the column is identifier-shaped. Two ways to be
 *     identifier-shaped, both preserving the rule that a number which
 *     is really a NAME must not be dotted (de-DE writes 2026 as "2.026", and
 *     that dot IS the thousands separator):
 *       - a label column by header (isLabelColumn: `year`, `*_id`, `no`,
 *         `nr`) — header-driven, never value-driven, as before;
 *       - a column whose numbers are ALL integers below 10000, which is
 *         where unnamed identifiers live (years, ports, PLZ, catalogue
 *         numbers) and where grouping buys no legibility anyway.
 *     The second is the four-digit rule re-read per column instead of
 *     per value. A pure year column of 2024/2025/2026 still renders bare;
 *     a column that mixes 7400 with 37680 is a column of quantities, so both
 *     group. That difference is the fix: the old per-value test split one
 *     column across two regimes.
 *
 * Non-numbers (labels, errors, blanks) abstain — they render verbatim and
 * have no claim on the column's number grammar. */
export function columnFormat(values: readonly (Value | Cell)[], header?: string): ColumnFormat {
  const nums: number[] = [];
  for (const v of values) if (typeof v === "number" && Number.isFinite(v)) nums.push(v);
  if (nums.length === 0) return PLAIN_FORMAT;
  const decimals = nums.some((n) => !Number.isInteger(n)) ? 2 : 0;
  const identifierish =
    (header !== undefined && isLabelColumn(header)) ||
    (decimals === 0 && nums.every((n) => Math.abs(n) < 10000));
  return { decimals, group: !identifierish };
}

/** Every column's format for one evaluated sheet — data columns by header,
 * computed columns by formula name, in the order the grid renders them
 * Computed columns are shaped by the same rule as typed ones:
 * a formula column is where the grid's worst collision lived, since its
 * values straddle 10000 far more often than hand-typed ones do. */
export function sheetColumnFormats(ev: SheetEval): {
  data: ColumnFormat[];
  computed: ColumnFormat[];
} {
  return {
    data: ev.headers.map((h, c) =>
      columnFormat(
        ev.rows.map((row) => row[c] ?? null),
        h
      )
    ),
    computed: ev.computed.map((col) => columnFormat(col.cells, col.name)),
  };
}

/** One number in its column's format — the digits vary per row,
 * the grammar never does. */
export function formatNumIn(v: number, fmt: ColumnFormat): string {
  return v.toLocaleString(numberLocale(), {
    minimumFractionDigits: fmt.decimals,
    maximumFractionDigits: fmt.decimals,
    useGrouping: fmt.group,
  });
}

/** Aggregates whose result is still a quantity of its argument column
 * a SUM of euros is euros, so is a MIN, MAX, AVG or LAST. COUNT
 * and COUNTIF are deliberately absent — they are dimensionless (see COUNTING). */
const UNIT_PRESERVING = new Set(["SUM", "AVG", "MIN", "MAX", "LAST"]);

/** Aggregates whose result is a plain count of rows: dimensionless,
 * so they carry no column grammar of their own — a money column's two decimals
 * would render 4 rows as "4,00". `COUNTIF` is here too, which is what keeps
 * this compatible with the value-aware Count quick-pick: it swaps
 * `COUNT(col)` for `COUNTIF(col, "*")` on a text column, and both stay
 * dimensionless. */
const COUNTING = new Set(["COUNT", "COUNTIF"]);

/** What a summary expression claims about its shape: a column's format, or
 * `"neutral"` for a bare literal (compatible with anything), or `"count"` for
 * a dimensionless row count, or `null` for "no claim" — a string, a cross-sheet
 * reference, a function whose output shape we can't name. */
type FormatClaim = ColumnFormat | "neutral" | "count" | null;

/** Two claims meeting where both sides must be the same kind of thing — `+`,
 * `-`, and `IF`'s two branches. Neutrals defer; two real formats merge toward
 * the MORE explicit grammar (max decimals, grouping if either side groups)
 * rather than abstaining. `total = SUM(value_usd) - SUM(fees)` over a grouped
 * column and an identifier-shaped one is still money, and the whole point of
 * the column grammar is that the ungrouped reading is the dangerous one.
 *
 * A count added to a quantity is neither, so it abstains. */
function unifyClaims(a: FormatClaim, b: FormatClaim): FormatClaim {
  if (a === null || b === null) return null;
  if (a === "neutral") return b;
  if (b === "neutral") return a;
  if (a === "count" || b === "count") return a === b ? "count" : null;
  return {
    decimals: a.decimals >= b.decimals ? a.decimals : b.decimals,
    group: a.group || b.group,
  };
}

/** Two claims meeting under `*` or `/`, where a count scales rather than
 * disagrees (review): a quantity divided by a count is still that
 * quantity, so `mean = SUM(value_usd) / COUNT(value_usd)` keeps value_usd's
 * grammar instead of abstaining back into the per-value rules this issue
 * closed. A count behaves exactly like a bare literal here. */
function unifyScaled(a: FormatClaim, b: FormatClaim): FormatClaim {
  return unifyClaims(a === "count" ? "neutral" : a, b === "count" ? "neutral" : b);
}

/** The format a summary expression inherits from the columns it reads
 * `formats` maps folded column and earlier-summary names to the
 * grammar they render in. */
function claimOf(e: Expr, formats: Map<string, FormatClaim>): FormatClaim {
  switch (e.k) {
    case "num":
      return "neutral";
    case "str":
      return null;
    case "ref":
      // A cross-sheet reference reads a column this grid never renders, so
      // there is nothing here to agree with.
      return e.sheet !== undefined ? null : (formats.get(e.name) ?? null);
    case "neg":
      return claimOf(e.e, formats);
    case "bin":
      // Arithmetic carries shape through; a comparison renders a boolean.
      // `*` and `/` let a count scale a quantity without erasing its grammar.
      if (e.op === "*" || e.op === "/")
        return unifyScaled(claimOf(e.l, formats), claimOf(e.r, formats));
      return e.op === "+" || e.op === "-"
        ? unifyClaims(claimOf(e.l, formats), claimOf(e.r, formats))
        : null;
    case "call": {
      if (UNIT_PRESERVING.has(e.name) && e.args.length > 0)
        return claimOf(e.args[0], formats);
      // A count is dimensionless, not claimless: it renders bare, but it still
      // scales a quantity through `*` and `/` (see unifyScaled).
      if (COUNTING.has(e.name)) return "count";
      // SUMIF sums its third argument when it spells one, else the first
      // (formula.ts evalAggregate) — the criteria columns are not summed.
      if (e.name === "SUMIF" && e.args.length > 0)
        return claimOf(e.args[e.args.length >= 3 ? 2 : 0], formats);
      // LOOKUP returns a cell of its value column exactly as LAST returns a
      // cell of its argument (formula.ts LOOKUP) — the key and key column
      // decide WHICH row, never what the result is. SUMPRODUCT
      // stays absent on purpose: it has no single nameable source column.
      if (e.name === "LOOKUP" && e.args.length >= 3) return claimOf(e.args[2], formats);
      // IF picks one of its branches, so it is whatever they agree on.
      if (e.name === "IF" && e.args.length >= 3)
        return unifyClaims(claimOf(e.args[1], formats), claimOf(e.args[2], formats));
      // ROUND abstains on purpose: the author already stated a decimal
      // intent, and inheriting a 0-decimal column's grammar would erase it.
      return null;
    }
  }
}

/** Each summary's number format, folded name → format.
 *
 * The summary bar rendered `formatValue(s.value)` with no column around it,
 * so a chip fell back to the per-value legacy rules that the column grammar removed
 * from the grid — and a `total = SUM(value_usd)` landing under 10000 and
 * integral rendered `7400` directly beneath a column rendering `7.400` and
 * `37.680`. A summary reads known columns, so it can inherit their grammar.
 *
 * Only summaries claiming a column format get an entry; the rest are absent and
 * keep the legacy rendering. Summaries resolve in fence order, so a summary
 * built on an earlier one inherits through it — including through a count,
 * which carries its dimensionless claim forward so `mean = total / rows` still
 * reads as money. */
export function sheetSummaryFormats(
  model: SheetModel,
  ev: SheetEval
): Map<string, ColumnFormat> {
  const cols = sheetColumnFormats(ev);
  const claims = new Map<string, FormatClaim>();
  ev.headers.forEach((h, c) => claims.set(h.toLowerCase(), cols.data[c]));
  ev.computed.forEach((col, c) => claims.set(col.name.toLowerCase(), cols.computed[c]));

  const out = new Map<string, ColumnFormat>();
  for (const f of model.formulas) {
    if (!f.aggregate || isErr(f.expr)) continue;
    const claim = claimOf(f.expr, claims);
    const key = f.name.toLowerCase();
    claims.set(key, claim);
    if (claim === null || claim === "neutral" || claim === "count") continue;
    out.set(key, claim);
  }
  return out;
}

/** One summary chip, in the grammar of the columns it aggregates.
 *
 * `fmt` absent (a summary that claims no column) keeps the legacy per-value
 * rendering. The one place a chip departs from its column: a fractional
 * result under a whole-number column keeps 2 decimals instead of rounding to
 * the column's 0 — `AVG(units)` over 1200/4 is 602 vs 602,17, and the digits
 * a derived value carries are not the column's to drop. */
export function formatSummary(v: Value | Cell, fmt?: ColumnFormat): string {
  if (fmt && typeof v === "number" && Number.isFinite(v)) {
    const decimals = fmt.decimals === 0 && !Number.isInteger(v) ? 2 : fmt.decimals;
    return formatNumIn(v, { decimals, group: fmt.group });
  }
  return formatValue(v);
}

/** `header` is the column the value renders under, when there is one — the
 * grid passes it so id columns skip thousands grouping past four digits.
 * Headerless callers (summary cards, metrics tiles) still get the four-digit
 * rule; only the header-driven half of formatNum needs the name.
 *
 * `fmt` is the column's agreed format. A caller that renders a
 * whole column — the grid — passes it and gets one grammar down the column;
 * a caller holding a lone number with no column around it (summary chips,
 * metric tiles) omits it and keeps the per-value rules above. */
export function formatValue(v: Value | Cell, header?: string, fmt?: ColumnFormat): string {
  if (v === null || v === undefined) return "";
  if (isErr(v)) return "!";
  if (typeof v === "number") return fmt ? formatNumIn(v, fmt) : formatNum(v, header);
  if (typeof v === "boolean") return v ? "true" : "false";
  return v;
}

export function errMessage(v: unknown): string | null {
  return isErr(v) ? v.err : null;
}

// ---------- summary bar layout ----------

export interface BarSummary {
  name: string;
  value: Value;
}

/** One error chip standing in for several broken summaries. `message` is the
    shared cause when they all failed the same way — the engine's own message,
    which already names the culprit (`“value_eur” is both a column and a
    formula name — rename one`) — and null when the only thing they have in
    common is that they failed. */
export interface BarRollup {
  message: string | null;
  names: string[];
}

export interface SummaryBar {
  /** Read at a glance: the first block of the fence that holds summaries. */
  headline: BarSummary[];
  /** Behind the "show all" toggle: later blocks, plus anything a rollup
      already speaks for (its chip expands to these). Definition order. */
  rest: BarSummary[];
  rollups: BarRollup[];
}

/** Split the evaluated summaries into what the bar shows first, what it hides,
    and the error rollups.
 *
 * Hierarchy comes from the note itself: blank lines in the ```formulas fence
 * group the lines, and the FIRST group holding summaries is the headline. It
 * is deliberately the first *summary-bearing* group, not group 0 — the
 * canonical sheet shape puts computed columns above a blank line and the
 * totals below it, so keying on group 0 would headline nothing and bury every
 * total. A fence with one group therefore behaves exactly as it always did:
 * everything is headline, nothing collapses, no toggle appears.
 *
 * Errors roll up by their message, which is how one root cause is attributed:
 * a name collision or a broken upstream ref propagates the *same* message into
 * every summary that reads it, so grouping on the message says "these N are
 * one problem" without guessing. Two or more sharing a message become one
 * chip; leftover one-off failures collapse into a single untargeted chip only
 * once there are at least two of them (a lone failure stays a normal chip in
 * place, where its name is the useful part). Rolled-up summaries move to
 * `rest` so the headline row stops being a row of `!`. */
export function summaryBar(summaries: SheetEval["summaries"]): SummaryBar {
  const messages = summaries.map((s) => errMessage(s.value));
  const byMessage = new Map<string, number[]>();
  messages.forEach((m, i) => {
    if (m === null) return;
    const at = byMessage.get(m);
    if (at) at.push(i);
    else byMessage.set(m, [i]);
  });

  const rollups: BarRollup[] = [];
  const rolled = new Set<number>();
  const strays: number[] = [];
  for (const [message, at] of byMessage) {
    if (at.length < 2) {
      strays.push(at[0]);
      continue;
    }
    rollups.push({ message, names: at.map((i) => summaries[i].name) });
    for (const i of at) rolled.add(i);
  }
  if (strays.length > 1) {
    strays.sort((a, b) => a - b);
    rollups.push({ message: null, names: strays.map((i) => summaries[i].name) });
    for (const i of strays) rolled.add(i);
  }

  const headGroup = summaries.length > 0 ? Math.min(...summaries.map((s) => s.group)) : 0;
  const headline: BarSummary[] = [];
  const rest: BarSummary[] = [];
  summaries.forEach((s, i) => {
    const chip = { name: s.name, value: s.value };
    if (s.group === headGroup && !rolled.has(i)) headline.push(chip);
    else rest.push(chip);
  });
  return { headline, rest, rollups };
}

/** Does this sheet convert currency through `FX()`? The bar's
    `USD→EUR …` stamp used to render under every sheet, including ones with no
    money in them at all. The question is asked of this sheet's own formulas
    only: a cross-sheet total that was converted elsewhere carries its rate on
    the sheet that did the converting, where the reader can see the line. */
export function sheetUsesFx(model: SheetModel): boolean {
  return model.formulas.some((f) => !isErr(f.expr) && callsFunction(f.expr, "FX"));
}

/** Does this sheet read frontmatter facts at all? The gate on the
    history prefetch, the way `sheetUsesFx` gates the rates fetch: a sheet with
    no `PROP()`/`AT()` never lists the vault. Present-tense `PROP()` collects no
    refs but still needs the resolver, so this asks the broader question. */
export function sheetUsesHistory(model: SheetModel): boolean {
  return model.formulas.some(
    (f) => !isErr(f.expr) && (callsFunction(f.expr, "PROP") || callsFunction(f.expr, "AT"))
  );
}

/** Which past facts this sheet needs before it can be evaluated.
    The formula engine is synchronous and history lives in git, so the reads
    have to be known *before* evaluation: the pane asks this, fetches the lanes,
    and hands back a resolver. Empty means no past reads — a sheet that only
    uses `PROP()` in the present tense costs nothing, and neither does one with
    no history at all, so the fetch stays gated the way the FX one is.

    Dates that depend on a row (`AT(bought, …)`) collect nothing by design: they
    can't be known without evaluating first, and those cells report that history
    isn't loaded rather than silently answering. */
export function sheetHistoryRefs(model: SheetModel, today: () => string = todayIso): HistoryRef[] {
  const out: HistoryRef[] = [];
  const seen = new Set<string>();
  for (const f of model.formulas) {
    if (isErr(f.expr)) continue;
    for (const r of collectHistoryRefs(f.expr, today)) {
      const k = `${r.path}\u0000${r.key}\u0000${r.date}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

/** Which past days this sheet needs whole *sheets* for (spec §3.2).
    `AT(date, Other.total)` re-evaluates `Other` as it stood, so the prefetch
    needs the tree at that instant, not just a fact lane. Same static-collection
    rule as `sheetHistoryRefs`: a per-row date collects nothing and reports that
    history isn't loaded. Returns ISO days, deduped — one fetch per day covers
    every sheet read at it, including the ones reached transitively. */
export function sheetHistorySheetDates(
  model: SheetModel,
  today: () => string = todayIso
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of model.formulas) {
    if (isErr(f.expr)) continue;
    for (const r of collectHistorySheetRefs(f.expr, today)) {
      if (seen.has(r.date)) continue;
      seen.add(r.date);
      out.push(r.date);
    }
  }
  return out;
}

/** Builds the `sheetValue` delegate that `AT(date, Sheet.member)` reads through
    (§3.2): resolves the sheet name against *that day's* tree, parses its body,
    and re-evaluates it — that commit's CSV fence through that commit's formula
    fence, cross-sheet references resolving against the historical tree too, the
    way `build_vault_snapshot` renders an old projection against its old config.
    Nothing is read from a cache of stored numbers.

    `facts` is the present-tense fact resolver. The one handed *into* a
    historical evaluation is bound to the day (so a `PROP()` in there reads the
    past) but deliberately carries no `asOfDate`: inside a historical sheet its
    own values legitimately ARE historical, and marking it would make every
    reference to them refuse. */
export function makeHistorySheetValue(
  snapshots: readonly HistorySheetSnapshot[],
  facts: HistoryResolver | undefined,
  fx: FxResolver,
  today: () => string = todayIso
): (sheet: string, member: string, date: string) => ScopedValue | ScopedValue[] {
  const byDate = new Map(snapshots.map((s) => [s.date, s]));
  // One parse + one evaluation per (day, sheet), shared across every cell that
  // asks — a dashboard reading three members off one historical sheet must not
  // rebuild it three times.
  const models = new Map<string, SheetModel | FErr>();
  const ctxs = new Map<string, CrossCtx>();

  const self = (sheet: string, member: string, date: string): ScopedValue | ScopedValue[] => {
    const snap = byDate.get(date);
    if (!snap) return ferr(`AT: history for ${date} is not loaded yet`);
    if (!snap.commit) {
      return ferr(
        snap.oldest ? `no history before ${snap.oldest}` : "this vault has no version history yet"
      );
    }

    const loadModel = (name: string): SheetModel | FErr => {
      const k = `${date}\0${name.toLowerCase()}`;
      const hit = models.get(k);
      if (hit) return hit;
      const n = matchHistoryNote(snap.notes, name);
      const out: SheetModel | FErr = n
        ? parseSheet(n.body)
        : ferr(`no sheet “${name}” in the vault on ${date}`);
      models.set(k, out);
      return out;
    };

    let ctx = ctxs.get(date);
    if (!ctx) {
      ctx = { stack: [], cache: new Map(), load: loadModel };
      ctxs.set(date, ctx);
    }

    let bound: HistoryResolver | undefined;
    if (facts) {
      const base = facts.unbound ?? facts;
      const b: HistoryResolver = (p, k) => base(p, k, date);
      b.unbound = base;
      b.sheetValue = self;
      bound = b;
    }

    const ev = resolveSheet(ctx, fx, sheet, today, bound);
    return isErr(ev) ? ev : memberValue(ev, sheet, member.toLowerCase());
  };
  return self;
}

// Sheet names address a note by title or stem, case-insensitively — the same
// rule the live loader uses, applied to the day's tree. Path is accepted last
// so a dashboard that spells one out still resolves.
function matchHistoryNote(
  notes: HistorySheetSnapshot["notes"],
  name: string
): HistorySheetSnapshot["notes"][number] | undefined {
  const l = name.trim().toLowerCase();
  return (
    notes.find((n) => n.title.toLowerCase() === l) ??
    notes.find((n) => n.stem.toLowerCase() === l) ??
    notes.find((n) => n.path.toLowerCase() === l)
  );
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

/** Append one `name = src` line to the formulas fence (the totals
    row's empty cells and the footer's "+ summary" both land here).
    Creates the fence after the csv block when the sheet has none yet — a
    sheet whose first summary is written in-app must not have to be opened in
    source view first. No-op on an invalid name, an empty right side, or a
    name that collides with a data column or an existing formula, mirroring
    updateSheetFormula's refusals. */
export function addSheetFormula(body: string, name: string, src: string): string {
  const n = name.trim();
  const s = src.trim();
  if (!FORMULA_NAME_RE.test(n) || !s) return body;
  const model = parseSheet(body);
  const lower = n.toLowerCase();
  if (
    model.headers.some((h) => h.trim().toLowerCase() === lower) ||
    model.formulas.some((f) => f.name.toLowerCase() === lower)
  )
    return body;
  const line = `${n} = ${s}`;
  const ff = findFence(body, "formulas");
  if (!ff) {
    const csv = findFence(body, "csv");
    const block = "```formulas\n" + line + "\n```";
    // After the csv fence when there is one, so the note keeps reading
    // data-then-formulas like every hand-written sheet.
    if (!csv) return body.trimEnd() + (body.trim() ? "\n\n" : "") + block + "\n";
    const after = body.slice(csv.to);
    return body.slice(0, csv.to) + "\n\n" + block + (after.trim() ? after : "\n");
  }
  const lines = splitFenceLines(ff.inner);
  // A fence ending in blank lines keeps them below the new line rather than
  // growing a gap on every append.
  let at = lines.length;
  while (at > 0 && lines[at - 1].trim() === "") at--;
  lines.splice(at, 0, line);
  const inner = "```formulas\n" + lines.join("\n") + "\n```";
  return body.slice(0, ff.from) + inner + body.slice(ff.to);
}

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

/** Validate a totals/footer editor draft against the engine's real formula
 * classification before writing it. The editor deliberately accepts the full
 * formula language, but it creates named summaries only: a row-shaped formula
 * belongs to a computed-column flow and must not silently appear in the grid.
 *
 * Build the exact candidate body and let parseSheet's order-independent
 * fixpoint classify it. That keeps constants, cross-sheet expressions,
 * aggregate arithmetic and references to later summaries working here under
 * the same rules as hand-written fences. */
export function summaryFormulaError(
  body: string,
  oldName: string | null,
  newName: string,
  newSrc: string
): string | null {
  const n = newName.trim().toLowerCase();
  // A new line can't take a name the fence already uses: the append refuses
  // silently, and validating the candidate would just re-check the line that
  // is already there and call the add fine.
  if (oldName === null) {
    const taken = parseSheet(body);
    if (
      taken.headers.some((h) => h.trim().toLowerCase() === n) ||
      taken.formulas.some((f) => f.name.toLowerCase() === n)
    )
      return `“${newName.trim()}” is already used on this sheet — pick another name`;
  }
  const candidate =
    oldName === null
      ? addSheetFormula(body, newName, newSrc)
      : updateSheetFormula(body, oldName, newName, newSrc);
  const formula = parseSheet(candidate).formulas.find((f) => f.name.toLowerCase() === n);
  if (!formula) return "couldn’t validate that summary";
  if (isErr(formula.expr)) return formula.expr.err;
  if (!formula.aggregate) return "that’s a column formula, not a summary";
  return null;
}
