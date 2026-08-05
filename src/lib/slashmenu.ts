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
     completes from live database names (no exact recall needed). */

import type { SyntaxNode } from "@lezer/common";
import { NO_MATCH, fuzzyScore } from "./fuzzy.ts";
import { todayIso } from "./dates.ts";

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
    { name: "task", detail: "checkbox item", insert: "- [ ] ", cursor: 6 },
    // asset embeds are `![[name]]` (vault-format §5.4) — cursor between the
    // brackets, ready for the name
    { name: "asset", detail: "embed a file", insert: "![[]]", cursor: 3 },
  ];
}

/** Commands ranked for the popup: fuzzy score descending, alphabetical
    tiebreak, misses dropped. An empty query lists all four in a stable
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

/** Database types ranked for the `type:` popup: fuzzy, alphabetical tiebreak,
    blanks and duplicates dropped. */
export function viewTypeOptions(query: string, dbTypes: string[]): string[] {
  const seen = new Set<string>();
  const out: { type: string; score: number }[] = [];
  for (const raw of dbTypes) {
    const type = raw.trim();
    if (!type || seen.has(type)) continue;
    seen.add(type);
    const score = fuzzyScore(query, type);
    if (score === NO_MATCH) continue;
    out.push({ type, score });
  }
  out.sort((a, b) => b.score - a.score || a.type.localeCompare(b.type));
  return out.map((entry) => entry.type);
}
