import { durationFrom, isIsoDate, todayIso } from "./dates.ts";
import { splitDateRange } from "./calendar.ts";
import { parseStrictNumber } from "./aggregate.ts";
import { foldedPropKey } from "./types.ts";
import type { NoteMeta, PropSchema } from "./types.ts";

/** The schema a query is read against, when the caller has one — a database
    pane knows its type's props, the cross-database search pane doesn't.
    Without it every key keeps the classic text semantics. */
export type QuerySchema = Record<string, PropSchema> | undefined;

/** Does the schema call this key a number? (SUB-639) Keys arrive lowercased
    from the parse while schema keys keep their spelling, so the lookup tries
    both — the one gate for every numeric filter path below. */
function numberKind(key: string, schema: QuerySchema): boolean {
  if (!schema) return false;
  if (schema[key]?.kind === "number") return true;
  for (const k of Object.keys(schema)) {
    if (k.toLowerCase() === key) return schema[k]?.kind === "number";
  }
  return false;
}

/** Filter operators. `:` is the classic `key:value` exact/prefix match; the
    rest are date comparisons (SUB-66) against an ISO-day operand. */
export type CmpOp = "<" | ">" | "<=" | ">=";
export type FilterOp = ":" | CmpOp;

export interface QueryFilter {
  key: string;
  /** OR over one prop (SUB-78): `key:a,b` hits when ANY value matches, each
      with the classic per-value semantics. Length ≥ 1, lowercased. A date
      comparison carries exactly one value — the operand (duration/ISO day). */
  values: string[];
  /** absent/`:` = classic value match. A comparison op turns this into a
      date filter whose single `values` entry is the operand. */
  op?: FilterOp;
  /** SUB-198: a `-` directly prefixing the filter (`-status:live`, `-due < 7d`)
      negates it — the filter hits exactly when the positive form would not. */
  neg?: boolean;
}

export interface ParsedQuery {
  text: string;
  /** quoted sections (`"exact phrase"`, SUB-219): unwrapped and kept out of
      `text`. Callers match each as an exact substring — the semantics the
      search pane's FTS gives quoted phrases — instead of splitting them into
      words that can never hit with their quote characters attached. */
  phrases: string[];
  filters: QueryFilter[];
  /** an operator token still being typed at the end ("type:", "type:rel",
      "due <", "due < 7"). For a multi-value stub ("type:a,b…"), `values`
      holds the comma-committed segments and `partial` the one being typed.
      `neg` is set when the stub opened with `-` ("-type:rel", SUB-198). */
  trailing: { key: string; values: string[]; partial: string; op: FilterOp; neg?: boolean } | null;
}

