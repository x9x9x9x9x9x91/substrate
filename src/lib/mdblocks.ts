// One scanner for the block level of the markdown both static surfaces
// understand: the print renderer (note → PDF) and the hub dashboard's
// column-first home page. Each of them used to carry its own copy of the same
// walk — fence, heading, rule, quote, table, list, paragraph — and the copies
// had drifted apart in exactly one place (see `splitListsOnMarkerFlip`).
//
// This module owns the GRAMMAR only. The two surfaces still own their own
// output: print concatenates an HTML string, the hub builds React nodes with
// live widgets in the fence slots, and their inline (emphasis, wikilink,
// embed) renderers are different implementations of a different problem. The
// editor's CodeMirror rendering is a third surface and is deliberately NOT
// folded in here — it decorates a live document in place rather than walking
// a finished one.
//
// Pure TS, erasable syntax only — runs in the app and under `node --test`.

import { fenceCloses, fenceOpening } from "./fences.ts";

/** A list item's body plus its checkbox state; `done` is null when the item
    is not a task at all (an ordinary bullet). */
export interface MdListItem {
  /** the item's text with the marker — and the `[ ]` box — already stripped */
  text: string;
  done: boolean | null;
  /** the item's line index within the text the scanner was handed (0-based).
      The one piece of provenance a rendering that stays LIVE needs: a task
      box drawn from this item writes its toggle back to this line. Static
      surfaces ignore it. */
  line: number;
}

export type MdBlock =
  /** A fenced block, in every spelling CommonMark calls one: three or more
      backticks or tildes, up to three spaces of indent. `lang` is the info
      string's first word verbatim, with the info string's own leading
      whitespace already off the way CommonMark takes it (``` view is `view`;
      callers that match on it fold case themselves); `tail` is the rest of
      the info string INCLUDING its leading whitespace, which is what tells a
      live machine fence (```calendar) from a tailed opener that is only prose
      (```calendar month). `inner` excludes
      both fence lines, with the opener's indent removed from each line the
      way CommonMark removes it. */
  | { kind: "fence"; lang: string; tail: string; inner: string }
  /** `level` is the number of `#`; the hub renders one heading style and
      ignores it, print maps it to h1..h6. */
  | { kind: "heading"; level: number; text: string }
  | { kind: "hr" }
  /** the quote's contents with one level of `> ` removed — the caller scans
      it again, so nesting is the caller's own recursion */
  | { kind: "quote"; inner: string }
  /** cells are already trimmed; a short row stays short (nothing is padded
      out to the header's width) */
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "list"; ordered: boolean; items: MdListItem[] }
  /** consecutive non-blank lines; the caller joins them with its own soft
      break */
  | { kind: "para"; lines: string[] };

export interface MdScanOptions {
  /** Whether a marker-kind flip inside a run of list lines (bullets → numbers
      or back) ends the list and starts a new one.

      This is the one place the two copies of the walk disagreed, and both
      readings are defensible, so it stays a caller's choice rather than being
      quietly unified: print splits, because an `<ol>` that swallowed a
      following bullet run would print the bullets as numbers; the hub does
      not, because its list renderer never re-marks the items it consumes. */
  splitListsOnMarkerFlip: boolean;
}

// the info string of an opener, split the way MdBlock's `lang`/`tail` are:
// the first word, then the rest INCLUDING its leading whitespace. The run
// itself and the CommonMark rules around it (tildes, indent, runs longer than
// three, what closes what) live in `fences.ts` — one grammar, so a spelling
// the column parser hides markers inside is a spelling this opens.
//
// The info string's own LEADING whitespace comes off before the split, which
// is CommonMark's rule and lezer's reading of it: "``` view" names the
// language `view`, the same as "```view". Splitting the untrimmed remainder
// gave `lang: ""` and a tail of " view", so the editor drew that fence's
// widget live (it reads lezer's CodeInfo) while these static surfaces printed
// its config as a code box — one note rendering two ways.
const FENCE_INFO_RE = /^(\S*)([\s\S]*)$/;
const FENCE_INFO_INDENT_RE = /^[ \t]+/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/;
const QUOTE_RE = /^\s*>/;
const QUOTE_STRIP_RE = /^\s*>\s?/;
// the marker is captured so a run can tell bullets from numbers; the ordered
// branch is the one that leaves group 1 undefined
const LIST_RE = /^\s*(?:([-*+])|\d+[.)])\s+(.*)$/;
const TASK_BODY_RE = /^\[([ xX])\]\s+(.*)$/;

function tableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** A fence body line with the opener's own indent taken off — CommonMark's
    rule, and the one that keeps an indented ```view fence's config parseable
    rather than uniformly shifted. Only spaces the opener itself carried are
    removed; deeper indentation is the author's. */
function stripIndent(line: string, indent: number): string {
  let cut = 0;
  while (cut < indent && line[cut] === " ") cut++;
  return line.slice(cut);
}

const isTableDivider = (l: string) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes("-");

/** The document as blocks, in reading order.

    Line endings are the caller's business: this splits on "\n" only, so a
    surface that must tolerate CRLF normalizes before calling (print does;
    the hub's bodies come from the vault reader already normalized). */
export function scanMdBlocks(md: string, opts: MdScanOptions): MdBlock[] {
  const lines = md.split("\n");
  const out: MdBlock[] = [];
  let i = 0;
  const para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push({ kind: "para", lines: [...para] });
      para.length = 0;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    // the opener accepts a full info string (```rust ignore, ```js title=x) —
    // only the closer is bare, so a spaced info string must not demote the
    // opener to prose and promote its closer to an opener
    const run = fenceOpening(line);
    if (run !== null) {
      flushPara();
      const indent = line.indexOf(run[0]);
      const info = FENCE_INFO_RE.exec(
        line
          .slice(indent + run.length)
          .replace(/\r$/, "")
          .replace(FENCE_INFO_INDENT_RE, "")
      )!;
      const code: string[] = [];
      i++;
      while (i < lines.length && !fenceCloses(lines[i], run)) code.push(stripIndent(lines[i++], indent));
      i++; // closing fence (or EOF)
      out.push({ kind: "fence", lang: info[1], tail: info[2], inner: code.join("\n") });
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushPara();
      out.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      flushPara();
      out.push({ kind: "hr" });
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i]))
        quote.push(lines[i++].replace(QUOTE_STRIP_RE, ""));
      out.push({ kind: "quote", inner: quote.join("\n") });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushPara();
      const head = tableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "")
        rows.push(tableRow(lines[i++]));
      out.push({ kind: "table", head, rows });
      continue;
    }
    const list = LIST_RE.exec(line);
    if (list) {
      flushPara();
      const ordered = list[1] === undefined;
      const items: MdListItem[] = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m) break;
        if (opts.splitListsOnMarkerFlip && (m[1] === undefined) !== ordered) break;
        const task = TASK_BODY_RE.exec(m[2]);
        if (task) items.push({ text: task[2], done: task[1] !== " ", line: i });
        else items.push({ text: m[2], done: null, line: i });
        i++;
      }
      out.push({ kind: "list", ordered, items });
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out;
}
