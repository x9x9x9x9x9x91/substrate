/** Side-by-side columns on a page. A note that wants two or three columns
 *  says so with three HTML comments and keeps a perfectly ordinary markdown
 *  body between them:
 *
 *      <!-- columns -->
 *      Left column. Headings, lists, tables, images — ordinary markdown.
 *
 *      <!-- col -->
 *      Right column.
 *      <!-- /columns -->
 *
 *  The markers are comments on purpose, and it is the whole design. Every
 *  other markdown reader — GitHub, Obsidian, a `cat` in a terminal — drops an
 *  HTML comment on the floor, so the file it shows is the note's text with the
 *  columns stacked, nothing quoted, nothing hidden, nothing to convert back.
 *  Delete the three lines and the note is unchanged. Nothing here is a machine
 *  fence either (`fences.ts`): column content is real body text, so the search
 *  index reads it and the markdown parser parses it, which is exactly what a
 *  ```` ```columns ```` fence would have cost.
 *
 *  This module is the parse half only, and every surface that lays a page out
 *  reads it: the editor's block widget (`Editor.tsx`), the print/publish
 *  renderer (`print.ts`). Column WIDTHS are not expressible — the grid decides
 *  how a row of columns divides the measure it was given, and a narrow pane
 *  collapses the row to one column. That is the same bargain the hub board
 *  makes with its card rows (`hub.ts`): an author picks the shape, the design
 *  system picks the numbers.
 *
 *  Pure TS, no DOM/node imports: runs in the app and under `node --test`. */

// A marker inside a code fence is code someone is showing, not layout they
// are asking for — and "a code fence" means every spelling of one, which is
// why the scanner is shared with the hub parser rather than spelled here:
// tildes, an indented fence and a run longer than three all hide markers, and
// a four-backtick fence a scanner cannot close would disable columns for the
// rest of the note.
import { fenceCloses, fenceOpening } from "./fences.ts";

/** The three markers, as an author writes them. Exported because
    `docs/vault-format.md` quotes these exact strings and a test reads both. */
export const COLUMNS_OPEN = "<!-- columns -->";
export const COLUMNS_DIVIDER = "<!-- col -->";
export const COLUMNS_CLOSE = "<!-- /columns -->";

// whitespace inside the comment is the author's, and the case is theirs too —
// what must be exact is that the marker is the ONLY thing on its line, or a
// sentence mentioning `<!-- col -->` in prose would split someone's page.
//
// Whitespace means spaces and tabs, and nothing else. A no-break space, a form
// feed or a vertical tab is not indentation an author typed on purpose, and
// admitting them here would put this side out of step with the recognizer the
// indexer runs (`column_marker_re` in src-tauri/src/vault/mod.rs): a line one
// side calls layout and the other calls text is a marker the editor hides and
// search still prints, or the reverse. A trailing `\r` is allowed because a
// CRLF file's lines carry one and a marker is still a marker in one.
// parity/lockstep/column-markers.json holds the cases both sides answer.
const OPEN_RE = /^[ \t]*<!--[ \t]*columns[ \t]*-->[ \t]*\r?$/i;
const DIVIDER_RE = /^[ \t]*<!--[ \t]*col[ \t]*-->[ \t]*\r?$/i;
const CLOSE_RE = /^[ \t]*<!--[ \t]*\/columns[ \t]*-->[ \t]*\r?$/i;

export function isColumnsOpen(line: string): boolean {
  return OPEN_RE.test(line);
}

export function isColumnsDivider(line: string): boolean {
  return DIVIDER_RE.test(line);
}

export function isColumnsClose(line: string): boolean {
  return CLOSE_RE.test(line);
}

/** Any of the three, for a caller that only needs to know a line is layout
    rather than text — the editor hides these while it renders a region. */
export function isColumnsMarker(line: string): boolean {
  return isColumnsOpen(line) || isColumnsDivider(line) || isColumnsClose(line);
}

/** One column's content: the lines between two markers, as line indices into
    the body (0-based, `endLine` exclusive) and as the text itself. */
export interface ColumnPart {
  startLine: number;
  endLine: number;
  text: string;
}

/** A whole `<!-- columns -->` … `<!-- /columns -->` run. `startLine` is the
    opening marker's line and `endLine` the closing one's — both inclusive, so
    a renderer replacing the region covers the markers too. */
export interface ColumnRegion {
  startLine: number;
  endLine: number;
  columns: ColumnPart[];
}

/** Every well-formed column region in a body, in document order.
 *
 *  Well-formed means opened and closed, with the markers each alone on a line
 *  and outside any code fence. Anything else is not a region and the marker
 *  lines stay the literal text they are — an unclosed opener, or an opener
 *  inside another region, renders as itself rather than swallowing the rest of
 *  the page into a layout nobody asked for. Scanning restarts AT the offending
 *  opener rather than past it, so a stray marker above a real region costs
 *  only itself.
 *
 *  A region with no divider is one column, which is legal and renders as the
 *  single-column grid it describes; an empty segment is an empty column, which
 *  is a gap someone wrote on purpose. */
export function parseColumnRegions(body: string): ColumnRegion[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const out: ColumnRegion[] = [];
  let fence: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (fence !== null) {
      if (fenceCloses(line, fence)) fence = null;
      i++;
      continue;
    }
    const opened = fenceOpening(line);
    if (opened !== null) {
      fence = opened;
      i++;
      continue;
    }
    if (!isColumnsOpen(line)) {
      i++;
      continue;
    }
    const region = scanRegion(lines, i);
    if (region) {
      out.push(region.region);
      i = region.region.endLine + 1;
      continue;
    }
    // not a region: step past this opener only, so a nested or later opener
    // still gets its own chance to be one
    i++;
  }
  return out;
}

/** Read one region starting at an opener, or null when it never closes. The
    fence state is re-tracked from the opener because a fence opened INSIDE the
    region hides markers the same way one outside it does. */
function scanRegion(lines: string[], open: number): { region: ColumnRegion } | null {
  const cuts: number[] = [];
  let fence: string | null = null;
  for (let i = open + 1; i < lines.length; i++) {
    const line = lines[i];
    if (fence !== null) {
      if (fenceCloses(line, fence)) fence = null;
      continue;
    }
    const opened = fenceOpening(line);
    if (opened !== null) {
      fence = opened;
      continue;
    }
    // columns do not nest — an opener in here means the outer one was never
    // closed, and the honest reading is that this is where a region begins
    if (isColumnsOpen(line)) return null;
    if (isColumnsDivider(line)) {
      cuts.push(i);
      continue;
    }
    if (!isColumnsClose(line)) continue;
    const bounds = [open, ...cuts, i];
    const columns: ColumnPart[] = [];
    for (let c = 0; c < bounds.length - 1; c++) {
      const startLine = bounds[c] + 1;
      const endLine = bounds[c + 1];
      columns.push({ startLine, endLine, text: lines.slice(startLine, endLine).join("\n") });
    }
    return { region: { startLine: open, endLine: i, columns } };
  }
  return null;
}