// key charclass: a unicode letter, then letters/numbers/underscore plus the
// classic `#` and `-` — ASCII-only lexing made non-ASCII prop keys
// (`Gebühr:`) unfilterable (SUB-219)
const OP_RE = /^(\p{L}[\p{L}\p{N}_#-]*):(.*)$/u;
const CMP_WHOLE_RE = /^(\p{L}[\p{L}\p{N}_#-]*)(<=|>=|<|>)(\S+)$/u;
const CMP_HEAD_RE = /^(\p{L}[\p{L}\p{N}_#-]*)(<=|>=|<|>)$/u;
const KEY_RE = /^\p{L}[\p{L}\p{N}_#-]*$/u;
const CMP_TAIL_RE = /^(<=|>=|<|>)(\S*)$/;

/** A pasted URI or drive-letter path matches the operator shape ("file:" +
    rest, "c:" + rest) but is never a filter — any `scheme://` counts, not
    just http(s), and `X:\`/`X:/` is a Windows path (SUB-219). A key part can
    never contain `/` or `.`, so anything with those before the colon already
    falls out as plain text. */
const URI_RE = /^[\p{L}][\p{L}\p{N}+.-]*:\/\//u;
const DRIVE_RE = /^[A-Za-z]:[\\/]/;

/** Split on whitespace, keeping quoted sections glued to their token, so
    both `key:"quoted value"` and a multi-value `key:"a b",c` stay whole. */
function tokenize(q: string): string[] {
  return q.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
}

/** The bare-word side of a parsed query as matchable words: quoted phrases
    stay whole and lose their quotes (SUB-232), so `"night drive"` is ONE
    substring word — a plain whitespace split would shred it into `"night` +
    `drive"` and match nothing. */
export function textWords(text: string): string[] {
  return (text.toLowerCase().match(/(?:[^\s"]+|"[^"]*")+/g) ?? [])
    .map((w) => w.replace(/"([^"]*)"/g, "$1"))
    .filter(Boolean);
}

interface ValueSeg {
  value: string;
  /** a `"…"`-wrapped segment — its commas/spaces are literal, and it counts
      as finished for the still-typing rule (a bare segment waits for space) */
  quoted: boolean;
}

/** The OR segments of a raw filter value (SUB-78): split on commas outside
    quotes, unwrap the quoted ones. Empty segments drop out (`a,,b` → a, b). */
function splitValues(raw: string): ValueSeg[] {
  const out: ValueSeg[] = [];
  for (const m of raw.matchAll(/"([^"]*)"|([^,]+)/g))
    out.push(m[1] !== undefined ? { value: m[1], quoted: true } : { value: m[2], quoted: false });
  return out;
}

interface CmpRead {
  key: string;
  op: CmpOp;
  operand: string;
  /** tokens the expression spans — comparisons may be typed with spaces
      (`due < 7d` = 3 tokens, `due <7d` / `due< 7d` = 2, `due<7d` = 1) */
  len: number;
  /** the first token carried a `-` prefix (`-due < 7d`, SUB-198) */
  neg: boolean;
}

/** The comparison starting at tokens[i], on shape alone — whether the operand
    is a real date/duration is the caller's call (a half-typed one still wants
    completions). Null when the shape isn't a comparison at all. */
function readComparison(tokens: string[], i: number): CmpRead | null {
  const raw = tokens[i];
  // a `-` only ever rides the first token (`-due < 7d`); `- due < 7d` keeps
  // the hyphen a plain-text word
  const neg = raw.length > 1 && raw.startsWith("-");
  const tok = neg ? raw.slice(1) : raw;
  const whole = tok.match(CMP_WHOLE_RE);
  if (whole) return { key: whole[1], op: whole[2] as CmpOp, operand: whole[3], len: 1, neg };
  const head = tok.match(CMP_HEAD_RE);
  if (head)
    return i + 1 < tokens.length
      ? { key: head[1], op: head[2] as CmpOp, operand: tokens[i + 1], len: 2, neg }
      : { key: head[1], op: head[2] as CmpOp, operand: "", len: 1, neg };
  if (KEY_RE.test(tok) && i + 1 < tokens.length) {
    const tail = tokens[i + 1].match(CMP_TAIL_RE);
    if (tail) {
      if (tail[2]) return { key: tok, op: tail[1] as CmpOp, operand: tail[2], len: 2, neg };
      return i + 2 < tokens.length
        ? { key: tok, op: tail[1] as CmpOp, operand: tokens[i + 2], len: 3, neg }
        : { key: tok, op: tail[1] as CmpOp, operand: "", len: 2, neg };
    }
  }
  return null;
}

interface IndexedQueryToken {
  raw: string;
  start: number;
  end: number;
}

/** The applied-filter key spans in a saved query, using the same token and
    commitment rules as parseQuery. This feeds the browser mock: production
    owns its equivalent in Rust, while mock database administration must still
    keep saved pins truthful. */
function savedQueryFilterKeyRange(
  tokens: IndexedQueryToken[],
  index: number,
  numberKind: boolean
): { start: number; end: number } | null {
  const token = tokens[index];
  const raw = token.raw;
  if (/^"[^"]*"$/.test(raw)) return null;
  const neg = raw.length > 1 && raw.startsWith("-");
  const body = neg ? raw.slice(1) : raw;
  if (URI_RE.test(body) || DRIVE_RE.test(body)) return null;
  const key = /^\p{L}[\p{L}\p{N}_#-]*/u.exec(body)?.[0];
  if (!key) return null;
  const range = {
    start: token.start + (neg ? 1 : 0),
    end: token.start + (neg ? 1 : 0) + key.length,
  };

  const classic = body.match(OP_RE);
  if (classic) {
    const segs = splitValues(classic[2]);
    if (segs.some((seg) => seg.value.length > 0)) return range;
    // An explicit empty quoted segment does not consume a following token,
    // while a truly empty value may do so under parseQuery's spaced-value rule.
    if (segs.length > 0) return null;
    const next = tokens[index + 1]?.raw;
    if (!next) return null;
    const nextBody = next.length > 1 && next.startsWith("-") ? next.slice(1) : next;
    if (
      OP_RE.test(nextBody) ||
      CMP_WHOLE_RE.test(nextBody) ||
      CMP_HEAD_RE.test(nextBody) ||
      URI_RE.test(nextBody) ||
      DRIVE_RE.test(nextBody)
    )
      return null;
    return splitValues(next).some((seg) => seg.value.length > 0) ? range : null;
  }

  const comparison = readComparison(
    tokens.map((candidate) => candidate.raw),
    index
  );
  if (!comparison || comparison.key !== key) return null;
  const operand = comparison.operand.toLowerCase();
  const dateOperand = /^\d+[dw]$/.test(operand) || isIsoDate(operand);
  const numberOperand = numberKind && parseStrictNumber(operand) !== null;
  return dateOperand || numberOperand ? range : null;
}

/** Rename one property key inside real saved-query filters, or clear the
    entire query when that property is removed. Non-filter occurrences and
    unresolved comparisons stay byte-identical. */
export function remapSavedQueryProperty(
  query: string,
  oldName: string,
  newName: string | null,
  numberKind: boolean
): string | null {
  const tokens: IndexedQueryToken[] = [...query.matchAll(/(?:[^\s"]+|"[^"]*")+/g)].map(
    (match) => ({ raw: match[0], start: match.index, end: match.index + match[0].length })
  );
  const folded = oldName.toLowerCase();
  const ranges = tokens
    .map((_, index) => savedQueryFilterKeyRange(tokens, index, numberKind))
    .filter((range): range is { start: number; end: number } => range !== null)
    .filter((range) => query.slice(range.start, range.end).toLowerCase() === folded);
  if (ranges.length === 0) return query;
  if (newName === null) return null;

  let out = "";
  let cursor = 0;
  for (const range of ranges) {
    out += query.slice(cursor, range.start) + newName;
    cursor = range.end;
  }
  return out + query.slice(cursor);
}

/** The ISO day a comparison operand targets. A duration (`7d`, `2w`) measures
    FROM `today`, so `due < 7d` reads "due earlier than 7 days from today" —
    which naturally includes anything overdue — and `due > 2w` is later than a
    fortnight out. An ISO date targets itself. Null when the operand is
    neither: not a date comparison. */
export function compareTarget(operand: string, today: string): string | null {
  return durationFrom(operand, today) ?? (isIsoDate(operand) ? operand : null);
}

/** What a comparison operand resolves to, given the key (SUB-639). A
    number-kind key reads a bare number as a numeric threshold — `price > 500`
    compares by value, the identity the column's sort and footer already use.
    Every other key keeps the date grammar (duration / ISO day) untouched, and
    a number-kind key still accepts a date operand for the odd date written in
    a number column. Null when the operand resolves to neither: not a
    comparison, so the tokens fall through to plain text exactly as before. */
export function resolveCompare(
  key: string,
  operand: string,
  today: string,
  schema?: QuerySchema
): { num: number } | { day: string } | null {
  if (numberKind(key, schema)) {
    const n = parseStrictNumber(operand);
    if (n !== null) return { num: n };
  }
  const day = compareTarget(operand, today);
  return day === null ? null : { day };
}

/** Numbers compare by value; the operators read the same as for days. */
function compareNumbers(actual: number, op: CmpOp, target: number): boolean {
  switch (op) {
    case "<":
      return actual < target;
    case ">":
      return actual > target;
    case "<=":
      return actual <= target;
    case ">=":
      return actual >= target;
  }
}

/** ISO days compare lexicographically — zero-padded y/m/d is chronological. */
function compareDates(actual: string, op: CmpOp, target: string): boolean {
  switch (op) {
    case "<":
      return actual < target;
    case ">":
      return actual > target;
    case "<=":
      return actual <= target;
    case ">=":
      return actual >= target;
  }
}

export function parseQuery(q: string, today = todayIso(), schema?: QuerySchema): ParsedQuery {
  const tokens = tokenize(q);
  const filters: QueryFilter[] = [];
  const words: string[] = [];
  const phrases: string[] = [];
  let trailing: ParsedQuery["trailing"] = null;
  const cursorInLastToken = !/\s$/.test(q);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    // a pasted URI or path matches the operator shape ("file:" + rest) but
    // is never a filter (SUB-219 widened the old http(s)-only exemption)
    if (URI_RE.test(tok) || DRIVE_RE.test(tok)) {
      words.push(tok);
      continue;
    }
    // a fully quoted token is a phrase (SUB-219): neither words nor a
    // filter — callers match it as an exact substring. An unclosed quote is
    // still being typed and tokenizes to bare words, as before.
    const phrase = /^"([^"]*)"$/.exec(tok);
    if (phrase) {
      if (phrase[1]) phrases.push(phrase[1]);
      continue;
    }
    // SUB-198: a `-` directly prefixing a filter shape negates it. Anything
    // else keeps the hyphen literal — `-foo` and `foo-bar` stay text words.
    const neg = tok.length > 1 && tok.startsWith("-");
    const body = neg ? tok.slice(1) : tok;
    if (neg && (URI_RE.test(body) || DRIVE_RE.test(body))) {
      words.push(tok);
      continue;
    }
    const m = body.match(OP_RE);
    if (m) {
      const key = m[1].toLowerCase();
      let segs = splitValues(m[2]);
      let raw = m[2];
      let spaced = false;
      // "Status: mastering" — a space after the colon splits the value into
      // the next token; consume it unless it's an operator/URL of its own
      if (segs.length === 0 && i + 1 < tokens.length) {
        const next = tokens[i + 1];
        // a `-`-prefixed operator is an operator, not a value (SUB-198)
        const nbody = next.length > 1 && next.startsWith("-") ? next.slice(1) : next;
        if (!OP_RE.test(nbody) && !CMP_WHOLE_RE.test(nbody) && !CMP_HEAD_RE.test(nbody) && !URI_RE.test(nbody) && !DRIVE_RE.test(nbody)) {
          segs = splitValues(next);
          raw = next;
          spaced = true;
          i++;
        }
      }
      const lower = segs.map((s) => ({ value: s.value.toLowerCase(), quoted: s.quoted }));
      // still being typed — offer completions instead of filtering on a stub.
      // A bare last segment (or a dangling comma) is the partial; a quote-closed
      // unspaced value counts as committed, a spaced value waits for a space.
      const openTail =
        lower.length === 0 || raw.endsWith(",") || spaced || !lower[lower.length - 1].quoted;
      if (i === tokens.length - 1 && cursorInLastToken && openTail) {
        const committed = lower.map((s) => s.value);
        const partial = raw.endsWith(",") || committed.length === 0 ? "" : committed.pop()!;
        trailing = { key, values: committed.filter(Boolean), partial, op: ":", ...(neg ? { neg: true } : {}) };
        continue;
      }
      const values = lower.map((s) => s.value).filter(Boolean);
      if (values.length) filters.push({ key, values, ...(neg ? { neg: true } : {}) });
      continue;
    }
    const cmp = readComparison(tokens, i);
    if (cmp) {
      const key = cmp.key.toLowerCase();
      const operand = cmp.operand.toLowerCase();
      const endsAt = i + cmp.len - 1;
      if (endsAt === tokens.length - 1 && cursorInLastToken) {
        // half-typed comparison — completions, no filter yet
        trailing = { key, values: [], partial: operand, op: cmp.op, ...(cmp.neg ? { neg: true } : {}) };
        i = endsAt;
        continue;
      }
      if (operand && resolveCompare(key, operand, today, schema) !== null) {
        filters.push({ key, values: [operand], op: cmp.op, ...(cmp.neg ? { neg: true } : {}) });
        i = endsAt;
        continue;
      }
      // an operand that resolves to neither a day nor (number keys) a number
      // is no comparison —
      // nothing is consumed and the tokens parse on their own, so a trailing
      // `status:live` still lands as a classic filter (the URL rule again)
    }
    words.push(tok);
  }

  return { text: words.join(" "), phrases, filters, trailing };
}

/** Case-insensitive match: exact or prefix, so `status:master` hits "mastering". */
function valueMatches(actual: string | undefined, wanted: string): boolean {
  if (actual === undefined) return false;
  const a = actual.toLowerCase();
  return a === wanted || a.startsWith(wanted);
}

/** Match on a number-kind column (SUB-639): equality of VALUE, so
    `price:1200` hits a cell written `1200.0` and does NOT hit 12000 the way
    prefix matching did. Only when both sides parse as numbers — a text
    operand (`price:tbd`) or a non-numeric cell falls back to the classic
    exact-or-prefix rule, which is what makes a mid-typed `price:1` still
    narrow to nothing surprising rather than blanking the column. */
function numberMatches(actual: string | undefined, wanted: string): boolean {
  if (actual === undefined) return false;
  const an = parseStrictNumber(actual);
  const wn = parseStrictNumber(wanted);
  if (an === null || wn === null) return valueMatches(actual, wanted);
  return an === wn;
}

/** A prop's individual values — a multi-value prop (relation list) filters
    per entry, not as one joined string. */
export function propValues(n: NoteMeta, key: string): string[] {
  // filter keys arrive lowercased from the parse while frontmatter keeps the
  // author's spelling — fold like every other prop read (SUB-916)
  const v = n.props[foldedPropKey(n.props, key)];
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [typeof v === "string" ? v : JSON.stringify(v)];
}

export function matchesFilters(
  n: NoteMeta,
  filters: QueryFilter[],
  today = todayIso(),
  schema?: QuerySchema
): boolean {
  return filters.every((f) => {
    const actual = f.key === "folder" ? [n.folder || ""] : propValues(n, f.key);
    const op = f.op ?? ":";
    // SUB-198: a negated filter hits exactly when the positive form would not
    const neg = f.neg ?? false;
    // SUB-639: a number-kind column has numeric identity, not text identity
    const numeric = f.key !== "folder" && numberKind(f.key, schema);
    // OR over the filter's values (SUB-78): any one hitting is enough
    if (op === ":") {
      const match = numeric ? numberMatches : valueMatches;
      const hit = f.values.some((w) => actual.some((v) => match(v, w)));
      return neg ? !hit : hit;
    }
    // date comparison (SUB-66): the prop must hold an ISO day satisfying the
    // relation against the operand's target day (`due < 7d` hits due days
    // earlier than today+7d, overdue included). A timed value (SUB-270)
    // compares on its day part. A missing prop or a non-date value never
    // satisfies a comparison — so under negation it always hits; an
    // unresolvable operand leaves the filter inert either way, so a
    // half-typed `due < 7` doesn't blank the list.
    //
    // A range (SUB-596) hits when the WHOLE span satisfies the relation. For
    // the forward operators that is the start, exactly as before; for `<` it
    // means the end decides, which is the overdue rule the calendar and the
    // tray already use — `due < today` skips a span still running and catches
    // it the day after it closes. A single date has one endpoint, so nothing
    // about its behaviour changes.
    //
    // On a number-kind key (SUB-639) the operand is a bare number and the
    // relation is numeric: `price > 500` keeps 1200, drops 120.5. Cells that
    // aren't numbers never satisfy it, exactly as non-dates never satisfy a
    // date comparison.
    const resolved = resolveCompare(f.key, f.values[0] ?? "", today, schema);
    if (resolved === null) return true;
    if ("num" in resolved) {
      const hitN = actual.some((v) => {
        const a = parseStrictNumber(v);
        return a !== null && compareNumbers(a, op, resolved.num);
      });
      return neg ? !hitN : hitN;
    }
    const target = resolved.day;
    const hit = actual.some((v) => {
      const range = splitDateRange(v);
      if (range === null) return false;
      return (
        compareDates(range.start.day, op, target) &&
        (range.end === null || compareDates(range.end.day, op, target))
      );
    });
    return neg ? !hit : hit;
  });
}

/** Props a new entry inherits from the active filter (SUB-234): each simple
    bare `key:value` term pins that prop, so an entry born under `status:live`
    is born status:live and stays visible. Only single exact-value terms
    inherit — negations, date comparisons, OR lists and quoted phrases don't
    pin one value — and `folder` is placement, not a prop. Values arrive
    lowercased from the parse, which is also how the filter reads them back.
    First term per key wins. */
export function filterInherits(filters: QueryFilter[]): [string, string][] {
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const f of filters) {
    if (f.neg || (f.op ?? ":") !== ":" || f.values.length !== 1) continue;
    const v = f.values[0];
    if (!v || /\s/.test(v) || f.key === "folder" || seen.has(f.key)) continue;
    seen.add(f.key);
    out.push([f.key, v]);
  }
  return out;
}

/** Distinct completion values for a partially typed operator, recency-ordered. */
export function filterCompletions(
  notes: NoteMeta[],
  key: string,
  partial: string
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of notes) {
    const values = key === "folder" ? [n.folder] : propValues(n, key);
    for (const v of values) {
      if (!v) continue;
      const lower = v.toLowerCase();
      if (partial && !lower.startsWith(partial)) continue;
      if (seen.has(lower)) continue;
      seen.add(lower);
      out.push(v);
      if (out.length >= 6) return out;
    }
  }
  return out;
}

/** Display spelling of one filter, for completion chips: `status:live`,
    `category:label, festival`, `due < 2026-08-01`. A negated filter (SUB-198)
    reads with a `not ` prefix: `not status:live`. */
export function filterLabel(key: string, op: FilterOp, values: string[], neg = false): string {
  const label = op === ":" ? `${key}:${values.join(", ")}` : `${key} ${op} ${values[0] ?? ""}`;
  return neg ? `not ${label}` : label;
}

/** Rebuild the query with the trailing operator token completed to `value`.
    Classic filters complete to `key:value`; a multi-value stub keeps its
    comma-committed prefix verbatim (`category:Label,Fes` → `category:Label,Festival `).
    Comparisons replace the whole trailing expression (`due < 20…`) with the
    spaced `key <op> value` form. A negated stub (SUB-198) keeps its `-` —
    captured and re-emitted by the classic path, survived positionally by the
    comparison path, whose match never includes the prefix. */
export function completeFilter(q: string, key: string, value: string, op: FilterOp = ":"): string {
  const v = /[\s,]/.test(value) ? `"${value}"` : value;
  if (op === ":")
    // the optional leading group swallows a spaced stub ("Status: mas" → one filter)
    return q.replace(/(?:(\p{L}[\p{L}\p{N}_#-]*):\s+)?(-?)(\S*)$/u, (_all, spacedKey: string | undefined, neg: string, tok: string) => {
      const cut = tok.lastIndexOf(",");
      if (cut < 0) return `${neg}${key}:${v}`;
      // keep the comma-committed prefix verbatim; the spaced form re-adds the key
      const head = tok.slice(0, cut + 1);
      return spacedKey !== undefined ? `${neg}${key}:${head}${v}` : `${neg}${head}${v}`;
    }) + " ";
  return q.replace(/\p{L}[\p{L}\p{N}_#-]*\s*(?:<=|>=|<|>)\s*\S*$/u, `${key} ${op} ${v}`) + " ";
}

/** A dead-end hint under a filter bar's zero rows (SUB-266): `text` is the
    one-line muted hint; `fixedQuery`, when present, is the corrected query a
    click applies. */
export interface FilterHint {
  text: string;
  fixedQuery?: string;
}

/** Serialize one parsed filter back to query syntax (values re-quoted as
    needed) — the keep-rest of a did-you-mean rewrite. */
function serializeFilter(f: QueryFilter): string {
  const neg = f.neg ? "-" : "";
  if ((f.op ?? ":") === ":") {
    const vals = f.values.map((v) => (/[\s,]/.test(v) ? `"${v}"` : v)).join(",");
    return `${neg}${f.key}:${vals}`;
  }
  return `${neg}${f.key} ${f.op} ${f.values[0] ?? ""}`;
}

/** Why a filter bar came up empty, in one line (SUB-266). Two heuristics, in
    order: (a) a filter key the type doesn't have (`no property "statsu"`,
    trailing stub included — it can't start matching); (b) a filter's value
    plus the bare words after it re-joins to an existing value of that prop
    (`status:in` + `review` → `did you mean status:"in review"?`, clickable —
    the rewrite keeps the query's other terms). `columns` is the type's
    dbColumns union; values in use come from the notes plus the schema's
    select options. Null when neither heuristic fires. */
export function filterDeadEndHint(
  notes: NoteMeta[],
  columns: string[],
  typeSchema: Record<string, PropSchema>,
  query: string
): FilterHint | null {
  const parsed = parseQuery(query, undefined, typeSchema);
  const known = new Set([...columns.map((c) => c.toLowerCase()), "folder"]);

  // (a) a filter whose key the type doesn't have can never match
  for (const f of parsed.filters) {
    if (!known.has(f.key)) return { text: `no property "${f.key}"` };
  }
  if (parsed.trailing && !known.has(parsed.trailing.key)) {
    return { text: `no property "${parsed.trailing.key}"` };
  }

  // (b) value + following bare words re-joined hits a real value
  const words = textWords(parsed.text);
  if (words.length === 0) return null;
  for (const f of parsed.filters) {
    if (f.neg || (f.op ?? ":") !== ":" || f.values.length === 0) continue;
    // values in use for this prop (folder reads the note's folder), original
    // casing kept for display — notes first, then schema options
    const existing = new Map<string, string>();
    const add = (v: string) => {
      if (v && !existing.has(v.toLowerCase())) existing.set(v.toLowerCase(), v);
    };
    for (const n of notes) {
      if (f.key === "folder") add(n.folder);
      else for (const v of propValues(n, f.key)) add(v);
    }
    for (const o of typeSchema[f.key]?.options ?? []) add(o.value);
    if (existing.size === 0) continue;
    const base = f.values.join(" ");
    for (let k = 1; k <= words.length; k++) {
      const hit = existing.get(`${base} ${words.slice(0, k).join(" ")}`);
      if (!hit) continue;
      const v = /[\s,]/.test(hit) ? `"${hit}"` : hit;
      const parts = parsed.filters.filter((g) => g !== f).map(serializeFilter);
      parts.push(`${f.key}:${v}`);
      // a still-typed trailing stub comes along (committed form — the same
      // narrowing the live stub already applies)
      if (parsed.trailing) {
        const t = parsed.trailing;
        const vals = t.partial ? [...t.values, t.partial] : t.values;
        parts.push(serializeFilter({ key: t.key, values: vals, op: t.op, neg: t.neg }));
      }
      // quoted phrases ride along re-quoted (SUB-704) — ahead of the bare
      // leftover words: the rebuild descends most-structured → least
      // (filters, stub, exact phrases, words)
      for (const p of parsed.phrases) parts.push(`"${p}"`);
      const rest = words.slice(k);
      if (rest.length > 0) parts.push(rest.join(" "));
      return {
        text: `did you mean ${f.key}:${v}?`,
        fixedQuery: parts.join(" "),
      };
    }
  }
  return null;
}
