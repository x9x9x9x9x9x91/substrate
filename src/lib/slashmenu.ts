/* Slash menu: the pure half of the `/` insertion palette — trigger
   detection, command ranking, insert text — kept free of CodeMirror so it runs
   under node --test. Editor.tsx wraps these in CompletionSources, the same
   autocompletion infrastructure the [[ wikilink popup rides (see wikilinks.ts).

   Two triggers live here:
   - `slashQuery` — a `/` that opens a line (nothing but whitespace before it),
     so a URL's slashes and mid-sentence prose never pop the menu. Text alone
     can't tell a shell path from prose, so `inCodeContext` gates it on the
     syntax tree: inside code, a leading `/` is literal.
   - `viewTypeQuery` — the `type:` line inside an open ```view fence, which
     completes from live database names (no exact recall needed).
   - `viewKeyQuery` / `viewValueQuery` — the rest of that fence: a bare word on
     a fresh line is a KEY being typed, and `saved:`/`sort:`/`columns:`/`query:`
     complete from the fence's own database. Nothing about a fence should be
     learnable only by typing something wrong and reading the error. */

import type { SyntaxNode } from "@lezer/common";
import { NO_MATCH, fuzzyScore } from "./fuzzy.ts";
import { todayIso } from "./dates.ts";
import { isFilterableKey } from "./query.ts";

/** `/` at line start (or after only whitespace) + the typed word. The query
    stops at whitespace: once you type a space the menu is done guessing. */
const SLASH_OPEN_RE = /(?:^|\n)[ \t]*\/([A-Za-z]*)$/;

/** The typed fragment when `textBefore` (doc text up to the cursor) ends in an
    open line-initial `/…`, else null. An empty string means the bare `/` was
    just typed — the menu opens listing everything.

    Text alone can't tell `/usr/local/bin` in a shell fence from a command, so
    callers must gate on `inCodeContext` too — see `slashCompletions`. */
export function slashQuery(textBefore: string): string | null {
  const m = SLASH_OPEN_RE.exec(textBefore);
  return m ? m[1] : null;
}

/** Node type names the Lezer markdown parser produces for code, at the cursor
    or above it. Verified against the parser this app configures
    (`markdown({ codeLanguages: languages })`) at the positions that matter:
    - ```` ```bash ```` / ```` ```js ```` and any other nested language — the
      cursor's own node is anonymous (empty name), parent `FencedCode`;
    - a bare ```` ``` ```` or ```` ```view ```` fence, which has no nested
      language — `CodeText` inside `FencedCode`;
    - an indented (4-space) code block — `CodeText` inside `CodeBlock`;
    - an inline `` `…` `` span — `InlineCode` (`CodeMark` on its delimiters).
    So the walk has to look at ancestors, not just the resolved node: inside a
    highlighted fence the node itself is nameless. */
const CODE_NODE_RE = /^(FencedCode|CodeBlock|CodeText|InlineCode|CodeMark)$/;

/** True when `node` (the innermost node at the cursor) sits in code — a fenced
    block, an indented block, or an inline span. A leading `/` there is literal
    text: a path, a regex, a shell command. */
export function inCodeContext(node: SyntaxNode | null): boolean {
  for (let n: SyntaxNode | null = node; n; n = n.parent) {
    if (CODE_NODE_RE.test(n.type.name)) return true;
  }
  return false;
}

export interface SlashCommand {
  /** the word typed after `/`, and the popup label */
  name: string;
  /** one-line right-hand hint in the popup */
  detail: string;
  /** text that replaces the whole `/…` token */
  insert: string;
  /** where the cursor lands, as an offset into `insert` */
  cursor: number;
}

/** A fence scaffold: `body` lines between the ```lang fences, cursor at the
    end of the FIRST body line — the first config value, so accepting the
    command and typing continues straight into the fence's one blank the
    parser needs filled. The body is each parser's required keys (plus a
    universal default where one exists, like `value: count`), so the fence's
    own error sentence — which names exactly the missing key — guides the rest. */
function fenceCommand(name: string, detail: string, body: string[]): SlashCommand {
  const head = "```" + name + "\n" + body[0];
  return {
    name,
    detail,
    insert: "```" + name + "\n" + body.join("\n") + "\n```",
    cursor: head.length,
  };
}

/** The one machine fence whose subject is written in the INFO STRING, not the
    body: a kind fence names its kind after the lang word (```kind gear-log),
    and its body is config whose keys belong to that kind rather than to any
    parser here. So the scaffold cannot go through `fenceCommand` — that lands
    the cursor on the first body line, which for this fence is the one place
    nobody can be told what to type. The cursor goes where the id goes, and
    the body is left empty because config is optional. */
function kindCommand(): SlashCommand {
  const head = "```kind ";
  return {
    name: "kind",
    detail: "a custom kind from .vault/kinds/",
    insert: head + "\n```",
    cursor: head.length,
  };
}

/** The smallest table the renderer accepts: a header row, the delimiter row
    that makes it a table at all, and one body row — two columns each. Cells
    start empty because the first thing anyone does is name the columns, and
    the cursor is already in the first of them. Accepting the command leaves
    the cursor inside the table's own lines, which is what keeps it showing as
    editable pipes rather than collapsing to the rendered grid mid-typing. */
function tableCommand(): SlashCommand {
  const row = "|  |  |";
  return {
    name: "table",
    detail: "2×2 table with a header row",
    insert: row + "\n| --- | --- |\n" + row,
    cursor: 2,
  };
}

/** Insert text is built per accept so `/date` is the day you accept it, not
    the day the module loaded. */
export function slashCommands(): SlashCommand[] {
  const fence = "```view\ntype: \n```";
  return [
    {
      name: "view",
      detail: "live database table",
      insert: fence,
      // land on the `type:` line's value — where the db-name completion fires
      cursor: fence.indexOf("type: ") + "type: ".length,
    },
    { name: "date", detail: "today, ISO", insert: todayIso(), cursor: todayIso().length },
    // the two computing syntaxes (vault-format §5.9/§5.10). Both are bare
    // punctuation nobody guesses, which is the whole reason they are here: the
    // detail line is where the grammar is advertised, and the answer renders
    // beside the line rather than being written into the file.
    { name: "calc", detail: "line that computes — 12 + 3, 20kg in lb", insert: "= ", cursor: 2 },
    // `` `= expr` `` mid-sentence — cursor inside the span, where the
    // sheet-name popup fires (see liveBindQuery)
    { name: "live", detail: "sheet value inside a sentence", insert: "`= `", cursor: 3 },
    { name: "task", detail: "checkbox item", insert: "- [ ] ", cursor: 6 },
    // asset embeds are `![[name]]` (vault-format §5.4) — cursor between the
    // brackets, ready for the name
    { name: "asset", detail: "embed a file", insert: "![[]]", cursor: 3 },
    tableCommand(),
    // the machine fences (vault-format §5) — scaffolds carry each parser's
    // required keys so nobody recalls fence grammar from memory
    fenceCommand("chart", "chart over a database or sheet", ["source: ", "x: ", "y: count"]),
    fenceCommand("csv", "sheet data rows", [""]),
    fenceCommand("formulas", "sheet formulas", [""]),
    fenceCommand("cards", "stat-card row", ["- label: ", "  bind: "]),
    // the one fence whose scaffold also says what its keys take: `#` comment
    // lines the parser already skips, under the keys so the cursor still lands
    // on the first value. An untouched scaffold renders the fence's own
    // "not filled in yet" state, so the two teach the same thing in two places
    fenceCommand("heatmap", "year-of-days grid", [
      "source: ",
      "date: ",
      "value: count",
      "# source: a database type, or {{Sheet Name}} for a sheet",
      "# date: the date property the squares sit on",
      "# value: count, or sum:<number prop>",
    ]),
    fenceCommand("calendar", "month grid", ["source: ", "date: "]),
    fenceCommand("progress", "goal thermometer", ["label: ", "value: ", "target: "]),
    fenceCommand("timeline", "date-axis lanes", ["source: ", "start: ", "label: "]),
    kindCommand(),
  ];
}

/** Commands ranked for the popup: fuzzy score descending, alphabetical
    tiebreak, misses dropped. An empty query lists everything in a stable
    order (fuzzyScore("") is flat, the tiebreak sorts). */
export function slashOptions(query: string): SlashCommand[] {
  const out: { cmd: SlashCommand; score: number }[] = [];
  for (const cmd of slashCommands()) {
    const score = fuzzyScore(query, cmd.name);
    if (score === NO_MATCH) continue;
    out.push({ cmd, score });
  }
  out.sort((a, b) => b.score - a.score || a.cmd.name.localeCompare(b.cmd.name));
  return out.map((entry) => entry.cmd);
}

/** The info string of the fence the cursor is in, lowercased first word, or
    null outside any fence. Read off the tree rather than scanned backwards
    through text: a text scan finds the nearest ``` but can't tell an opener
    from a closer, so a ```view line nested inside a ```bash block reads as
    "we're in a view fence" when we're in a shell one. The parser already
    knows. Same `CodeInfo` read as Editor's `isViewFence`. */
export function fenceLang(
  node: SyntaxNode | null,
  sliceDoc: (from: number, to: number) => string
): string | null {
  let fence: SyntaxNode | null = node;
  while (fence && fence.type.name !== "FencedCode") fence = fence.parent;
  if (!fence) return null;
  const info = fence.getChild("CodeInfo");
  if (!info) return "";
  return sliceDoc(info.from, info.to).trim().split(/\s+/, 1)[0].toLowerCase();
}

/** `type:` line inside a ```view fence + the typed value. Returns the fragment
    (possibly empty, so the popup opens on a bare `type: `) or null. `lang` is
    `fenceLang`'s verdict: fences of other languages, and text outside any
    fence, return null — as do `saved:`/`query:`/`view:` lines. */
export function viewTypeQuery(textBefore: string, lang: string | null): string | null {
  if (lang !== "view") return null;
  const line = textBefore.slice(textBefore.lastIndexOf("\n") + 1);
  const m = /^[ \t]*type:[ \t]*(.*)$/.exec(line);
  return m ? m[1] : null;
}

/** Where the cursor goes once a ```view fence's `type:`/`saved:` line is
    settled: outside the fence, so the table renders immediately
    instead of leaving you parked in raw fence source you now have to escape.

    `after` is the document text from the cursor to (at least) past the
    fence's closing line — the caller slices a bounded window, since a fence
    body is a handful of lines. All offsets are relative to `after`'s start.

    A landing spot is guaranteed: when the closer is the last line, or the
    line below it already holds text, a blank line is inserted to land on —
    otherwise "after the fence" would mean the middle of the next paragraph.
    Null when no closing fence is in the window: nothing to step out of, so
    the caller leaves the cursor alone. */
export interface FenceExit {
  /** cursor position after the change applies */
  anchor: number;
  /** where `insert` goes (ignored when `insert` is empty) */
  insertAt: number;
  /** "\n" when a blank line has to be made, else "" */
  insert: string;
}

export function fenceExit(after: string): FenceExit | null {
  let at = 0;
  // the first line of `after` is the remainder of the cursor's own line —
  // never the closer, which is why the scan starts at the line below it
  let nl = after.indexOf("\n", at);
  while (nl !== -1) {
    at = nl + 1;
    nl = after.indexOf("\n", at);
    const end = nl === -1 ? after.length : nl;
    if (!after.slice(at, end).trim().startsWith("```")) continue;
    // closer found — land on the line below it if that line is blank,
    // otherwise open one
    if (nl === -1) return { anchor: end + 1, insertAt: end, insert: "\n" };
    const next = after.indexOf("\n", nl + 1);
    const blank = after.slice(nl + 1, next === -1 ? after.length : next).trim() === "";
    return blank
      ? { anchor: nl + 1, insertAt: nl + 1, insert: "" }
      : { anchor: end + 1, insertAt: end, insert: "\n" };
  }
  return null;
}

/** Names ranked for a fence popup: fuzzy score descending, alphabetical
    tiebreak, blanks and duplicates dropped. Every value list in a view fence —
    database types, saved-view names, property names — ranks the same way, so
    they all come through here. */
export function fuzzyNames(query: string, names: string[]): string[] {
  const seen = new Set<string>();
  const out: { name: string; score: number }[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const score = fuzzyScore(query, name);
    if (score === NO_MATCH) continue;
    out.push({ name, score });
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return out.map((entry) => entry.name);
}

/** Database types ranked for the `type:` popup. */
export function viewTypeOptions(query: string, dbTypes: string[]): string[] {
  return fuzzyNames(query, dbTypes);
}

/* ---- the rest of the fence: key names and the other keys' values --------

   `type:` was the one line that completed; every other key was discoverable
   only by typing a wrong one and reading the parser's error. These three
   triggers teach the rest — a key name on a fresh line, and the values of
   `saved:`, `sort:`, `columns:` and `query:` from the fence's own database.
   All of them are text rules; the caller still gates on the syntax tree
   (`fenceLang`), so a `sort:` line inside a ```yaml fence stays literal. */

/** One key of a ```view fence, as the popup shows it. */
export interface ViewFenceKey {
  name: string;
  /** the one-line hint on the popup's right */
  detail: string;
}

/** The keys `parseViewSpec` accepts, in the order a fence is usually written:
    what to show, then how to cut it. Kept in step with embeds.ts's
    `KNOWN_KEYS` by a test — the parser owns the list, this owns the teaching. */
const VIEW_FENCE_KEYS: ViewFenceKey[] = [
  { name: "type", detail: "database to show" },
  { name: "saved", detail: "a pinned view, by name" },
  { name: "query", detail: "filter, e.g. status:live" },
  { name: "view", detail: "layout — table today" },
  { name: "sort", detail: "property, or property:desc" },
  { name: "limit", detail: "most rows to show" },
  { name: "columns", detail: "comma-separated properties" },
];

export function viewFenceKeys(): ViewFenceKey[] {
  return VIEW_FENCE_KEYS.map((key) => ({ ...key }));
}

/** A line inside a fence that is still only a bare word — no colon yet, so
    what's being typed is a KEY. The fence's own ``` lines can't match (they
    start with backticks), which is what keeps the popup off the opener. */
const KEY_LINE_RE = /^[ \t]*([A-Za-z]*)$/;

/** The typed key fragment on the cursor's line inside a ```view fence, or
    null. An empty string means the line is blank — the caller decides whether
    a blank line pops the full key list (it does on an explicit ⌃Space and
    right after `/view` inserts the scaffold, not on every Enter). */
export function viewKeyQuery(textBefore: string, lang: string | null): string | null {
  if (lang !== "view") return null;
  const line = textBefore.slice(textBefore.lastIndexOf("\n") + 1);
  const m = KEY_LINE_RE.exec(line);
  return m ? m[1] : null;
}

/** Keys ranked for the popup, minus the ones this fence already carries: a
    second `sort:` line just shadows the first, so offering it is a trap. */
export function viewKeyOptions(query: string, used: string[] = []): ViewFenceKey[] {
  const taken = new Set(used.map((k) => k.trim().toLowerCase()));
  const keys = viewFenceKeys().filter((key) => !taken.has(key.name));
  const ranked = fuzzyNames(
    query,
    keys.map((key) => key.name)
  );
  return ranked.map((name) => keys.find((key) => key.name === name)!);
}

/** Which value list belongs on the cursor's line:
    - `saved` — pinned view names;
    - `sort` — the database's property names; `sortdir` — asc/desc, once the
      `prop:` half is typed;
    - `columns` — property names, per comma-separated item;
    - `query` — a filter term's property name (`status:`), and `queryvalue`
      the values already in use for that property. */
export type ViewValueSlot = "saved" | "sort" | "sortdir" | "columns" | "query" | "queryvalue";

export interface ViewValueQuery {
  slot: ViewValueSlot;
  /** the typed fragment — the caller replaces exactly this many characters
      back from the cursor */
  query: string;
  /** `queryvalue` only: the property whose values are wanted */
  prop?: string;
}

/** `key: value` on the cursor's own line, value verbatim after the colon. */
const VALUE_LINE_RE = /^[ \t]*([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/;

/** One filter term whose property half is settled — `status:live`. Terms
    carrying a comma-OR list or a quote are left alone: completing inside them
    would replace the wrong slice of what was typed. */
const QUERY_TERM_RE = /^([A-Za-z][\w-]*):([^,"'<>=]*)$/;

/** An odd number of either quote mark — the cursor sits inside a quoted
    phrase the author hasn't closed yet. */
function unclosedQuote(value: string): boolean {
  return value.split('"').length % 2 === 0 || value.split("'").length % 2 === 0;
}

/** The value completion the cursor's line asks for, or null when the line
    wants none — `type:` (owned by `viewTypeQuery`), `limit:` (a number, no
    candidates to offer), `view:` (only `table` renders today), an unknown key,
    or a line outside a ```view fence. */
export function viewValueQuery(textBefore: string, lang: string | null): ViewValueQuery | null {
  if (lang !== "view") return null;
  const line = textBefore.slice(textBefore.lastIndexOf("\n") + 1);
  const m = VALUE_LINE_RE.exec(line);
  if (!m) return null;
  const key = m[1].toLowerCase();
  const value = m[2];
  if (key === "saved") return { slot: "saved", query: value };
  if (key === "sort") {
    const colon = value.lastIndexOf(":");
    return colon === -1
      ? { slot: "sort", query: value }
      : { slot: "sortdir", query: value.slice(colon + 1) };
  }
  if (key === "columns") {
    // each comma-separated item completes on its own; the leading space of
    // "status, artist" belongs to the separator, not to the name being typed
    const item = value.slice(value.lastIndexOf(",") + 1).replace(/^[ \t]+/, "");
    return { slot: "columns", query: item };
  }
  if (key === "query") {
    // an open quote means the cursor is inside a quoted phrase — `status:
    // "in re` — where whitespace no longer ends a term, so nothing here can
    // say which slice a completion would replace
    if (unclosedQuote(value)) return null;
    // filter terms are whitespace-separated; only the one under the cursor
    const term = value.slice(value.lastIndexOf(" ") + 1);
    const settled = QUERY_TERM_RE.exec(term);
    if (settled) return { slot: "queryvalue", prop: settled[1], query: settled[2] };
    return /^[A-Za-z][\w-]*$/.test(term) || term === ""
      ? { slot: "query", query: term }
      : null;
  }
  return null;
}

/** The property names a `query:` term can actually filter by, ranked.

    `columns:` and `sort:` resolve a dotted `relation.property` join
    themselves (embeds.ts, via `isJoinName`), but `query:` runs through
    `filterByQuery` → `matchesFilters` → `propValues`, which reads the row's
    OWN props — and the query grammar's key charclass (`query.ts` KEY_RE)
    has no dot in it, so a dotted term isn't even lexed as a filter. Offering
    a join here would hand the author a term that renders an empty table, so
    the join rows are dropped from this one slot. */
export function viewQueryPropOptions(query: string, names: string[]): string[] {
  return fuzzyNames(query, names.filter(isFilterableKey));
}

/** Sort directions, ranked — the fence accepts either case, the popup teaches
    the lowercase spelling the docs use. */
export function viewSortDirOptions(query: string): string[] {
  return fuzzyNames(query, ["asc", "desc"]);
}

/** The body of the fence the cursor is in — every line between its ``` lines,
    or null outside a fence. Read off the tree for the same reason `fenceLang`
    is: a text scan can't tell an opener from a closer. Callers read the
    fence's own `type:`/`saved:` line out of it, which is what says WHICH
    database's properties the value popups should offer. */
export function fenceInner(
  node: SyntaxNode | null,
  sliceDoc: (from: number, to: number) => string
): string | null {
  let fence: SyntaxNode | null = node;
  while (fence && fence.type.name !== "FencedCode") fence = fence.parent;
  if (!fence) return null;
  const text = sliceDoc(fence.from, fence.to);
  const opener = text.indexOf("\n");
  if (opener === -1) return "";
  const body = text.slice(opener + 1);
  // a fence being typed has no closing line yet; a closed one ends in it
  const lastLine = body.lastIndexOf("\n");
  if (lastLine === -1) return body.trim().startsWith("```") ? "" : body;
  return body.slice(lastLine + 1).trim().startsWith("```") ? body.slice(0, lastLine) : body;
}

/** Every key the fence body already names, lowercased — what `viewKeyOptions`
    drops from the popup. */
export function fenceKeysUsed(inner: string): string[] {
  const out: string[] = [];
  for (const raw of inner.split("\n")) {
    const m = VALUE_LINE_RE.exec(raw);
    if (m) out.push(m[1].toLowerCase());
  }
  return out;
}

/** A pinned saved view as the fence completions need it: the name a `saved:`
    line usually carries, the id that line carries when the name would be
    ambiguous, and the database the pin stands on. */
export interface SavedViewPin {
  id: string;
  name: string;
  db: string;
}

/** The database this fence shows: its own `type:`, else the database behind
    its `saved:` pin. Null when the fence names neither yet — the property
    popups have nothing to offer until it does.

    A `saved:` reference resolves the way `findSavedView` (embeds.ts) resolves
    the same line when it RENDERS the fence: exact id first, then name, both
    trimmed and case-folded. Id form is not exotic — `savedViewFence` writes it
    whenever a pin's name is ambiguous, blank, or carries `:`/`#`, so a fence
    the app's own "Embed in this note" wrote would otherwise render fine while
    offering no completions at all. */
export function fenceDbType(
  inner: string,
  savedViews: { name: string; db: string; id?: string }[] = []
): string | null {
  let saved: string | null = null;
  for (const raw of inner.split("\n")) {
    const m = VALUE_LINE_RE.exec(raw);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (!value) continue;
    if (key === "type") return value;
    if (key === "saved" && saved === null) saved = value;
  }
  if (saved === null) return null;
  const folded = saved.trim().toLowerCase();
  const pin =
    savedViews.find((v) => v.id !== undefined && v.id.trim().toLowerCase() === folded) ??
    savedViews.find((v) => v.name.trim().toLowerCase() === folded);
  return pin?.db ?? null;
}
